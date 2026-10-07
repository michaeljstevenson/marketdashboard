// Scheduled Background Function (see [functions."scheduled-earnings-growth-
// divergence-background"] in netlify.toml) for /earnings-growth-divergence.
// html: how much of each S&P 500 stock's, sector's and the index's return
// over the last 1, 3 and 5 years came from earnings growth, from a change in
// the P/E multiple, and from dividends.
//
// Price return splits exactly into the two pieces in logs:
//   ln(1 + price return) = ln(1 + EPS growth) + ln(1 + P/E change)
// and total return adds the dividends on top. Annualizing divides each log
// piece by the years, so the pieces add up to the annualized return.
//
// EPS is trailing four-quarter reported EPS from the shared earnings
// collection as known at each date (ttm-eps.js), price is Yahoo's
// split-adjusted close and total return its adjusted close. A stock with a
// loss at either end has no meaningful EPS growth or P/E, so it's left out of
// the stock-level split (and counted). Sector and index figures add up
// earnings and market value across today's members at today's share counts,
// so they include those stocks, losses and all.
//
// Also measures how well EPS growth lines up with returns across stocks at
// each horizon (rank correlation and R-squared on the log pieces), which
// tends to rise with the horizon. No Alpha Vantage calls.

const { getEarningsGrowthStore, SPLIT_KEY } = require("./earnings-growth-divergence-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { loadCollected } = require("./av-collector-store");
const { fetchDailyCloses, sleep } = require("./yahoo-client");
const { quartersFrom, ttmEpsOn } = require("./ttm-eps");

const HORIZONS = [1, 3, 5];
const PRICE_WORKERS = 4;
const TABLE_SIZE = 15;
const TOTAL = "S&P 500";

function num(v) {
  if (v === null || v === undefined || v === "" || v === "None") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
// Annualized log piece back to a percent rate.
const annPct = (logPiece, years) => (Number.isFinite(logPiece) ? round((Math.exp(logPiece / years) - 1) * 100, 2) : null);
const mean = (a) => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
function median(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function pearson(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}
function ranks(a) {
  const idx = a.map((v, i) => i).sort((x, y) => a[x] - a[y]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++; for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
}

// Row on or before `date` within 7 days, from ascending rows.
function rowOn(rows, date) {
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].date <= date) { best = rows[m]; lo = m + 1; } else hi = m - 1;
  }
  return best && (Date.parse(date) - Date.parse(best.date)) / 86400000 <= 7 ? best : null;
}
const yearsBefore = (date, y) => { const d = new Date(date + "T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };

async function loadPrices(symbols, sinceUnix) {
  const out = new Map();
  const queue = [...symbols];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try { out.set(t, await fetchDailyCloses(t, { sinceUnix })); } catch (err) { /* priced out */ }
      await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: PRICE_WORKERS }, worker));
  return out;
}

// Aggregate split for a group at constant (today's) share counts.
function groupSplit(stocks, start, end, years) {
  let cap0 = 0, cap1 = 0, e0 = 0, e1 = 0, tr = 0, n = 0;
  for (const s of stocks) {
    const a = s.points[start], b = s.points[end];
    if (!a || !b || !Number.isFinite(a.eps) || !Number.isFinite(b.eps)) continue;
    cap0 += s.shares * a.close; cap1 += s.shares * b.close;
    e0 += s.shares * a.eps; e1 += s.shares * b.eps;
    tr += s.shares * a.close * (b.adj / a.adj);
    n++;
  }
  if (!n || e0 <= 0 || e1 <= 0) return { n, priceReturnPct: n ? annPct(Math.log(cap1 / cap0), years) : null, epsGrowthPct: null, peChangePct: null, dividendsPct: null, totalReturnPct: null, pe0: null, pe1: null };
  const lp = Math.log(cap1 / cap0), lg = Math.log(e1 / e0), lt = Math.log(tr / cap0);
  return {
    n,
    totalReturnPct: annPct(lt, years),
    priceReturnPct: annPct(lp, years),
    epsGrowthPct: annPct(lg, years),
    peChangePct: annPct(lp - lg, years),
    dividendsPct: annPct(lt - lp, years),
    pe0: round(cap0 / e0, 1), pe1: round(cap1 / e1, 1),
  };
}

exports.handler = async () => {
  const started = Date.now();
  try {
    const earningsPub = await loadCollected("earnings");
    const overview = (await loadCollected("overview")).data;
    const meta = ((await getBeeswarmStore().get(META_KEY, { type: "json" })) || {}).tickers || {};

    const spy = await fetchDailyCloses("SPY", { sinceUnix: Math.floor(Date.parse(yearsBefore(new Date().toISOString().slice(0, 10), 5) + "T00:00:00Z") / 1000) - 30 * 86400 });
    const asOf = spy[spy.length - 1].date;
    const dates = { 0: asOf };
    for (const y of HORIZONS) dates[y] = rowOn(spy, yearsBefore(asOf, y)).date;
    const sinceUnix = Math.floor(Date.parse(dates[5] + "T00:00:00Z") / 1000) - 10 * 86400;
    const prices = await loadPrices(BREADTH_CONSTITUENTS, sinceUnix);

    const stocks = [];
    for (const symbol of BREADTH_CONSTITUENTS) {
      const rows = prices.get(symbol);
      const shares = overview[symbol] ? num(overview[symbol].SharesOutstanding) : null;
      if (!rows || !shares) continue;
      const quarters = quartersFrom(earningsPub.data[symbol]);
      const points = {};
      for (const [k, date] of Object.entries(dates)) {
        const r = rowOn(rows, date);
        if (r) points[k] = { close: r.close, adj: r.adjClose, eps: ttmEpsOn(quarters, date) };
      }
      const m = meta[symbol] || {};
      stocks.push({ symbol, name: m.name || (overview[symbol] && overview[symbol].Name) || symbol, sector: m.sector || normalizeSector(symbol, overview[symbol] && overview[symbol].Sector), shares, points });
    }

    // ---- stock level -------------------------------------------------------
    const companies = stocks.map((s) => {
      const row = { symbol: s.symbol, name: s.name, sector: s.sector, pe: null };
      const now = s.points[0];
      if (now && now.eps > 0) row.pe = round(now.close / now.eps, 1);
      for (const y of HORIZONS) {
        const a = s.points[y], b = now;
        const h = {};
        if (a && b) {
          const lp = Math.log(b.close / a.close), lt = Math.log(b.adj / a.adj);
          h.totalReturnPct = annPct(lt, y);
          h.priceReturnPct = annPct(lp, y);
          h.dividendsPct = annPct(lt - lp, y);
          if (a.eps > 0 && b.eps > 0) {
            const lg = Math.log(b.eps / a.eps);
            h.epsGrowthPct = annPct(lg, y);
            h.peChangePct = annPct(lp - lg, y);
            h._lg = lg; h._lp = lp;
          }
        }
        row["y" + y] = h;
      }
      return row;
    });

    const fit = HORIZONS.map((y) => {
      const pairs = companies.map((c) => c["y" + y]).filter((h) => Number.isFinite(h._lg) && Number.isFinite(h._lp));
      if (pairs.length < 30) return { years: y, n: pairs.length };
      const xs = pairs.map((h) => h._lg), ys = pairs.map((h) => h._lp);
      const r = pearson(xs, ys);
      return {
        years: y, n: pairs.length,
        r2: round(r * r, 3), pearson: round(r, 3), spearman: round(pearson(ranks(xs), ranks(ys)), 3),
        // Median stock: how much of its annualized price move came from each piece.
        medianEpsGrowthPct: round(median(pairs.map((h) => (Math.exp(h._lg / y) - 1) * 100)), 2),
        medianPeChangePct: round(median(pairs.map((h) => (Math.exp((h._lp - h._lg) / y) - 1) * 100)), 2),
      };
    });
    for (const c of companies) for (const y of HORIZONS) { delete c["y" + y]._lg; delete c["y" + y]._lp; }
    const excluded = Object.fromEntries(HORIZONS.map((y) => [y, companies.filter((c) => c["y" + y].priceReturnPct !== undefined && c["y" + y].epsGrowthPct === undefined).length]));

    // ---- groups --------------------------------------------------------------
    const groups = [{ name: TOTAL, stocks }].concat(SECTOR_ORDER.map((s) => ({ name: s, stocks: stocks.filter((x) => x.sector === s) })).filter((g) => g.stocks.length));
    const breakdown = groups.map((g) => ({ name: g.name, members: g.stocks.length, ...Object.fromEntries(HORIZONS.map((y) => ["y" + y, groupSplit(g.stocks, String(y), "0", y)])) }));

    const three = companies.filter((c) => Number.isFinite(c.y3.peChangePct));
    const tables = {
      expansion: three.slice().sort((a, b) => b.y3.peChangePct - a.y3.peChangePct).slice(0, TABLE_SIZE),
      contraction: three.slice().sort((a, b) => a.y3.peChangePct - b.y3.peChangePct).slice(0, TABLE_SIZE),
    };

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOf,
      dates,
      horizons: HORIZONS,
      earningsDate: earningsPub.generated_at_utc.slice(0, 10),
      universeSize: BREADTH_CONSTITUENTS.length,
      priced: stocks.length,
      breakdown,
      fit,
      excluded,
      tables,
      companies,
    };
    await getEarningsGrowthStore().setJSON(SPLIT_KEY, payload);
    const t = breakdown[0];
    console.log(`scheduled-earnings-growth-divergence-background: ${stocks.length} priced, S&P 500 5y: price ${t.y5.priceReturnPct}% = EPS ${t.y5.epsGrowthPct}% + P/E ${t.y5.peChangePct}%, ${Math.round((Date.now() - started) / 1000)}s`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`scheduled-earnings-growth-divergence-background: FAILED: ${err.message}`);
    return { statusCode: 500 };
  }
};

module.exports.groupSplit = groupSplit;
