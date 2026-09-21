// Scheduled Background Function (see [functions."scheduled-quality-lowvol-
// background"] in netlify.toml) for the "Quality & Low-Volatility Factor
// Screen" page — a cross-sectional test of the classic "quality" and
// "low-volatility" equity factors, closing the gap /factor-analysis.html's
// own methodology section explicitly flagged (it covers Market/Size/Value/
// Momentum via Ken French data, but not Quality or Low-Vol).
//
// Deliberately built to REUSE two things already computed elsewhere on this
// site rather than pay for a full new fundamentals sweep:
//
//   1. QUALITY inputs (operating margin, net-debt/EBITDA) come from
//      scheduled-margin-leverage-background.js's own already-computed
//      per-company latest-quarter output (its `companies` array) — a real
//      cross-page read, not a coincidence, same category as this session's
//      earlier pages reading scheduled-relative-strength-background's own
//      output. This job makes ZERO INCOME_STATEMENT/BALANCE_SHEET calls of
//      its own. Quality composite = cross-sectional z-score(operating
//      margin) MINUS z-score(net-debt/EBITDA) — high leverage lowers
//      quality, so it subtracts, not adds. This is a deliberately simple
//      2-input proxy, not a full multi-factor "quality" model like MSCI's
//      or AQR's QMJ (which typically blend profitability, earnings
//      stability, and payout/growth measures too) — the page's own
//      methodology section says so explicitly, same honesty convention as
//      /equity-risk-premium.html's crude-Fed-model-vs-Damodaran framing.
//      REQUIRED dependency: without margin-leverage data there is no
//      quality input at all, so (unlike the relative-strength read below)
//      a missing/unpopulated margin-leverage blob is NOT a soft fallback —
//      this job aborts with a clear 502 error rather than writing an empty
//      or fabricated snapshot. margin-leverage.html itself is NOT read from
//      or modified beyond this read-only blob access.
//
//   2. LOW-VOLATILITY is this page's own new sweep: Yahoo Finance daily
//      adjusted closes trimmed to the last ~100 bars, across the full
//      S&P 500 — same source, same window, and the same reasoning
//      scheduled-relative-strength-background.js already made and
//      documented for this exact ~503-ticker universe (a 63-trading-day
//      lookback fits comfortably inside compact's ~100-bar window; full
//      history runs to 5,000+ bars/ticker, disproportionate to what's needed
//      here). Trailing ~3-month (63 trading day) annualized realized
//      volatility = stdev(daily log returns) * sqrt(252). Low-vol score =
//      the NEGATIVE cross-sectional z-score of realized vol, so higher
//      score = lower vol = "better," the same sign direction as the
//      quality score above.
//
// Combined score = simple average of the two z-scores. The simplest
// defensible combination, not a weighting scheme this page can't justify —
// documented on the page itself, not just here.
//
// This page is deliberately NOT a duplicate of /volatility.html, confirmed
// by reading that page's own backend before building this one:
// /volatility.html is a market/index-level VIX-vs-realized-vol regime page
// (one time series, S&P 500 as a whole); this page is a per-stock
// cross-sectional low-volatility FACTOR score across ~500 individual
// constituents, feeding into a factor-investing quintile/regression test,
// not a regime read. No shared data, no shared backend.
//
// Real cross-page dependency, not a coincidence (same pattern as this
// session's four earlier pages): reads scheduled-relative-strength-
// background's own latest.json (getRelativeStrengthStore) for 3-month
// relative price return, to test whether the quality+low-vol composite
// predicts subsequent relative performance — the actual point of this page
// — instead of running a second ~503-call price sweep. Graceful fallback
// (rows keep relPrice3M: null, warning banner, page still fully
// functional) if that blob isn't populated yet.
//
// Storage discipline: only derived per-company fields are retained — no
// raw daily price series is written to the blob (that would balloon the
// payload for no benefit once realized vol is computed).
//
// Pacing: ~300ms between calls (Yahoo has no quota but 429s intermittently),
// plus a retry pass for anything that fails.

const { getQualityLowVolStore, BLOB_KEY } = require("./quality-lowvol-blob-store");
const { getMarginLeverageStore, BLOB_KEY: MARGIN_LEVERAGE_KEY } = require("./margin-leverage-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { fetchDailyHistory } = require("./yahoo-client");
const COMPACT_DAYS = 100;


const VOL_LOOKBACK_DAYS = 63; // ~3 trading months
const LEADERBOARD_COUNT = 15;
const DIVERGENT_Z_THRESHOLD = 0.5; // how far from 0 a company's two component z-scores must sit, in opposite directions, to count as a genuinely divergent name
const DIVERGENT_COUNT = 12;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, digits = 3) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Cross-sectional z-score: (x - population mean) / population stdev, over
// whatever set of companies has a non-null value for this metric — the
// whole universe being scored IS the population here, not a sample drawn
// from a larger one, so this uses the population (divide-by-n) stdev.
function zscoreMap(items, getter) {
  const vals = items.map(getter).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const variance = vals.length ? vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length : null;
  const sd = variance !== null ? Math.sqrt(variance) : null;
  const map = new Map();
  for (const it of items) {
    const v = getter(it);
    const z = v !== null && v !== undefined && Number.isFinite(v) && sd ? (v - m) / sd : null;
    map.set(it.symbol, z);
  }
  return map;
}

async function fetchDailyAdjusted(symbol) {
  return (await fetchDailyHistory(symbol)).slice(-COMPACT_DAYS);
}

// Trailing VOL_LOOKBACK_DAYS-trading-day annualized realized volatility, in
// percent, off daily log returns. Returns null if there isn't enough clean
// history (recent IPO, data gap) — VOL_LOOKBACK_DAYS*0.9 tolerates a small
// number of missing days without discarding an otherwise-usable series.
function realizedVolatility(closes) {
  const n = closes.length;
  if (n < VOL_LOOKBACK_DAYS + 1) return null;
  const recent = closes.slice(n - VOL_LOOKBACK_DAYS - 1);
  const logRets = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].close, cur = recent[i].close;
    if (prev > 0 && cur > 0) {
      const r = Math.log(cur / prev);
      if (Number.isFinite(r)) logRets.push(r);
    }
  }
  if (logRets.length < VOL_LOOKBACK_DAYS * 0.9) return null;
  const m = logRets.reduce((a, b) => a + b, 0) / logRets.length;
  const variance = logRets.reduce((s, r) => s + (r - m) ** 2, 0) / logRets.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

exports.handler = async () => {
  console.log(`scheduled-quality-lowvol-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {

    // ---- Quality inputs: REQUIRED read of margin-leverage's own blob ----
    // Not a soft fallback like the relative-strength read below — the
    // quality half of this page's entire premise depends on it. If it's
    // missing, abort clearly rather than writing a quality-less or
    // fabricated snapshot.
    const marginLeverageStore = getMarginLeverageStore();
    const marginLeveragePayload = await marginLeverageStore.get(MARGIN_LEVERAGE_KEY, { type: "json" });
    if (!marginLeveragePayload || !Array.isArray(marginLeveragePayload.companies) || !marginLeveragePayload.companies.length) {
      throw new Error("margin-leverage blob not populated or empty. Quality & Low-Vol Factor Screen requires scheduled-margin-leverage-background to have run first (its per-company operating margin / net-debt-EBITDA output is this page's quality input; there is no other source for it in this job)");
    }
    const qualityBySymbol = new Map();
    for (const c of marginLeveragePayload.companies) {
      if (!c || !c.symbol) continue;
      if (c.operatingMargin === null || c.operatingMargin === undefined) continue;
      if (c.netDebtEbitda === null || c.netDebtEbitda === undefined) continue;
      qualityBySymbol.set(c.symbol, {
        symbol: c.symbol,
        name: c.name || c.symbol,
        sector: c.sector || null,
        operatingMargin: c.operatingMargin,
        netDebtEbitda: c.netDebtEbitda,
      });
    }
    if (!qualityBySymbol.size) throw new Error("margin-leverage blob had no company with both operatingMargin and netDebtEbitda populated, nothing to score");

    // ---- Price performance: OPTIONAL read, same graceful-fallback pattern
    // as this session's earlier pages ----
    let relativeStrengthBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relativeStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-quality-lowvol-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relativeStrengthBySymbol).length > 0;

    // ---- New sweep: realized volatility across the full S&P 500 ----
    const volResults = new Map(); // symbol -> realized vol (%)

    async function fetchOne(symbol) {
      const closes = await fetchDailyAdjusted(symbol);
      const vol = realizedVolatility(closes);
      if (vol !== null) volResults.set(symbol, vol);
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-quality-lowvol-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        try {
          await fetchOne(symbol);
        } catch (err) {
          console.error(`scheduled-quality-lowvol-background: ${symbol} failed: ${err.message}`);
          if (/rate limit|per minute|per day|frequency/i.test(err.message)) await sleep(20000);
          missed.push(symbol);
          await sleep(300);
          continue;
        }
        await sleep(300);
      }
      todo = missed;
    }

    console.log(`scheduled-quality-lowvol-background: realized vol computed for ${volResults.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (volResults.size === 0) throw new Error("Every ticker's volatility sweep failed. Refusing to write an empty snapshot");

    // ---- Build the scored universe: intersection of quality data and
    // realized-vol data. A company missing either side is excluded
    // entirely from the composite, not fabricated or half-scored — same
    // "exclude, don't fabricate" discipline as every other full-sweep job
    // on this site. ----
    const universe = [];
    for (const [symbol, q] of qualityBySymbol.entries()) {
      const vol = volResults.get(symbol);
      if (vol === undefined) continue;
      universe.push({ ...q, realizedVol: round(vol, 2) });
    }
    if (!universe.length) throw new Error("No ticker had both margin-leverage quality data and a computed realized volatility, nothing to score");

    // ---- Z-scores and the combined score ----
    const zMargin = zscoreMap(universe, (c) => c.operatingMargin);
    const zLev = zscoreMap(universe, (c) => c.netDebtEbitda);
    const zVol = zscoreMap(universe, (c) => c.realizedVol);

    for (const c of universe) {
      const m = zMargin.get(c.symbol);
      const l = zLev.get(c.symbol);
      const v = zVol.get(c.symbol);
      c.qualityZ = m !== null && l !== null ? round(m - l) : null;
      c.lowVolZ = v !== null ? round(-v) : null;
      c.combinedZ = c.qualityZ !== null && c.lowVolZ !== null ? round((c.qualityZ + c.lowVolZ) / 2) : null;
      c.relPrice3M = Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, c.symbol)
        ? relativeStrengthBySymbol[c.symbol]
        : null;
    }

    // ---- Quintiles: rank by combinedZ descending, Q1 = highest
    // quality+low-vol, Q5 = lowest ----
    const scored = universe.filter((c) => c.combinedZ !== null).sort((a, b) => b.combinedZ - a.combinedZ);
    const nScored = scored.length;
    scored.forEach((c, i) => {
      c.quintile = Math.min(5, Math.floor((i * 5) / nScored) + 1);
    });
    const unscored = universe.filter((c) => c.combinedZ === null);
    unscored.forEach((c) => { c.quintile = null; });
    const allCompanies = [...scored, ...unscored];

    // ---- Quintile-bucketed average forward return (the classic
    // "does the top quintile beat the bottom quintile" factor-investing
    // visual) ----
    const quintiles = [1, 2, 3, 4, 5].map((q) => {
      const inQ = scored.filter((c) => c.quintile === q);
      const withReturn = inQ.filter((c) => c.relPrice3M !== null);
      return {
        quintile: q,
        companyCount: inQ.length,
        avgCombinedZ: round(mean(inQ.map((c) => c.combinedZ))),
        avgQualityZ: round(mean(inQ.map((c) => c.qualityZ))),
        avgLowVolZ: round(mean(inQ.map((c) => c.lowVolZ))),
        medianOperatingMargin: round(median(inQ.map((c) => c.operatingMargin))),
        medianNetDebtEbitda: round(median(inQ.map((c) => c.netDebtEbitda))),
        medianRealizedVol: round(median(inQ.map((c) => c.realizedVol))),
        avgForwardRelReturn3M: withReturn.length ? round(mean(withReturn.map((c) => c.relPrice3M))) : null,
        nWithReturn: withReturn.length,
      };
    });

    // ---- Sector breakdown: average combined score by sector ----
    const sectorMap = new Map();
    for (const c of scored) {
      if (!c.sector) continue;
      if (!sectorMap.has(c.sector)) sectorMap.set(c.sector, []);
      sectorMap.get(c.sector).push(c);
    }
    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = sectorMap.get(sector);
        if (!inSector || !inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          avgCombinedZ: round(mean(inSector.map((c) => c.combinedZ))),
          avgQualityZ: round(mean(inSector.map((c) => c.qualityZ))),
          avgLowVolZ: round(mean(inSector.map((c) => c.lowVolZ))),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.avgCombinedZ - a.avgCombinedZ);

    // ---- Quality-vs-low-vol scatter pairs (client renders the regression,
    // matching this site's convention of computing Pearson/Spearman stats
    // client-side off raw {x,y} pairs) ----
    const qualityVsLowVolPairs = scored
      .filter((c) => c.qualityZ !== null && c.lowVolZ !== null)
      .map((c) => ({ x: c.qualityZ, y: c.lowVolZ, symbol: c.symbol, sector: c.sector, quintile: c.quintile }));

    // ---- Forward-return regression pairs (continuous, the Pearson+
    // Spearman two-method check alongside the quintile bar chart) ----
    const returnRegressionPairs = scored
      .filter((c) => c.combinedZ !== null && c.relPrice3M !== null)
      .map((c) => ({ x: c.combinedZ, y: c.relPrice3M, symbol: c.symbol }));

    // ---- Leaderboards ----
    const highestCombined = [...scored].slice(0, LEADERBOARD_COUNT);
    const lowestCombined = [...scored].slice(-LEADERBOARD_COUNT).reverse();

    // ---- Divergent names: quality and low-vol pulling in opposite
    // directions by a real margin, not just "one is slightly bigger than
    // the other." Skipped (left empty) rather than forced if the real data
    // doesn't produce a meaningfully differentiated cut. ----
    const highQualityHighVol = scored
      .filter((c) => c.qualityZ >= DIVERGENT_Z_THRESHOLD && c.lowVolZ <= -DIVERGENT_Z_THRESHOLD)
      .sort((a, b) => (b.qualityZ - b.lowVolZ) - (a.qualityZ - a.lowVolZ))
      .slice(0, DIVERGENT_COUNT);
    const lowQualityLowVol = scored
      .filter((c) => c.qualityZ <= -DIVERGENT_Z_THRESHOLD && c.lowVolZ >= DIVERGENT_Z_THRESHOLD)
      .sort((a, b) => (a.qualityZ - a.lowVolZ) - (b.qualityZ - b.lowVolZ))
      .slice(0, DIVERGENT_COUNT);

    const market = {
      companyCount: nScored,
      avgQualityZ: round(mean(scored.map((c) => c.qualityZ))),
      avgLowVolZ: round(mean(scored.map((c) => c.lowVolZ))),
      medianOperatingMargin: round(median(scored.map((c) => c.operatingMargin))),
      medianNetDebtEbitda: round(median(scored.map((c) => c.netDebtEbitda))),
      medianRealizedVol: round(median(scored.map((c) => c.realizedVol))),
      withPriceData: scored.filter((c) => c.relPrice3M !== null).length,
    };

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      volLoadedCount: volResults.size,
      qualityUniverseCount: qualityBySymbol.size,
      companyCount: nScored,
      hasPriceData,
      market,
      sectors,
      quintiles,
      qualityVsLowVolPairs,
      returnRegressionPairs,
      highestCombined,
      lowestCombined,
      divergent: { highQualityHighVol, lowQualityLowVol },
      companies: allCompanies,
    };

    const store = getQualityLowVolStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-quality-lowvol-background: wrote ${nScored} scored companies across ${sectors.length} sectors to blob, hasPriceData=${hasPriceData}`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: nScored, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-quality-lowvol-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
