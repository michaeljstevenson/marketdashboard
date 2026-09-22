// Scheduled Background Function (see [functions."scheduled-options-
// positioning-background"] in netlify.toml) for /options-positioning.html —
// the backlog's "Options Positioning" idea, previously left as a "coming
// soon" placeholder under Ownership & Flows with no obvious free data
// source. Alpha Vantage's HISTORICAL_PUT_CALL_RATIO turns out to cover it
// directly: one call per symbol returns that name's whole-option-chain
// put/call ratio as of the latest trading session (a single number, not a
// per-contract breakdown — HISTORICAL_VOLUME_OPEN_INTEREST_RATIO was
// considered too, but returns thousands of individual contract rows per
// symbol with no aggregate figure, disproportionate to what a cross-
// sectional positioning page needs, so it's left out).
//
// Sweeps the full S&P 500, one call per symbol (no date param — omitting it
// returns the latest session, per the endpoint's own behavior), a single-
// endpoint sweep like scheduled-fcf-yield-background.js. The endpoint
// itself is a current-state snapshot (not a queryable time series in one
// call the way CASH_FLOW's quarterlyReports is), so a market-median history
// accumulates one point per run — same "builds real history over
// successive runs" pattern as scheduled-pe-divergence-background.js and
// scheduled-earnings-revisions-background.js.
//
// Joins against scheduled-relative-strength-background.js's own latest.json
// (3-month relative return vs. SPY) for a contemporaneous cross-sectional
// test — same reuse pattern scheduled-earnings-growth-divergence-
// background.js uses, including its graceful fallback (rel3M: null, no
// crash) if that blob isn't populated.
//
// One-time snapshot, no recurring schedule — matches the convention this
// site settled into for every page added since 2026-09-16 (see this
// function's own entry in netlify.toml). ~503 sequential
// HISTORICAL_PUT_CALL_RATIO calls at 1050ms spacing plus a retry pass.

const { getOptionsPositioningStore, BLOB_KEY } = require("./options-positioning-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const NOTABLE_COUNT = 15;
const MAX_HISTORY_WEEKS = 104;
const MIN_SECTOR_N = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function num(v) {
  if (v === null || v === undefined || v === "None" || v === "" || v === "null") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

async function fetchPutCallRatio(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=HISTORICAL_PUT_CALL_RATIO&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    const msg = payload.Note || payload.Information || (payload.error && payload.error.message) || JSON.stringify(payload.error);
    throw new Error(msg);
  }
  const ratio = num(payload.put_call_ratio_full_chain);
  if (ratio === null) throw new Error(`no put_call_ratio_full_chain for ${symbol}`);
  return { ratio, date: payload.date };
}

// ---- Stats helpers — same methodology as /factor-analysis, duplicated
// here since every page on this site is self-contained. ----
function linearRegression(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const syy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const r2 = r * r;
  const dof = n - 2;
  const sse = ys.reduce((s, y, i) => s + (y - (intercept + slope * xs[i])) ** 2, 0);
  const seSlope = Math.sqrt(sse / dof / sxx);
  const t = slope / seSlope;
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { n, slope, intercept, r, r2, t, dof, p, sse };
}
function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function rankArray(arr) {
  const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && arr[idx[j + 1]] === arr[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}
function spearmanRegression(xs, ys) {
  return linearRegression(rankArray(xs), rankArray(ys));
}

exports.handler = async () => {
  console.log(`scheduled-options-positioning-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmMeta = await getBeeswarmStore().get(META_KEY, { type: "json" });
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};

    let relStrengthBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error(`scheduled-options-positioning-background: relative-strength blob unavailable (${err.message}), continuing without it`);
    }

    const results = new Map(); // symbol -> { ratio, date }

    async function fetchInto(symbol) {
      try {
        const r = await fetchPutCallRatio(apiKey, symbol);
        results.set(symbol, r);
        return true;
      } catch (err) {
        console.error(`scheduled-options-positioning-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-options-positioning-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(1050);
      }
      todo = missed;
    }

    console.log(`scheduled-options-positioning-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed. Refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, { ratio }] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const rel3M = Object.prototype.hasOwnProperty.call(relStrengthBySymbol, symbol) ? relStrengthBySymbol[symbol] : null;
      companies.push({ symbol, name: m.name || symbol, sector: m.sector, putCallRatio: ratio, rel3M });
    }
    if (!companies.length) throw new Error("No tickers resolved with a put/call ratio and sector metadata");

    // ---- Market + sector aggregates. Median, not mean — put/call ratio is
    // right-skewed (a handful of illiquid names print ratios of 3-4+), so a
    // mean would be dragged around by a small number of thin option chains. ----
    const market = {
      companyCount: companies.length,
      medianPutCallRatio: round(median(companies.map((c) => c.putCallRatio)), 3),
      meanPutCallRatio: round(mean(companies.map((c) => c.putCallRatio)), 3),
    };

    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (inSector.length < MIN_SECTOR_N) return null;
      return {
        sector,
        count: inSector.length,
        medianPutCallRatio: round(median(inSector.map((c) => c.putCallRatio)), 3),
      };
    }).filter(Boolean);

    // ---- Cross-sectional test: is bearish options positioning (a high
    // put/call ratio) concentrated in names that have already underperformed
    // over the trailing 3 months, or spread evenly across momentum deciles?
    // Pearson+Spearman, same two-method convention as every regression on
    // this site. ----
    const pairs = companies.filter((c) => c.rel3M !== null && c.rel3M !== undefined);
    const scatter = pairs.map((c) => ({ symbol: c.symbol, sector: c.sector, putCallRatio: c.putCallRatio, rel3M: c.rel3M }));
    let momentumTest = null;
    if (pairs.length >= 8) {
      const xs = pairs.map((c) => c.rel3M);
      const ys = pairs.map((c) => c.putCallRatio);
      const pearson = linearRegression(xs, ys);
      const spear = spearmanRegression(xs, ys);
      momentumTest = {
        pearson: { n: pearson.n, r: round(pearson.r, 3), r2: round(pearson.r2, 3), slope: round(pearson.slope, 4), t: round(pearson.t, 2), p: pearson.p },
        spearman: { n: spear.n, r: round(spear.r, 3), r2: round(spear.r2, 3), slope: round(spear.slope, 4), t: round(spear.t, 2), p: spear.p },
      };
    }

    // ---- Leaderboards ----
    const row = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, putCallRatio: c.putCallRatio, rel3M: c.rel3M });
    const mostBearish = [...companies].sort((a, b) => b.putCallRatio - a.putCallRatio).slice(0, NOTABLE_COUNT).map(row);
    const mostBullish = [...companies].sort((a, b) => a.putCallRatio - b.putCallRatio).slice(0, NOTABLE_COUNT).map(row);

    // ---- Weekly-accumulating market-median history — the endpoint is a
    // current-state snapshot, not a queryable time series, same pattern as
    // scheduled-pe-divergence-background.js. ----
    const previous = (await getOptionsPositioningStore().get(BLOB_KEY, { type: "json" })) || { history: [] };
    const history = Array.isArray(previous.history) ? previous.history : [];
    const weekKey = new Date().toISOString().slice(0, 10);
    const point = { week: weekKey, medianPutCallRatio: market.medianPutCallRatio, companyCount: market.companyCount };
    if (!history.length || history[history.length - 1].week !== weekKey) {
      history.push(point);
    } else {
      history[history.length - 1] = point;
    }
    while (history.length > MAX_HISTORY_WEEKS) history.shift();

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: companies.length,
      market,
      sectors,
      history,
      scatter,
      momentumTest,
      mostBearish,
      mostBullish,
      companies: companies.map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, putCallRatio: c.putCallRatio, rel3M: c.rel3M })),
    };

    await getOptionsPositioningStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-options-positioning-background: wrote ${companies.length} companies across ${sectors.length} sectors, ${history.length}-week history`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-options-positioning-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
