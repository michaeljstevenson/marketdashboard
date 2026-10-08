// Scheduled Background Function (see [functions."scheduled-options-
// positioning-background"] in netlify.toml) for /options-positioning.html:
// market-level options positioning.
//
// Makes no Alpha Vantage calls. Everything comes from the put/call snapshots
// scheduled-putcall-history-background.js collects overnight:
//   - weekly put/call ratios for SPY, QQQ and IWM since 2008 (full chain plus
//     near- and far-dated expiration medians), for the history, where this
//     week sits in it, and a test against each ETF's later return
//   - month-end snapshots of every S&P 500 member since October 2021, for
//     the history of the market-median ratio
//   - the weekly snapshot of current members, for sectors and the
//     cross-sectional test against 3-month relative return
// ETF prices come from Yahoo.
//
// The forward test ranks each week's ratio against its own trailing 52
// weeks, so a slow drift in the ratio's level (the options market changed a
// lot after 2008) doesn't decide the result, and uses only what was known on
// the day: the ratio is end-of-day, so returns start at the next close.

const { getOptionsPositioningStore, BLOB_KEY } = require("./options-positioning-blob-store");
const { getPutCallHistoryStore, PROGRESS_KEY, snapshotKey } = require("./putcall-history-blob-store");
const { DATES: PLAN_DATES } = require("./putcall-history-plan");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { fetchDailyHistory } = require("./yahoo-client");

const ETFS = ["SPY", "QQQ", "IWM"];
const HORIZONS = [21, 63, 126];
const LOOKBACK_WEEKS = 52;
const BUCKETS = 5;
const MIN_TWO_SIDED_EXPIRATIONS = 3;
const MIN_SECTOR_N = 3;

function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
const pct = (v, d = 2) => (v === null || v === undefined ? null : round(v * 100, d));
const mean = (a) => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const p = (v.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return v[lo] + (v[hi] - v[lo]) * (p - lo);
}
const median = (a) => quantile(a, 0.5);
// Share of values at or below x, ties counted half, so a reading equal to
// every past value sits at 50.
function percentileOf(values, x) {
  const v = values.filter(Number.isFinite);
  if (!v.length || !Number.isFinite(x)) return null;
  let below = 0, equal = 0;
  for (const y of v) { if (y < x) below++; else if (y === x) equal++; }
  return ((below + equal / 2) / v.length) * 100;
}

// OLS slope of y on x with a Newey-West standard error, for forward returns
// whose windows overlap from one week to the next.
function nwRegression(xs, ys, lag) {
  const n = xs.length;
  if (n < 30) return { n, slope: null, t: null };
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxy / sxx, a = my - b * mx;
  const g = xs.map((x, i) => (x - mx) * (ys[i] - a - b * x));
  let s = g.reduce((acc, v) => acc + v * v, 0);
  for (let l = 1; l <= Math.min(lag, n - 1); l++) {
    let c = 0;
    for (let i = l; i < n; i++) c += g[i] * g[i - l];
    s += 2 * (1 - l / (lag + 1)) * c;
  }
  const se = Math.sqrt(s) / sxx;
  return { n, slope: b, t: se > 0 ? b / se : null };
}

function linearRegression(xs, ys) {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx, r = sxy / Math.sqrt(sxx * syy);
  const sse = ys.reduce((s, y, i) => s + (y - (intercept + slope * xs[i])) ** 2, 0);
  const t = slope / Math.sqrt(sse / (n - 2) / sxx);
  return { n, slope, r, r2: r * r, t, p: 2 * (1 - normalCdf(Math.abs(t))) };
}
function normalCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
function rankArray(arr) {
  const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && arr[idx[j + 1]] === arr[idx[i]]) j++;
    for (let k = i; k <= j; k++) ranks[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return ranks;
}

async function loadEtfHistory(hist) {
  const series = Object.fromEntries(ETFS.map((s) => [s, []]));
  const firstYear = 2008, lastYear = new Date().getUTCFullYear();
  for (let y = firstYear; y <= lastYear; y++) {
    const snap = await hist.get(snapshotKey(`etf-${y}`), { type: "json" });
    if (!snap) continue;
    for (const [key, r] of Object.entries(snap.results || {})) {
      const [date, sym] = key.split("|");
      if (!series[sym] || r.pc === null) continue;
      series[sym].push({ date, pc: r.pc, near: r.near ?? null, far: r.far ?? null });
    }
  }
  for (const s of ETFS) series[s].sort((a, b) => (a.date < b.date ? -1 : 1));
  return series;
}

function forwardTest(points, prices) {
  const days = prices.map((p) => p.date);
  const close = prices.map((p) => p.close);
  const indexAfter = (date) => { let lo = 0, hi = days.length; while (lo < hi) { const m = (lo + hi) >> 1; if (days[m] <= date) lo = m + 1; else hi = m; } return lo; };
  const rows = [];
  for (let i = LOOKBACK_WEEKS; i < points.length; i++) {
    const past = points.slice(i - LOOKBACK_WEEKS, i).map((p) => p.pc);
    const signal = percentileOf(past.concat(points[i].pc), points[i].pc);
    const entry = indexAfter(points[i].date);
    if (entry >= days.length) continue;
    const fwd = {};
    for (const h of HORIZONS) if (entry + h < days.length) fwd[h] = close[entry + h] / close[entry] - 1;
    rows.push({ date: points[i].date, signal, bucket: Math.min(BUCKETS - 1, Math.floor((signal / 100) * BUCKETS)), fwd });
  }
  const byHorizon = {};
  for (const h of HORIZONS) {
    const usable = rows.filter((r) => Number.isFinite(r.fwd[h]));
    const all = mean(usable.map((r) => r.fwd[h]));
    const buckets = Array.from({ length: BUCKETS }, (_, k) => {
      const v = usable.filter((r) => r.bucket === k).map((r) => r.fwd[h]);
      return { bucket: k + 1, weeks: v.length, meanPct: pct(mean(v)), hitRatePct: v.length ? round((v.filter((x) => x > 0).length / v.length) * 100, 1) : null };
    });
    const reg = nwRegression(usable.map((r) => r.signal / 100), usable.map((r) => r.fwd[h]), Math.ceil(h / 5));
    byHorizon[h] = {
      weeks: usable.length,
      allMeanPct: pct(all),
      buckets,
      highMinusLowPct: buckets[BUCKETS - 1].weeks && buckets[0].weeks ? round(buckets[BUCKETS - 1].meanPct - buckets[0].meanPct, 2) : null,
      highMinusAllPct: buckets[BUCKETS - 1].weeks ? round(buckets[BUCKETS - 1].meanPct - pct(all), 2) : null,
      // Return per move from the bottom to the top of the trailing range.
      slopePct: pct(reg.slope), slopeT: round(reg.t),
    };
  }
  return { firstSignalDate: rows.length ? rows[0].date : null, weeksTested: rows.length, byHorizon };
}

exports.handler = async () => {
  const started = Date.now();
  try {
    const hist = getPutCallHistoryStore();
    const progress = (await hist.get(PROGRESS_KEY, { type: "json" })) || {};

    // ---- index ETFs ----------------------------------------------------
    const etfHistory = await loadEtfHistory(hist);
    const since = Math.floor(Date.parse("2007-12-01T00:00:00Z") / 1000);
    const etfs = {};
    for (const sym of ETFS) {
      const points = etfHistory[sym];
      if (!points.length) continue;
      const prices = await fetchDailyHistory(sym, { adjusted: true, sinceUnix: since });
      const last = points[points.length - 1];
      const trailing = points.slice(-LOOKBACK_WEEKS).map((p) => p.pc);
      etfs[sym] = {
        weeks: points.length,
        firstDate: points[0].date,
        latest: { date: last.date, pc: last.pc, near: last.near, far: last.far },
        percentileSinceStart: round(percentileOf(points.map((p) => p.pc), last.pc), 1),
        percentile52w: round(percentileOf(trailing, last.pc), 1),
        median52w: round(median(trailing), 3),
        medianSinceStart: round(median(points.map((p) => p.pc)), 3),
        history: points.map((p) => [p.date, p.pc, p.near, p.far]),
        test: forwardTest(points, prices),
      };
    }

    // ---- S&P 500 members: month-end history plus this week -------------
    const monthEnds = PLAN_DATES.concat(Object.keys(progress.done || {}).filter((d) => !PLAN_DATES.includes(d))).sort();
    const history = [];
    for (const date of monthEnds) {
      if (!(progress.done || {})[date]) continue;
      const snap = await hist.get(snapshotKey(date), { type: "json" });
      if (!snap) continue;
      const v = Object.values(snap.results || {}).map((r) => r.pc).filter(Number.isFinite);
      if (v.length < 100) continue;
      history.push({ date, median: round(median(v), 3), p25: round(quantile(v, 0.25), 3), p75: round(quantile(v, 0.75), 3), n: v.length, kind: "month-end" });
    }
    const weekly = progress.latestWeekly ? await hist.get(snapshotKey(`weekly-${progress.latestWeekly}`), { type: "json" }) : null;
    if (!weekly) throw new Error("no weekly put/call snapshot yet");
    const wv = Object.values(weekly.results).map((r) => r.pc).filter(Number.isFinite);
    if (!history.length || history[history.length - 1].date < weekly.date) {
      history.push({ date: weekly.date, median: round(median(wv), 3), p25: round(quantile(wv, 0.25), 3), p75: round(quantile(wv, 0.75), 3), n: wv.length, kind: "weekly" });
    }

    const meta = ((await getBeeswarmStore().get(META_KEY, { type: "json" })) || {}).tickers || {};
    let rel3M = {};
    try {
      const rs = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      for (const c of (rs && rs.companies) || []) rel3M[c.symbol] = c.rel3M;
    } catch (err) {
      console.error(`scheduled-options-positioning-background: relative-strength blob unavailable (${err.message})`);
    }
    const companies = [];
    for (const [symbol, r] of Object.entries(weekly.results)) {
      const m = meta[symbol];
      if (r.pc === null || !m || !m.sector) continue;
      companies.push({ symbol, sector: m.sector, putCallRatio: r.pc, twoSided: r.twoSided, rel3M: Number.isFinite(rel3M[symbol]) ? rel3M[symbol] : null });
    }
    const market = {
      date: weekly.date,
      companyCount: companies.length,
      medianPutCallRatio: round(median(companies.map((c) => c.putCallRatio)), 3),
      meanPutCallRatio: round(mean(companies.map((c) => c.putCallRatio)), 3),
      shareAboveOnePct: round((companies.filter((c) => c.putCallRatio > 1).length / companies.length) * 100, 1),
    };
    const sectors = SECTOR_ORDER.map((sector) => {
      const list = companies.filter((c) => c.sector === sector);
      if (list.length < MIN_SECTOR_N) return null;
      return { sector, count: list.length, medianPutCallRatio: round(median(list.map((c) => c.putCallRatio)), 3) };
    }).filter(Boolean);
    const pairs = companies.filter((c) => c.rel3M !== null);
    let momentumTest = null;
    if (pairs.length >= 30) {
      const xs = pairs.map((c) => c.rel3M), ys = pairs.map((c) => c.putCallRatio);
      const pe = linearRegression(xs, ys), sp = linearRegression(rankArray(xs), rankArray(ys));
      const pack = (x) => ({ n: x.n, r: round(x.r, 3), r2: round(x.r2, 3), slope: round(x.slope, 4), t: round(x.t, 2), p: x.p });
      momentumTest = { pearson: pack(pe), spearman: pack(sp) };
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      etfs,
      horizons: HORIZONS,
      lookbackWeeks: LOOKBACK_WEEKS,
      buckets: BUCKETS,
      market,
      history,
      sectors,
      scatter: pairs.map((c) => ({ symbol: c.symbol, sector: c.sector, putCallRatio: c.putCallRatio, rel3M: c.rel3M })),
      momentumTest,
      minTwoSidedExpirations: MIN_TWO_SIDED_EXPIRATIONS,
      thinChainCount: companies.filter((c) => c.twoSided < MIN_TWO_SIDED_EXPIRATIONS).length,
      companies: companies.map((c) => ({ symbol: c.symbol, sector: c.sector, putCallRatio: c.putCallRatio })),
    };
    await getOptionsPositioningStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-options-positioning-background: ${Object.keys(etfs).map((s) => `${s} ${etfs[s].weeks} weeks`).join(", ")}, ${history.length} member snapshots, ${companies.length} companies, ${Math.round((Date.now() - started) / 1000)}s`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`scheduled-options-positioning-background: FAILED: ${err.message}`);
    return { statusCode: 500 };
  }
};

module.exports.forwardTest = forwardTest;
module.exports.percentileOf = percentileOf;
module.exports.nwRegression = nwRegression;
