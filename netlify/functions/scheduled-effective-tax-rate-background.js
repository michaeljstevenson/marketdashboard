// Scheduled Background Function (see [functions."scheduled-effective-tax-
// rate-background"] in netlify.toml) for /effective-tax-rate.html — tracks
// the S&P 500's actual effective corporate tax rate (tax expense as a share
// of pretax income, not the 21% federal statutory rate), whether it has
// genuinely shifted over time, and two cross-sectional questions: do bigger
// companies achieve lower effective tax rates (economies of scale in tax
// planning, multinational profit-shifting availability — a real, widely
// studied finding in the tax literature), and does a lower tax rate show up
// in better relative stock performance.
//
// No existing page on this site touches corporate income taxes at all —
// Margin & Leverage Cycle tracks gross/operating/net margin, ROIC vs. Cost
// of Capital and Cash Conversion Cycle look at capital efficiency, but none
// of them isolate the tax line specifically.
//
// Single-endpoint sweep of Alpha Vantage's INCOME_STATEMENT (quarterly,
// incomeBeforeTax + incomeTaxExpense) across the full S&P 500 — ~503
// sequential calls, no checkpoint/resume needed, same class as scheduled-
// rd-intensity-background.js and scheduled-fcf-yield-background.js. No
// join against scheduled-margin-leverage-background.js's checkpoint is
// needed here (unlike scheduled-ai-capex-background.js and scheduled-sbc-
// dilution-background.js): this job's own INCOME_STATEMENT call already
// carries everything it needs in one response.
//
// REIT_SECTOR below is a one-sector cohort — Real Estate — not a hand-picked
// list: REITs are pass-through entities for federal income tax purposes as
// long as they distribute ~90%+ of taxable income as dividends, so the
// sector's effective tax rate runs structurally near zero for a real,
// well-documented legal reason, not tax avoidance in the aggressive sense.
// Breaking it out separately keeps it from distorting the "rest of the
// index" trend and gives the page an honest, explainable two-group split,
// the same cohort-vs-rest pattern scheduled-ai-capex-background.js and
// scheduled-sbc-dilution-background.js use.
//
// Optionally reads scheduled-relative-strength-background.js's own
// published latest.json (3-month relative price return) for the second
// cross-sectional test; degrades gracefully (that test just doesn't
// render) if that blob isn't populated yet, since there's no scheduling
// order to enforce between two jobs that don't share a recurring cron.
//
// One-time snapshot, no recurring schedule — matches the convention this
// site settled into for every page added since 2026-09-16. ~503 sequential
// INCOME_STATEMENT calls at 1050ms spacing plus a retry pass.

const { getEffectiveTaxRateStore, BLOB_KEY } = require("./effective-tax-rate-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_NEEDED = 28; // ~7 years, same window as this site's other full-universe quarterly sweeps
const NOTABLE_COUNT = 15;
const MIN_QUARTER_N = 40; // don't publish a market-aggregate calendar quarter built off fewer than this many companies
const MIN_COHORT_N = 8; // Real Estate is a much smaller sector than the full index
// A TTM effective tax rate outside this band is almost always a one-off
// tax item (a settlement, a valuation-allowance release/charge, a repatriation
// charge) swamping a small pretax-income denominator, not a meaningful
// "rate" — same divide-by-near-zero-denominator guard as scheduled-
// surprise-background.js's ±200% surprise filter. Excluded from company
// records entirely (not clamped) rather than shown as a distorted number.
const ETR_MIN = -50;
const ETR_MAX = 75;

const REIT_SECTOR = "Real Estate";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on this endpoint — same gotcha guarded against elsewhere in
// this codebase.
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
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

function calendarQuarterKey(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

async function fetchQuarterlyTax(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=INCOME_STATEMENT&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);

  return rows.slice(0, QUARTERS_NEEDED).map((r) => ({
    fiscalDateEnding: r.fiscalDateEnding,
    incomeBeforeTax: num(r.incomeBeforeTax),
    incomeTaxExpense: num(r.incomeTaxExpense),
  }));
}

// ---- Stats helpers — same methodology as /factor-analysis and scheduled-
// ai-capex-background.js / scheduled-sbc-dilution-background.js, duplicated
// here (server-side, since the Chow test needs the aggregate quarterly
// series this job itself builds) per the site convention that every page
// is self-contained. ----
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

// Regresses a quarterly series' effective tax rate against a plain 1..n
// quarter index, splits it into two equal-length halves (oldest half /
// most recent half), and Chow-tests whether the trend (slope) differs
// between them. Returns null if there isn't enough history for a
// meaningful split (needs at least 8 quarters, 4 per side) — same
// construction as scheduled-ai-capex-background.js's trendBreakTest.
function trendBreakTest(series) {
  const n = series.length;
  if (n < 8) return null;
  const half = Math.floor(n / 2);
  const idx = series.map((_, i) => i + 1);
  const vals = series.map((s) => s.etr);
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
  console.log(`scheduled-effective-tax-rate-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmMeta = await getBeeswarmStore().get(META_KEY, { type: "json" });
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};

    let relativeStrengthBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relativeStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-effective-tax-rate-background: could not read relative-strength blob, continuing without it:", err.message);
    }

    const taxResults = new Map(); // symbol -> quarters (most-recent-first)

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchQuarterlyTax(apiKey, symbol);
        if (quarters.length >= 8) taxResults.set(symbol, quarters);
        return true;
      } catch (err) {
        console.error(`scheduled-effective-tax-rate-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-effective-tax-rate-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-effective-tax-rate-background: fetched tax data for ${taxResults.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (taxResults.size === 0) throw new Error("Every ticker failed. Refusing to write an empty snapshot");

    // ---- Per-quarter ETR, ascending order, per company. ----
    const companyQuarters = new Map(); // symbol -> [{ q, pretax, tax, etr }] ascending, quarters with positive pretax income only
    for (const [symbol, rows] of taxResults.entries()) {
      const joined = [];
      for (const row of rows) {
        if (row.incomeBeforeTax === null || row.incomeTaxExpense === null) continue;
        if (row.incomeBeforeTax <= 0) continue; // a quarterly loss makes the ratio meaningless — left out, not fabricated
        joined.push({ q: row.fiscalDateEnding, pretax: row.incomeBeforeTax, tax: row.incomeTaxExpense, etr: round((row.incomeTaxExpense / row.incomeBeforeTax) * 100, 3) });
      }
      joined.sort((a, b) => (a.q < b.q ? -1 : 1));
      if (joined.length >= 8) companyQuarters.set(symbol, joined);
    }

    console.log(`scheduled-effective-tax-rate-background: ${companyQuarters.size} tickers with enough positive-pretax-income quarters`);
    if (companyQuarters.size === 0) throw new Error("No tickers had enough quarters of positive pretax income");

    // ---- Per-company TTM summary (latest 4 quarters vs. the prior 4 — a
    // TTM-over-TTM comparison rather than one noisy quarter). Requires all
    // 4 of the latest 4 quarters to have positive pretax income (a company
    // with any loss quarter in the trailing year is skipped for the TTM
    // figure, not patched over). ----
    const companies = [];
    for (const [symbol, q] of companyQuarters.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      // Need the actual latest 4 *calendar* quarters present and consecutive
      // in the joined (loss-quarters-excluded) series — reuse q's tail only
      // if it has at least 4 rows; a company with an interspersed loss
      // quarter inside its trailing year won't have 4 consecutive rows at
      // the tail matching the real last 4 fiscal quarters, so this is a
      // conservative (not a perfectly precise) TTM window.
      if (q.length < 4) continue;
      const last4 = q.slice(-4);
      const ttmPretax = last4.reduce((s, r) => s + r.pretax, 0);
      const ttmTax = last4.reduce((s, r) => s + r.tax, 0);
      const etrTTM = ttmPretax > 0 ? round((ttmTax / ttmPretax) * 100, 3) : null;
      const inRange = etrTTM !== null && etrTTM >= ETR_MIN && etrTTM <= ETR_MAX;

      let etrTTMPrior = null, etrChangeYoY = null;
      if (q.length >= 8) {
        const prior4 = q.slice(-8, -4);
        const priorPretax = prior4.reduce((s, r) => s + r.pretax, 0);
        const priorTax = prior4.reduce((s, r) => s + r.tax, 0);
        if (priorPretax > 0) {
          const priorEtr = round((priorTax / priorPretax) * 100, 3);
          if (priorEtr >= ETR_MIN && priorEtr <= ETR_MAX) {
            etrTTMPrior = priorEtr;
            if (inRange) etrChangeYoY = round(etrTTM - priorEtr, 2);
          }
        }
      }

      if (!inRange) continue; // excluded from the published snapshot entirely, not clamped — see ETR_MIN/ETR_MAX comment

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        isReitSector: m.sector === REIT_SECTOR,
        marketCap: m.marketCap || null,
        ttmPretax: Math.round(ttmPretax),
        etrTTM,
        etrChangeYoY,
        rel3M: Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, symbol) ? relativeStrengthBySymbol[symbol] : null,
        quarterCount: q.length,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with a valid TTM effective tax rate and sector metadata");

    // ---- Aggregate quarterly series: full market, Real Estate cohort,
    // rest of market. One point per calendar quarter (sum tax / sum pretax
    // income across whichever companies have that quarter and positive
    // pretax income, not a ~500-way pseudo-replicated panel) — same
    // aggregation discipline as scheduled-ai-capex-background.js and
    // scheduled-sbc-dilution-background.js. ----
    function buildAggregateSeries(symbols) {
      const byQuarter = new Map(); // calendarQuarterKey -> { pretax, tax, n }
      for (const symbol of symbols) {
        const q = companyQuarters.get(symbol);
        if (!q) continue;
        for (const row of q) {
          const ck = calendarQuarterKey(row.q);
          const acc = byQuarter.get(ck) || { pretax: 0, tax: 0, n: 0 };
          acc.pretax += row.pretax;
          acc.tax += row.tax;
          acc.n += 1;
          byQuarter.set(ck, acc);
        }
      }
      return [...byQuarter.entries()]
        .map(([q, acc]) => ({ q, totalPretax: Math.round(acc.pretax), totalTax: Math.round(acc.tax), etr: round((acc.tax / acc.pretax) * 100, 3), n: acc.n }))
        .sort((a, b) => (a.q < b.q ? -1 : 1));
    }

    const marketSymbols = [...companyQuarters.keys()].filter((s) => metaTickers[s] && metaTickers[s].sector);
    const cohortSymbols = marketSymbols.filter((s) => metaTickers[s].sector === REIT_SECTOR);
    const restSymbols = marketSymbols.filter((s) => metaTickers[s].sector !== REIT_SECTOR);

    const marketSeriesRaw = buildAggregateSeries(marketSymbols).filter((r) => r.n >= MIN_QUARTER_N);
    const cohortSeriesRaw = buildAggregateSeries(cohortSymbols).filter((r) => r.n >= MIN_COHORT_N);
    const restSeriesRaw = buildAggregateSeries(restSymbols).filter((r) => r.n >= MIN_QUARTER_N);

    // Trim each series' partial leading/trailing quarters by keeping the
    // longest run of consecutive calendar quarters — same as scheduled-
    // ai-capex-background.js's longestRun.
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
    const cohortSeries = longestRun(cohortSeriesRaw);
    const restSeries = longestRun(restSeriesRaw);

    const cohortTrendBreak = trendBreakTest(cohortSeries);
    const restTrendBreak = trendBreakTest(restSeries);
    const marketTrendBreak = trendBreakTest(marketSeries);

    // ---- Cross-sectional test 1 (primary, no cross-page dependency): does
    // company size predict a lower effective tax rate? log10(market cap)
    // vs. TTM ETR, Pearson+Spearman — log-scaled since market cap spans
    // several orders of magnitude across the index. ----
    const sizePairs = companies.filter((c) => c.marketCap && c.marketCap > 0);
    const sizeScatter = sizePairs.map((c) => ({ symbol: c.symbol, sector: c.sector, isReitSector: c.isReitSector, logMarketCap: round(Math.log10(c.marketCap), 3), etrTTM: c.etrTTM }));
    let sizeTest = null;
    if (sizePairs.length >= 8) {
      const xs = sizeScatter.map((c) => c.logMarketCap);
      const ys = sizeScatter.map((c) => c.etrTTM);
      const pearson = linearRegression(xs, ys);
      const spear = spearmanRegression(xs, ys);
      sizeTest = {
        pearson: { n: pearson.n, r: round(pearson.r, 3), r2: round(pearson.r2, 3), slope: round(pearson.slope, 4), t: round(pearson.t, 2), p: pearson.p },
        spearman: { n: spear.n, r: round(spear.r, 3), r2: round(spear.r2, 3), slope: round(spear.slope, 4), t: round(spear.t, 2), p: spear.p },
      };
    }

    // ---- Cross-sectional test 2 (secondary, optional): does a lower ETR
    // coincide with better relative price performance? TTM ETR vs. 3-month
    // relative return (from Relative Strength Leaders/Laggards). ----
    const perfPairs = companies.filter((c) => c.rel3M !== null && c.rel3M !== undefined);
    const perfScatter = perfPairs.map((c) => ({ symbol: c.symbol, sector: c.sector, isReitSector: c.isReitSector, etrTTM: c.etrTTM, rel3M: c.rel3M }));
    let perfTest = null;
    if (perfPairs.length >= 8) {
      const xs = perfScatter.map((c) => c.etrTTM);
      const ys = perfScatter.map((c) => c.rel3M);
      const pearson = linearRegression(xs, ys);
      const spear = spearmanRegression(xs, ys);
      perfTest = {
        pearson: { n: pearson.n, r: round(pearson.r, 3), r2: round(pearson.r2, 3), slope: round(pearson.slope, 4), t: round(pearson.t, 2), p: pearson.p },
        spearman: { n: spear.n, r: round(spear.r, 3), r2: round(spear.r2, 3), slope: round(spear.slope, 4), t: round(spear.t, 2), p: spear.p },
      };
    }

    // ---- Sector cross-section. ----
    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      return {
        sector,
        count: inSector.length,
        avgEtr: round(mean(inSector.map((c) => c.etrTTM)), 2),
        avgEtrChangeYoY: round(mean(inSector.map((c) => c.etrChangeYoY)), 2),
      };
    }).filter(Boolean);

    // ---- Leaderboards ----
    const etrRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, isReitSector: c.isReitSector, etrTTM: c.etrTTM, ttmPretax: c.ttmPretax });
    const lowestEtr = [...companies].sort((a, b) => a.etrTTM - b.etrTTM).slice(0, NOTABLE_COUNT).map(etrRow);
    const highestEtr = [...companies].sort((a, b) => b.etrTTM - a.etrTTM).slice(0, NOTABLE_COUNT).map(etrRow);

    const changeRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, isReitSector: c.isReitSector, etrChangeYoY: c.etrChangeYoY, etrTTM: c.etrTTM });
    const withChange = companies.filter((c) => c.etrChangeYoY !== null);
    const biggestCuts = [...withChange].sort((a, b) => a.etrChangeYoY - b.etrChangeYoY).slice(0, NOTABLE_COUNT).map(changeRow);
    const biggestIncreases = [...withChange].sort((a, b) => b.etrChangeYoY - a.etrChangeYoY).slice(0, NOTABLE_COUNT).map(changeRow);

    const market = {
      companyCount: companies.length,
      avgEtr: round(mean(companies.map((c) => c.etrTTM)), 2),
      medianEtr: round(median(companies.map((c) => c.etrTTM)), 2),
      medianEtrChangeYoY: round(median(companies.map((c) => c.etrChangeYoY)), 2),
      pctBelow21: round((companies.filter((c) => c.etrTTM < 21).length / companies.length) * 100, 1),
      reitAvgEtr: round(mean(companies.filter((c) => c.isReitSector).map((c) => c.etrTTM)), 2),
    };

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: companies.length,
      reitSector: REIT_SECTOR,
      market,
      marketSeries,
      cohortSeries,
      restSeries,
      cohortTrendBreak,
      restTrendBreak,
      marketTrendBreak,
      sizeTest,
      sizeScatter,
      perfTest,
      perfScatter,
      sectors,
      lowestEtr,
      highestEtr,
      biggestCuts,
      biggestIncreases,
      companies: companies.map((c) => ({
        symbol: c.symbol, name: c.name, sector: c.sector, isReitSector: c.isReitSector,
        etrTTM: c.etrTTM, etrChangeYoY: c.etrChangeYoY, ttmPretax: c.ttmPretax, rel3M: c.rel3M,
      })),
    };

    await getEffectiveTaxRateStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-effective-tax-rate-background: wrote ${companies.length} companies, market series ${marketSeries.length}q, cohort series ${cohortSeries.length}q`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-effective-tax-rate-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
