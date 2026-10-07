// Scheduled Background Function (see [functions."scheduled-analyst-price-
// target-background"] in netlify.toml) for the Analyst Price Target Upside
// page: sell-side 12-month price targets and buy/hold/sell ratings across
// the S&P 500.
//
// Makes no Alpha Vantage calls. Targets, ratings and share counts come from
// the shared overview collection (refreshed monthly), prices from Yahoo, and
// trailing relative returns from the Relative Strength page's weekly data.
// Upside is today's price against the target in the latest collection.
//
// Besides each stock's upside, it builds:
//   - a bottom-up S&P 500 target: every member's target times its shares,
//     against its price times its shares, the index-level upside analysts'
//     targets add up to
//   - upside by company size and by 12-1 month momentum, in fifths
//   - a monthly per-stock snapshot of price and target, so later runs can
//     check whether high-upside stocks went on to beat low-upside ones. No
//     earlier targets are available, so that test starts with the first
//     snapshot and fills in as months pass.

const { getPriceTargetStore, LATEST_KEY, HISTORY_KEY } = require("./analyst-price-target-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { loadCollected } = require("./av-collector-store");
const { fetchQuotes, fetchDailyHistory, sleep } = require("./yahoo-client");

const MAX_HISTORY_POINTS = 260;
const MIN_ANALYSTS_FOR_LEADERBOARD = 3; // thin coverage makes upside/consensus noisy
const SNAPSHOT_KEY = (month) => `snapshots/${month}.json`;
const SNAPSHOT_INDEX_KEY = "snapshots/index.json";
const DELIVERY_MONTHS = [3, 6, 12];
const PRICE_WORKERS = 4;

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function round(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
const mean = (a) => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
function quantile(values, q) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const median = (a) => quantile(a, 0.5);
function fifths(list, key) {
  const sorted = list.filter((c) => Number.isFinite(c[key])).sort((a, b) => a[key] - b[key]);
  return Array.from({ length: 5 }, (_, k) => sorted.slice(Math.floor((k * sorted.length) / 5), Math.floor(((k + 1) * sorted.length) / 5)));
}
const monthsBefore = (date, m) => { const d = new Date(date + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString().slice(0, 10); };

function parseOverview(symbol, p) {
  if (!p || !p.Symbol) return null;
  const strongBuy = num(p.AnalystRatingStrongBuy) || 0, buy = num(p.AnalystRatingBuy) || 0, hold = num(p.AnalystRatingHold) || 0;
  const sell = num(p.AnalystRatingSell) || 0, strongSell = num(p.AnalystRatingStrongSell) || 0;
  const analystTotal = strongBuy + buy + hold + sell + strongSell;
  return {
    sector: normalizeSector(symbol, p.Sector),
    name: p.Name || symbol,
    targetPrice: num(p.AnalystTargetPrice),
    shares: num(p.SharesOutstanding),
    analystTotal,
    buyRatio: analystTotal > 0 ? ((strongBuy + buy) / analystTotal) * 100 : null,
    consensusScore: analystTotal > 0 ? (strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell) / analystTotal : null,
  };
}

// For every stored snapshot old enough, each upside fifth's average return
// over the following 3, 6 and 12 months against the S&P 500, next to the
// upside its targets implied.
async function deliveryTest(store, today) {
  const index = (await store.get(SNAPSHOT_INDEX_KEY, { type: "json" })) || { months: [] };
  const due = index.months.filter((m) => monthsBefore(today, DELIVERY_MONTHS[0]) >= m.date);
  const out = { snapshots: index.months.length, firstSnapshot: index.months.length ? index.months[0].date : null, horizons: {} };
  if (!due.length) return out;
  const snaps = [];
  for (const m of due) { const s = await store.get(SNAPSHOT_KEY(m.date.slice(0, 7)), { type: "json" }); if (s) snaps.push(s); }
  const symbols = [...new Set(snaps.flatMap((s) => Object.keys(s.rows)))];
  const since = Math.floor(Date.parse(snaps[0].date + "T00:00:00Z") / 1000) - 10 * 86400;
  const prices = new Map();
  const queue = symbols.concat(["^SP500TR"]);
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try { prices.set(t, await fetchDailyHistory(t, { adjusted: true, sinceUnix: since })); } catch (err) { /* left out */ }
      await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: PRICE_WORKERS }, worker));
  const closeOn = (rows, date) => { let best = null; for (const r of rows || []) { if (r.date <= date) best = r; else break; } return best ? best.close : null; };
  for (const h of DELIVERY_MONTHS) {
    const groups = Array.from({ length: 5 }, () => ({ implied: [], realized: [] }));
    let used = 0;
    for (const s of snaps) {
      const end = new Date(s.date + "T00:00:00Z"); end.setUTCMonth(end.getUTCMonth() + h);
      const endDate = end.toISOString().slice(0, 10);
      if (endDate > today) continue;
      const idx0 = closeOn(prices.get("^SP500TR"), s.date), idx1 = closeOn(prices.get("^SP500TR"), endDate);
      if (!idx0 || !idx1) continue;
      const rows = Object.entries(s.rows).map(([sym, [price, target]]) => ({ sym, upside: target / price - 1 })).filter((r) => Number.isFinite(r.upside));
      fifths(rows, "upside").forEach((list, k) => {
        for (const r of list) {
          const a = closeOn(prices.get(r.sym), s.date), b = closeOn(prices.get(r.sym), endDate);
          if (!a || !b) continue;
          groups[k].implied.push(r.upside);
          groups[k].realized.push(b / a / (idx1 / idx0) - 1);
        }
      });
      used++;
    }
    if (!used) continue;
    out.horizons[h] = { snapshots: used, fifths: groups.map((g, k) => ({ fifth: k + 1, stocks: g.realized.length, impliedUpsidePct: round(mean(g.implied) * 100), relReturnPct: round(mean(g.realized) * 100) })) };
  }
  return out;
}

exports.handler = async () => {
  const started = Date.now();
  try {
    const overviewPub = await loadCollected("overview");
    const targetsDate = overviewPub.generated_at_utc.slice(0, 10);

    let rs = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      for (const c of (rsLatest && rsLatest.companies) || []) rs[c.symbol] = c;
    } catch (err) {
      console.error(`scheduled-analyst-price-target-background: relative-strength blob unavailable (${err.message})`);
    }
    let quotes = new Map();
    try { quotes = await fetchQuotes(BREADTH_CONSTITUENTS.concat(["^GSPC"])); } catch (err) { console.error(`scheduled-analyst-price-target-background: quotes failed (${err.message})`); }

    const companies = [];
    for (const symbol of BREADTH_CONSTITUENTS) {
      const o = parseOverview(symbol, overviewPub.data[symbol]);
      if (!o || !o.sector || o.targetPrice === null) continue;
      const q = quotes.get(symbol);
      const price = q ? q.price : rs[symbol] ? rs[symbol].price : null;
      companies.push({
        symbol,
        name: o.name,
        sector: o.sector,
        targetPrice: round(o.targetPrice),
        price: round(price),
        upsidePct: price ? round(((o.targetPrice - price) / price) * 100) : null,
        analystTotal: o.analystTotal,
        buyRatio: round(o.buyRatio, 1),
        consensusScore: round(o.consensusScore),
        relPrice3M: rs[symbol] && Number.isFinite(rs[symbol].rel3M) ? rs[symbol].rel3M : null,
        rel12_1M: rs[symbol] && Number.isFinite(rs[symbol].rel12_1M) ? rs[symbol].rel12_1M : null,
        _shares: o.shares,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with both a target price and sector");
    const priced = companies.filter((c) => c.upsidePct !== null);

    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      const capped = inSector.filter((c) => c._shares && c.price);
      return {
        sector,
        companyCount: inSector.length,
        medianUpsidePct: round(median(inSector.map((c) => c.upsidePct))),
        medianBuyRatio: round(median(inSector.map((c) => c.buyRatio)), 1),
        medianConsensusScore: round(median(inSector.map((c) => c.consensusScore))),
        impliedUpsidePct: capped.length ? round((capped.reduce((s, c) => s + c._shares * c.targetPrice, 0) / capped.reduce((s, c) => s + c._shares * c.price, 0) - 1) * 100) : null,
      };
    }).filter(Boolean);

    // ---- bottom-up S&P 500 target ----------------------------------------
    const capped = priced.filter((c) => c._shares);
    const impliedUpside = capped.reduce((s, c) => s + c._shares * c.targetPrice, 0) / capped.reduce((s, c) => s + c._shares * c.price, 0) - 1;
    const spx = quotes.get("^GSPC") ? quotes.get("^GSPC").price : null;
    const implied = {
      companies: capped.length,
      upsidePct: round(impliedUpside * 100),
      indexLevel: spx ? round(spx) : null,
      targetLevel: spx ? Math.round(spx * (1 + impliedUpside)) : null,
    };

    // ---- size and momentum -------------------------------------------------
    for (const c of capped) c._cap = c._shares * c.price;
    const fifthStats = (groups, key) => groups.map((list, k) => ({
      fifth: k + 1, companies: list.length,
      minValue: list.length ? round(list[0][key], key === "_cap" ? -6 : 1) : null,
      maxValue: list.length ? round(list[list.length - 1][key], key === "_cap" ? -6 : 1) : null,
      medianUpsidePct: round(median(list.map((c) => c.upsidePct))),
      medianBuyRatio: round(median(list.map((c) => c.buyRatio)), 1),
    }));
    const bySize = fifthStats(fifths(capped, "_cap"), "_cap").map((f) => ({ ...f, minCapBn: f.minValue === null ? null : round(f.minValue / 1e9, 1), maxCapBn: f.maxValue === null ? null : round(f.maxValue / 1e9, 1), minValue: undefined, maxValue: undefined }));
    const byMomentum = fifthStats(fifths(priced, "rel12_1M"), "rel12_1M");

    // ---- leaderboards (unchanged rules) -----------------------------------
    const eligible = priced.filter((c) => c.analystTotal >= MIN_ANALYSTS_FOR_LEADERBOARD);
    const strip = ({ _shares, _cap, ...c }) => c;
    const highestUpside = [...eligible].sort((a, b) => b.upsidePct - a.upsidePct).slice(0, 15).map(strip);
    const lowestUpside = [...eligible].sort((a, b) => a.upsidePct - b.upsidePct).slice(0, 15).map(strip);
    const eligibleConsensus = companies.filter((c) => c.analystTotal >= MIN_ANALYSTS_FOR_LEADERBOARD && c.buyRatio !== null);
    const mostBullish = [...eligibleConsensus].sort((a, b) => b.buyRatio - a.buyRatio).slice(0, 15).map(strip);
    const mostBearish = [...eligibleConsensus].sort((a, b) => a.buyRatio - b.buyRatio).slice(0, 15).map(strip);
    const withBoth = companies.filter((c) => c.upsidePct !== null && c.relPrice3M !== null);
    const scatterPairs = withBoth.map((c) => ({ x: c.upsidePct, y: c.relPrice3M, symbol: c.symbol }));

    const market = {
      companyCount: companies.length,
      withPriceData: withBoth.length,
      medianUpsidePct: round(median(companies.map((c) => c.upsidePct))),
      medianBuyRatio: round(median(companies.map((c) => c.buyRatio)), 1),
      medianConsensusScore: round(median(companies.map((c) => c.consensusScore))),
      totalAnalystsCovering: companies.reduce((s, c) => s + (c.analystTotal || 0), 0),
    };

    // ---- monthly snapshot and the delivery test ---------------------------
    const store = getPriceTargetStore();
    const today = new Date().toISOString().slice(0, 10);
    const month = targetsDate.slice(0, 7);
    const snapIndex = (await store.get(SNAPSHOT_INDEX_KEY, { type: "json" })) || { months: [] };
    // One snapshot per overview collection: the targets only change when it
    // refreshes, and the price is the first one seen after it.
    if (!snapIndex.months.some((m) => m.date.slice(0, 7) === month)) {
      const rows = Object.fromEntries(priced.map((c) => [c.symbol, [c.price, c.targetPrice]]));
      await store.setJSON(SNAPSHOT_KEY(month), { date: today, targetsDate, rows });
      snapIndex.months.push({ date: today, targetsDate, stocks: priced.length });
      await store.setJSON(SNAPSHOT_INDEX_KEY, snapIndex);
    }
    const delivery = await deliveryTest(store, today);

    const latest = {
      generated_at_utc: new Date().toISOString(),
      targetsDate,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: companies.length,
      hasPriceData: priced.length > 0,
      market,
      implied,
      sectors,
      bySize,
      byMomentum,
      delivery,
      highestUpside,
      lowestUpside,
      mostBullish,
      mostBearish,
      scatterPairs,
      companies: companies.map(strip),
    };
    await store.setJSON(LATEST_KEY, latest);

    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = (Array.isArray(history.points) ? history.points : []).filter((p) => p.date !== today);
    points.push({
      date: today,
      medianUpsidePct: market.medianUpsidePct,
      medianBuyRatio: market.medianBuyRatio,
      impliedUpsidePct: implied.upsidePct,
      p25UpsidePct: round(quantile(companies.map((c) => c.upsidePct), 0.25)),
      p75UpsidePct: round(quantile(companies.map((c) => c.upsidePct), 0.75)),
      p25BuyRatio: round(quantile(companies.map((c) => c.buyRatio), 0.25), 1),
      p75BuyRatio: round(quantile(companies.map((c) => c.buyRatio), 0.75), 1),
    });
    await store.setJSON(HISTORY_KEY, { points: points.slice(-MAX_HISTORY_POINTS) });

    console.log(`scheduled-analyst-price-target-background: ${companies.length} companies, implied S&P 500 upside ${implied.upsidePct}%, ${delivery.snapshots} snapshots, ${Math.round((Date.now() - started) / 1000)}s`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`scheduled-analyst-price-target-background: FAILED: ${err.message}`);
    return { statusCode: 502 };
  }
};
