// Scheduled Background Function (see [functions."scheduled-valuations-
// background"] in netlify.toml): monthly S&P 500 valuation multiples for the
// Valuations page, which otherwise shows Damodaran's once-a-year table.
//
// Makes no Alpha Vantage calls. It reads the shared overview and earnings
// collections (both refreshed monthly just before this runs) and Yahoo
// prices:
//   - trailing P/E for the index, each sector and each industry: total market
//     value over total trailing four-quarter earnings, losses included, so a
//     group's multiple is what owning the whole group costs
//   - forward P/E, EV/EBITDA, price/book and price/sales the same way
//   - a rebuilt monthly history of trailing P/E over the last ten years
//
// Earnings are Alpha Vantage's reported EPS, the adjusted figure companies
// and analysts quote, which is split-adjusted like Yahoo's close. Market value
// per share class is shares outstanding times price, so dual-class companies
// (GOOG and GOOGL) add up correctly. The history uses today's members and
// today's share counts, so it shows how today's index would have been valued
// in the past, an approximation of the historical index. The forward-looking
// ratios and the company-level ones (EV/EBITDA, price/book, price/sales) come
// from the overview collection's own date.

const { getValuationsStore, LATEST_KEY, SNAPSHOTS_KEY } = require("./valuations-blob-store");
const { loadCollected } = require("./av-collector-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { fetchDailyHistory, sleep } = require("./yahoo-client");
const { quartersFrom, ttmEpsOn } = require("./ttm-eps");

const HISTORY_START = "2016-09-01";
const PRICE_WORKERS = 4;
const MIN_INDUSTRY_COMPANIES = 3;
const TOTAL = "S&P 500";

function num(v) {
  if (v === null || v === undefined || v === "" || v === "None" || v === "-") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const p = (v.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return v[lo] + (v[hi] - v[lo]) * (p - lo);
}
function percentileOf(values, x) {
  const v = values.filter(Number.isFinite);
  if (!v.length || !Number.isFinite(x)) return null;
  let below = 0, equal = 0;
  for (const y of v) { if (y < x) below++; else if (y === x) equal++; }
  return ((below + equal / 2) / v.length) * 100;
}
const ratio = (a, b) => (b > 0 && Number.isFinite(a) ? a / b : null);
const titleCase = (s) => String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bAnd\b/g, "and").replace(/\b(Reit|Reits|It)\b/g, (m) => m.toUpperCase());

async function loadPrices(symbols, sinceUnix) {
  const prices = new Map();
  const queue = [...symbols];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const rows = await fetchDailyHistory(t, { adjusted: false, sinceUnix });
        prices.set(t, rows);
      } catch (err) { /* priced out of every aggregate */ }
      await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: PRICE_WORKERS }, worker));
  return prices;
}

// Close on or before `date`, from ascending rows.
function closeOn(rows, date) {
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].date <= date) { best = rows[m]; lo = m + 1; } else hi = m - 1;
  }
  return best && (Date.parse(date) - Date.parse(best.date)) / 86400000 <= 7 ? best.close : null;
}

function aggregate(members) {
  const sum = (f) => members.reduce((s, m) => s + (Number.isFinite(f(m)) ? f(m) : 0), 0);
  const withEps = members.filter((m) => Number.isFinite(m.ttmEps) && Number.isFinite(m.cap));
  const withFwd = members.filter((m) => Number.isFinite(m.fwdEps) && Number.isFinite(m.cap));
  // Company-level figures repeat across share classes, so count each CIK once.
  const firms = [...new Map(members.filter((m) => m.cik).map((m) => [m.cik, m])).values()];
  const evFirms = firms.filter((f) => Number.isFinite(f.ev) && Number.isFinite(f.ebitda) && f.sector !== "Financials");
  const bookFirms = firms.filter((f) => Number.isFinite(f.companyCap) && Number.isFinite(f.book) && f.book > 0);
  const salesFirms = firms.filter((f) => Number.isFinite(f.companyCap) && Number.isFinite(f.revenue) && f.revenue > 0);
  const earnings = withEps.reduce((s, m) => s + m.shares * m.ttmEps, 0);
  return {
    members: members.length,
    companies: firms.length,
    marketCapBn: round(sum((m) => m.cap) / 1e9, 0),
    trailingPE: round(ratio(withEps.reduce((s, m) => s + m.cap, 0), earnings), 1),
    trailingCoverage: withEps.length,
    lossMakers: withEps.filter((m) => m.ttmEps < 0).length,
    forwardPE: round(ratio(withFwd.reduce((s, m) => s + m.cap, 0), withFwd.reduce((s, m) => s + m.shares * m.fwdEps, 0)), 1),
    forwardCoverage: withFwd.length,
    evEbitda: round(ratio(evFirms.reduce((s, f) => s + f.ev, 0), evFirms.reduce((s, f) => s + f.ebitda, 0)), 1),
    priceToBook: round(ratio(bookFirms.reduce((s, f) => s + f.companyCap, 0), bookFirms.reduce((s, f) => s + f.book, 0)), 2),
    priceToSales: round(ratio(salesFirms.reduce((s, f) => s + f.companyCap, 0), salesFirms.reduce((s, f) => s + f.revenue, 0)), 2),
  };
}

exports.handler = async () => {
  const started = Date.now();
  try {
    const overviewPub = await loadCollected("overview");
    const earningsPub = await loadCollected("earnings");
    const overview = overviewPub.data, earnings = earningsPub.data;
    const overviewDate = overviewPub.generated_at_utc.slice(0, 10);
    const meta = ((await getBeeswarmStore().get(META_KEY, { type: "json" })) || {}).tickers || {};

    const sinceUnix = Math.floor(Date.parse(HISTORY_START + "T00:00:00Z") / 1000);
    const spy = await fetchDailyHistory("SPY", { adjusted: false, sinceUnix });
    const asOf = spy[spy.length - 1].date;
    const monthEnds = [];
    for (let i = 0; i < spy.length; i++) {
      const next = spy[i + 1];
      if (!next || next.date.slice(0, 7) !== spy[i].date.slice(0, 7)) monthEnds.push(spy[i].date);
    }
    if (monthEnds[monthEnds.length - 1] !== asOf) monthEnds.push(asOf);
    else monthEnds[monthEnds.length - 1] = asOf;

    const prices = await loadPrices(BREADTH_CONSTITUENTS, sinceUnix);

    const stocks = [];
    for (const symbol of BREADTH_CONSTITUENTS) {
      const o = overview[symbol];
      const rows = prices.get(symbol);
      if (!o || !rows || !rows.length) continue;
      const shares = num(o.SharesOutstanding);
      if (!shares) continue;
      const quarters = quartersFrom(earnings[symbol]);
      const sector = (meta[symbol] && meta[symbol].sector) || normalizeSector(symbol, o.Sector);
      const priceAtOverview = closeOn(rows, overviewDate);
      const fpe = num(o.ForwardPE);
      const ebitda = num(o.EBITDA), evx = num(o.EVToEBITDA), pb = num(o.PriceToBookRatio), companyCap = num(o.MarketCapitalization);
      stocks.push({
        symbol, shares, sector, rows, quarters,
        industry: o.Industry ? titleCase(o.Industry) : null,
        cik: o.CIK || null,
        fwdEps: fpe && fpe > 0 && priceAtOverview ? priceAtOverview / fpe : null,
        companyCap,
        ebitda,
        ev: Number.isFinite(evx) && Number.isFinite(ebitda) ? evx * ebitda : null,
        book: Number.isFinite(pb) && pb > 0 && companyCap ? companyCap / pb : null,
        revenue: num(o.RevenueTTM),
      });
    }

    const valueOn = (date) => stocks.map((s) => {
      const price = closeOn(s.rows, date);
      return { ...s, cap: price ? price * s.shares : null, ttmEps: price ? ttmEpsOn(s.quarters, date) : null };
    }).filter((s) => Number.isFinite(s.cap));

    // ---- this month ------------------------------------------------------
    const now = valueOn(asOf);
    const groups = (key) => {
      const out = {};
      for (const s of now) if (s[key]) (out[s[key]] = out[s[key]] || []).push(s);
      return out;
    };
    const total = { name: TOTAL, ...aggregate(now) };
    const bySector = groups("sector");
    const sectors = SECTOR_ORDER.filter((s) => bySector[s]).map((s) => ({ name: s, ...aggregate(bySector[s]) }));
    const byIndustry = groups("industry");
    const industries = Object.entries(byIndustry)
      .map(([name, list]) => {
        const sectorCount = {};
        for (const s of list) sectorCount[s.sector] = (sectorCount[s.sector] || 0) + 1;
        return { name, sector: Object.entries(sectorCount).sort((a, b) => b[1] - a[1])[0][0], ...aggregate(list) };
      })
      .filter((r) => r.companies >= MIN_INDUSTRY_COMPANIES)
      .sort((a, b) => (a.name < b.name ? -1 : 1));

    // ---- rebuilt history -------------------------------------------------
    const history = [];
    for (const date of monthEnds) {
      const members = valueOn(date);
      const point = { date, [TOTAL]: aggregate(members).trailingPE };
      for (const s of SECTOR_ORDER) {
        const list = members.filter((m) => m.sector === s);
        point[s] = list.length ? aggregate(list).trailingPE : null;
      }
      point.coverage = members.filter((m) => Number.isFinite(m.ttmEps)).length;
      history.push(point);
    }
    const ranges = [TOTAL, ...SECTOR_ORDER].map((name) => {
      const v = history.map((h) => h[name]).filter((x) => Number.isFinite(x) && x > 0);
      const current = history[history.length - 1][name];
      return {
        name,
        min: round(Math.min(...v), 1), p25: round(quantile(v, 0.25), 1), median: round(quantile(v, 0.5), 1),
        p75: round(quantile(v, 0.75), 1), max: round(Math.max(...v), 1),
        current, percentile: round(percentileOf(v, current), 0),
      };
    });

    const store = getValuationsStore();
    const snapshots = (await store.get(SNAPSHOTS_KEY, { type: "json" })) || [];
    const month = asOf.slice(0, 7);
    const kept = snapshots.filter((s) => s.date.slice(0, 7) !== month);
    kept.push({ date: asOf, total, sectors: sectors.map((s) => ({ name: s.name, trailingPE: s.trailingPE, forwardPE: s.forwardPE, evEbitda: s.evEbitda, priceToBook: s.priceToBook })) });
    await store.setJSON(SNAPSHOTS_KEY, kept);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOf,
      overviewDate,
      earningsDate: earningsPub.generated_at_utc.slice(0, 10),
      universeSize: BREADTH_CONSTITUENTS.length,
      priced: now.length,
      total,
      sectors,
      industries,
      history,
      historyStart: history[0].date,
      ranges,
      snapshots: kept,
    };
    await store.setJSON(LATEST_KEY, payload);
    console.log(`scheduled-valuations-background: ${asOf}, ${now.length} priced, S&P 500 trailing P/E ${total.trailingPE}, forward ${total.forwardPE}, ${industries.length} industries, ${Math.round((Date.now() - started) / 1000)}s`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`scheduled-valuations-background: FAILED: ${err.message}`);
    return { statusCode: 500 };
  }
};

module.exports.aggregate = aggregate;
