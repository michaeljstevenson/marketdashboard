// Scheduled Background Function (see [functions."scheduled-roe-
// decomposition-background"] in netlify.toml) for /roe-decomposition.html —
// the classic DuPont identity (ROE = net margin x asset turnover x equity
// multiplier) run across the full S&P 500. The real question this page
// asks: when two companies post the same ROE, are they getting there the
// same way? A retailer earning a high ROE on thin margins and fast
// inventory turns is a very different business from a utility or bank
// earning the same ROE mostly through balance-sheet leverage.
//
// Sweeps Alpha Vantage's INCOME_STATEMENT and BALANCE_SHEET endpoints
// (quarterly, ~1006 calls) across the full S&P 500 — a fresh, independent
// two-statement sweep rather than extending scheduled-margin-leverage-
// background.js's own checkpoint. That checkpoint's quarterly KEEP_FIELDS
// already carry netIncome/totalRevenue but not totalAssets or
// totalShareholderEquity (only kept annually, 2 years, for scheduled-
// quality-financials-background.js's Piotroski F-Score), so a partial reuse
// would still need its own ~503-call BALANCE_SHEET sweep and would couple
// this page to a checkpoint two other jobs already depend on — the same
// "second full sweep is safer than extending a shared checkpoint" call
// scheduled-roic-wacc-background.js and scheduled-cash-conversion-cycle-
// background.js made for the same reason. 28 quarters (~7 years) kept per
// statement, same window as scheduled-margin-leverage-background.js, so
// both the trailing-twelve-month cross-sectional snapshot AND a real
// multi-year structural-break test on the leverage trend come out of one
// sweep.
//
// One-time snapshot, no recurring schedule — matches the convention this
// site settled into for every full-universe fundamentals job added since
// 2026-09-16 (run manually via the Netlify dashboard "Run now"; quarterly
// fundamentals don't move day to day). The ~1006-call sweep needs the same
// checkpoint/resume machinery as scheduled-margin-leverage-background.js
// and scheduled-roic-wacc-background.js since it can't finish inside one
// Background Function's ~15-minute ceiling.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob, same pattern as every other full-universe sweep in this
// codebase.

const { getRoeDecompositionStore, BLOB_KEY, CHECKPOINT_KEY } = require("./roe-decomposition-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_NEEDED = 28; // ~7 years — same window as scheduled-margin-leverage-background.js
const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3;
const MIN_QUARTER_N = 40; // don't publish a market-aggregate calendar quarter built off fewer than this many companies

// Two calls per company (~1006 total). Same pacing tradeoff as scheduled-
// margin-leverage-background.js and scheduled-roic-wacc-background.js: 750ms
// keeps the main pass under ~12.6 minutes, leaving room for a retry pass
// inside a Background Function's ~15-minute ceiling.
const CALL_SLEEP_MS = 750;
const RUN_BUDGET_MS = 12 * 60 * 1000;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 120;

const KEEP_FIELDS = {
  INCOME_STATEMENT: ["fiscalDateEnding", "totalRevenue", "netIncome"],
  BALANCE_SHEET: ["fiscalDateEnding", "totalAssets", "totalShareholderEquity"],
};
const pick = (rows, keys) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on several fundamentals endpoints — same gotcha guarded
// against elsewhere in this codebase (e.g. scheduled-margin-leverage-
// background.js's num() helper).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Buckets a fiscal quarter-end date into the calendar quarter its month
// falls in — same convention (and same caveat about non-calendar fiscal
// years) as scheduled-margin-leverage-background.js's calendarQuarterKey.
function calendarQuarterKey(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

async function fetchStatement(apiKey, fn, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=${fn}&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) throw new Error(`${fn} unexpected response shape for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  return pick(rows.slice(0, QUARTERS_NEEDED), KEEP_FIELDS[fn]); // most-recent-first
}

// ---- Stats helpers — same methodology as /factor-analysis, duplicated
// here since every page on this site is self-contained (see CLAUDE.md). ----
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
  const seSlope = Math.sqrt((sse / dof) / sxx);
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
function betacf(x, a, b) {
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function logGamma(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betai(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}
function fTestPValue(F, d1, d2) {
  const x = (d1 * F) / (d1 * F + d2);
  return 1 - betai(x, d1 / 2, d2 / 2);
}
function chowTest(pooledSse, sub1, sub2, k) {
  const n1 = sub1.n, n2 = sub2.n;
  const rssSum = sub1.sse + sub2.sse;
  const numerator = (pooledSse - rssSum) / k;
  const denominator = rssSum / (n1 + n2 - 2 * k);
  const F = numerator / denominator;
  const d1 = k, d2 = n1 + n2 - 2 * k;
  return { F, d1, d2, p: fTestPValue(F, d1, d2) };
}

// Regresses an aggregate quarterly series' given field against a plain
// 1..n quarter index, splits it into two equal-length halves (oldest half /
// most recent half — an even split, so neither side gets more statistical
// power than the other, the same equal-n discipline /factor-analysis's own
// subsample check settled on and scheduled-ai-capex-background.js's own
// trendBreakTest reuses), and Chow-tests whether the trend (slope) differs
// between the two halves. Returns null if there isn't enough history for a
// meaningful split (needs at least 8 quarters, 4 per side).
function trendBreakTest(series, field) {
  const n = series.length;
  if (n < 8) return null;
  const half = Math.floor(n / 2);
  const idx = series.map((_, i) => i + 1);
  const vals = series.map((s) => s[field]);
  const pooled = linearRegression(idx, vals);
  const preReg = linearRegression(idx.slice(0, half), vals.slice(0, half));
  const postReg = linearRegression(idx.slice(n - half), vals.slice(n - half));
  const chow = chowTest(pooled.sse, preReg, postReg, 2);
  return {
    n, splitAt: series[n - half].q,
    preQuarters: [series[0].q, series[half - 1].q],
    postQuarters: [series[n - half].q, series[n - 1].q],
    pre: { n: preReg.n, slope: round(preReg.slope, 4), r: round(preReg.r, 3), p: preReg.p },
    post: { n: postReg.n, slope: round(postReg.slope, 4), r: round(postReg.r, 3), p: postReg.p },
    chow: { F: round(chow.F, 2), d1: chow.d1, d2: chow.d2, p: chow.p },
  };
}

exports.handler = async () => {
  console.log(`scheduled-roe-decomposition-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const startedAt = Date.now();
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
    const store = getRoeDecompositionStore();
    const saved = await store.get(CHECKPOINT_KEY, { type: "json" });
    const resume = !!(saved && !saved.complete && Date.now() - Date.parse(saved.startedAt) < CHECKPOINT_MAX_AGE_MS);
    const cycleStartedAt = resume ? saved.startedAt : new Date().toISOString();
    const results = new Map(resume ? Object.entries(saved.results) : []); // symbol -> { income, balance }
    if (resume) console.log(`scheduled-roe-decomposition-background: resuming checkpoint with ${results.size} ticker(s) already fetched`);

    const failures = resume ? { ...(saved.failed || {}) } : {};
    const saveCheckpoint = (complete) =>
      store.setJSON(CHECKPOINT_KEY, { startedAt: cycleStartedAt, complete, results: Object.fromEntries(results), failed: failures });

    async function fetchInto(symbol) {
      try {
        const income = await fetchStatement(apiKey, "INCOME_STATEMENT", symbol);
        await sleep(CALL_SLEEP_MS);
        const balance = await fetchStatement(apiKey, "BALANCE_SHEET", symbol);
        delete failures[symbol];
        results.set(symbol, { income, balance });
        return true;
      } catch (err) {
        console.error(`scheduled-roe-decomposition-background: ${symbol} failed: ${err.message}`);
        failures[symbol] = String(err.message).slice(0, 200);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = BREADTH_CONSTITUENTS.filter((s) => !results.has(s));
    let stoppedForTime = false;
    let sinceCheckpoint = 0;
    for (let pass = 0; pass < 2 && todo.length && !stoppedForTime; pass++) {
      if (pass > 0) {
        console.log(`scheduled-roe-decomposition-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(45000);
      }
      const missed = [];
      for (const symbol of todo) {
        if (outOfTime()) { stoppedForTime = true; break; }
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        if (got && ++sinceCheckpoint >= CHECKPOINT_EVERY) { await saveCheckpoint(false); sinceCheckpoint = 0; }
        await sleep(CALL_SLEEP_MS);
      }
      todo = missed;
    }
    await saveCheckpoint(!stoppedForTime);
    if (stoppedForTime) {
      console.log(`scheduled-roe-decomposition-background: out of time with ${results.size}/${BREADTH_CONSTITUENTS.length} fetched — run again to finish`);
      return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, fetched: results.size, published: false }) };
    }

    console.log(`scheduled-roe-decomposition-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    // ---- Per-company matched quarters (both statements present for the
    // same fiscalDateEnding), ascending by date. ----
    const companyQuarters = new Map(); // symbol -> [{ q, netIncome, totalRevenue, totalAssets, totalEquity }] ascending
    for (const [symbol, { income, balance }] of results.entries()) {
      const balByDate = new Map(balance.map((r) => [r.fiscalDateEnding, r]));
      const joined = [];
      for (const inc of income) {
        const bal = balByDate.get(inc.fiscalDateEnding);
        if (!bal) continue;
        const netIncome = num(inc.netIncome);
        const totalRevenue = num(inc.totalRevenue);
        const totalAssets = num(bal.totalAssets);
        const totalEquity = num(bal.totalShareholderEquity);
        if (netIncome === null || totalRevenue === null || totalAssets === null || totalEquity === null) continue;
        if (totalRevenue <= 0 || totalAssets <= 0) continue; // a company with zero/negative reported revenue or assets isn't a usable DuPont input
        joined.push({ q: inc.fiscalDateEnding, netIncome, totalRevenue, totalAssets, totalEquity });
      }
      joined.sort((a, b) => (a.q < b.q ? -1 : 1));
      if (joined.length) companyQuarters.set(symbol, joined);
    }

    // ---- Per-company TTM cross-sectional snapshot (latest 4 matched
    // quarters for the income-statement flow figures, latest single quarter
    // for the balance-sheet stock figures — same "TTM flow / latest-quarter
    // stock" convention as scheduled-roic-wacc-background.js). Companies
    // with non-positive latest-quarter book equity are excluded entirely,
    // not shown with a distorted ratio — same real limitation flagged on
    // /roic-wacc.html: aggressive, sustained buybacks (McDonald's,
    // Starbucks, and others) can drive book equity negative, which breaks
    // both the equity-multiplier and ROE math this page depends on. ----
    const companies = [];
    for (const [symbol, q] of companyQuarters.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      if (q.length < 4) continue;

      const latest4 = q.slice(-4);
      const latest = q[q.length - 1];
      if (latest.totalEquity <= 0) continue;

      const ttmNetIncome = latest4.reduce((s, r) => s + r.netIncome, 0);
      const ttmRevenue = latest4.reduce((s, r) => s + r.totalRevenue, 0);
      const margin = (ttmNetIncome / ttmRevenue) * 100;
      const turnover = ttmRevenue / latest.totalAssets;
      const leverage = latest.totalAssets / latest.totalEquity;
      const roe = (ttmNetIncome / latest.totalEquity) * 100;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalQuarter: latest.q,
        roe: round(roe),
        margin: round(margin),
        turnover: round(turnover, 3),
        leverage: round(leverage, 3),
        quarterCount: q.length,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable statement history and sector metadata");

    // ---- Dominant-driver tag: which of the three DuPont components sits
    // furthest above the market median, relative to that component's own
    // market median (a simple index, not a z-score — margin/turnover/
    // leverage live on very different scales, so a raw z-score would let
    // whichever has the smallest cross-sectional spread dominate by
    // arithmetic accident). ----
    const marketMedianMargin = median(companies.map((c) => c.margin));
    const marketMedianTurnover = median(companies.map((c) => c.turnover));
    const marketMedianLeverage = median(companies.map((c) => c.leverage));

    for (const c of companies) {
      const marginIdx = marketMedianMargin ? c.margin / marketMedianMargin : null;
      const turnoverIdx = marketMedianTurnover ? c.turnover / marketMedianTurnover : null;
      const leverageIdx = marketMedianLeverage ? c.leverage / marketMedianLeverage : null;
      c.marginIndex = round(marginIdx, 2);
      c.turnoverIndex = round(turnoverIdx, 2);
      c.leverageIndex = round(leverageIdx, 2);
      const indices = [
        { key: "margin", v: marginIdx },
        { key: "turnover", v: turnoverIdx },
        { key: "leverage", v: leverageIdx },
      ].filter((x) => x.v !== null);
      c.dominantDriver = indices.length ? indices.reduce((best, x) => (x.v > best.v ? x : best)).key : null;
    }

    // ---- Sector cross-section. ----
    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (inSector.length < MIN_SECTOR_N) return null;
      const sectorMedianMargin = median(inSector.map((c) => c.margin));
      const sectorMedianTurnover = median(inSector.map((c) => c.turnover));
      const sectorMedianLeverage = median(inSector.map((c) => c.leverage));
      return {
        sector,
        count: inSector.length,
        medianRoe: round(median(inSector.map((c) => c.roe))),
        medianMargin: round(sectorMedianMargin),
        medianTurnover: round(sectorMedianTurnover, 3),
        medianLeverage: round(sectorMedianLeverage, 3),
        marginIndex: round(marketMedianMargin ? (sectorMedianMargin / marketMedianMargin) * 100 : null, 1),
        turnoverIndex: round(marketMedianTurnover ? (sectorMedianTurnover / marketMedianTurnover) * 100 : null, 1),
        leverageIndex: round(marketMedianLeverage ? (sectorMedianLeverage / marketMedianLeverage) * 100 : null, 1),
        marginDriven: inSector.filter((c) => c.dominantDriver === "margin").length,
        turnoverDriven: inSector.filter((c) => c.dominantDriver === "turnover").length,
        leverageDriven: inSector.filter((c) => c.dominantDriver === "leverage").length,
      };
    }).filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianRoe: round(median(companies.map((c) => c.roe))),
      medianMargin: round(marketMedianMargin),
      medianTurnover: round(marketMedianTurnover, 3),
      medianLeverage: round(marketMedianLeverage, 3),
      leverageDrivenPct: round((companies.filter((c) => c.dominantDriver === "leverage").length / companies.length) * 100, 1),
    };

    // ---- Cross-sectional tests: which of the three DuPont components best
    // explains ROE dispersion across the index? Pearson+Spearman for each,
    // same two-method check as /factor-analysis. ----
    function factorTest(field) {
      const pairs = companies.filter((c) => c[field] !== null && c.roe !== null);
      if (pairs.length < 8) return null;
      const xs = pairs.map((c) => c[field]);
      const ys = pairs.map((c) => c.roe);
      const pearson = linearRegression(xs, ys);
      const spear = spearmanRegression(xs, ys);
      return {
        pearson: { n: pearson.n, r: round(pearson.r, 3), r2: round(pearson.r2, 3), slope: round(pearson.slope, 4), t: round(pearson.t, 2), p: pearson.p },
        spearman: { n: spear.n, r: round(spear.r, 3), r2: round(spear.r2, 3), slope: round(spear.slope, 4), t: round(spear.t, 2), p: spear.p },
      };
    }
    const marginVsRoe = factorTest("margin");
    const turnoverVsRoe = factorTest("turnover");
    const leverageVsRoe = factorTest("leverage");
    const leverageScatterPairs = companies
      .filter((c) => c.leverage !== null && c.roe !== null)
      .map((c) => ({ x: c.leverage, y: c.roe, symbol: c.symbol, sector: c.sector }));

    // ---- Aggregate quarterly market series (sum of net income / revenue /
    // assets / equity across every company present that calendar quarter,
    // not an average of ratios — same aggregation discipline as
    // scheduled-ai-capex-background.js's buildAggregateSeries). Feeds the
    // historical trend chart and the leverage/ROE structural-break tests. ----
    const byQuarter = new Map(); // calendarQuarterKey -> { netIncome, revenue, assets, equity, n }
    for (const q of companyQuarters.values()) {
      for (const row of q) {
        const ck = calendarQuarterKey(row.q);
        const acc = byQuarter.get(ck) || { netIncome: 0, revenue: 0, assets: 0, equity: 0, n: 0 };
        acc.netIncome += row.netIncome;
        acc.revenue += row.totalRevenue;
        acc.assets += row.totalAssets;
        acc.equity += row.totalEquity;
        acc.n += 1;
        byQuarter.set(ck, acc);
      }
    }
    const marketSeriesRaw = [...byQuarter.entries()]
      .map(([q, acc]) => ({
        q,
        n: acc.n,
        margin: round((acc.netIncome / acc.revenue) * 100, 3),
        turnover: round((acc.revenue * 4) / acc.assets, 4), // annualized: a single quarter's revenue x4 vs. that quarter's asset base
        leverage: round(acc.assets / acc.equity, 4),
        roe: round(((acc.netIncome * 4) / acc.equity) * 100, 3), // annualized quarterly ROE, not a TTM figure — see methodology note on the page
      }))
      .filter((r) => r.n >= MIN_QUARTER_N)
      .sort((a, b) => (a.q < b.q ? -1 : 1));

    // Trim to the longest run of consecutive calendar quarters (thin
    // coverage at the edges of the 28-quarter window otherwise leaves
    // gaps a Chart.js line/Chow test would either bridge wrongly or choke
    // on) — same helper logic as scheduled-ai-capex-background.js.
    function longestRun(series) {
      if (series.length < 2) return series;
      let best = [series[0]], cur = [series[0]];
      for (let i = 1; i < series.length; i++) {
        const [py, pq] = series[i - 1].q.split("-Q").map(Number);
        const expected = pq === 4 ? `${py + 1}-Q1` : `${py}-Q${pq + 1}`;
        if (series[i].q === expected) cur.push(series[i]);
        else cur = [series[i]];
        if (cur.length > best.length) best = cur;
      }
      return best;
    }
    const marketSeries = longestRun(marketSeriesRaw);

    const leverageTrendBreak = trendBreakTest(marketSeries, "leverage");
    const roeTrendBreak = trendBreakTest(marketSeries, "roe");

    // ---- Leaderboards. "Quality ROE leaders" — high ROE without
    // above-market leverage — is the page's real screen: it separates
    // genuinely efficient/profitable businesses from ones whose ROE is
    // mostly a balance-sheet effect. ----
    const leaderRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, roe: c.roe, margin: c.margin, turnover: c.turnover, leverage: c.leverage, dominantDriver: c.dominantDriver });
    const rankedByRoe = [...companies].filter((c) => c.roe !== null).sort((a, b) => b.roe - a.roe);
    const highestRoe = rankedByRoe.slice(0, NOTABLE_COUNT).map(leaderRow);
    const qualityRoeLeaders = rankedByRoe
      .filter((c) => c.leverageIndex !== null && c.leverageIndex <= 1)
      .slice(0, NOTABLE_COUNT)
      .map(leaderRow);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      market,
      sectors,
      marginVsRoe,
      turnoverVsRoe,
      leverageVsRoe,
      leverageScatterPairs,
      marketSeries,
      leverageTrendBreak,
      roeTrendBreak,
      highestRoe,
      qualityRoeLeaders,
      companies: companies.map((c) => ({
        symbol: c.symbol, name: c.name, sector: c.sector, fiscalQuarter: c.fiscalQuarter,
        roe: c.roe, margin: c.margin, turnover: c.turnover, leverage: c.leverage,
        marginIndex: c.marginIndex, turnoverIndex: c.turnoverIndex, leverageIndex: c.leverageIndex,
        dominantDriver: c.dominantDriver,
      })),
    };

    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-roe-decomposition-background: wrote ${companies.length} companies across ${sectors.length} sectors, market series ${marketSeries.length}q`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-roe-decomposition-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
