// Scheduled Background Function (see [functions."scheduled-ai-capex-
// background"] in netlify.toml) for /ai-capex-tracker.html — tracks
// capital-expenditure growth and capex intensity (capex / revenue) across
// the full S&P 500, with a hand-curated "hyperscaler + AI infrastructure"
// cohort broken out against the rest of the index, and a structural-break
// test asking whether capex intensity's trend over time has genuinely
// shifted (the "AI capex supercycle" claim) rather than just eyeballing a
// chart going up.
//
// Sweeps Alpha Vantage's CASH_FLOW endpoint (quarterly, capitalExpenditures)
// across the full S&P 500 — ~503 sequential calls, a single-statement sweep
// like scheduled-fcf-yield-background.js, not the two-statement ~1006-call
// class that needs scheduled-margin-leverage-background.js's checkpoint/
// resume machinery. Revenue is NOT re-swept here: this job reads the same
// 28-quarter (~7 year) totalRevenue history scheduled-margin-leverage-
// background.js already keeps in its own checkpoint blob (each of its
// INCOME_STATEMENT calls already paid for that field), joined against this
// job's own capex quarters by fiscalDateEnding — the same shared-checkpoint
// reuse pattern scheduled-quality-financials-background.js uses, just
// against quarterly rows instead of annual ones. Run scheduled-margin-
// leverage-background at least once before this job.
//
// AI_COHORT below is a deliberately small, hand-picked set of companies
// whose capital spending is widely and specifically attributed in public
// reporting to AI/datacenter buildout — the four "hyperscalers" (Microsoft,
// Alphabet, Amazon, Meta) whose combined capex guidance is itself tracked
// as a market bellwether, Oracle (OCI's well-documented AI-driven capex
// ramp), and Micron (HBM memory fab capacity built specifically for AI
// accelerators). This is a judgment call, not an attempt at a complete or
// authoritative "AI stocks" list — chip designers with genuinely light
// capex of their own (Nvidia, Broadcom, AMD — mostly fabless) are
// deliberately left out because their *capex* isn't where the AI spending
// shows up, even though their revenue clearly is. See the page's own
// methodology section for the full caveat.
//
// One-time snapshot, no recurring schedule — matches the convention this
// site settled into for every page added since 2026-09-16 (see this
// function's own entry in netlify.toml). ~503 sequential CASH_FLOW calls
// at 1050ms spacing plus a retry pass.

const { getAiCapexStore, BLOB_KEY } = require("./ai-capex-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getMarginLeverageStore, CHECKPOINT_KEY } = require("./margin-leverage-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_NEEDED = 28; // ~7 years, matching scheduled-margin-leverage-background.js's own window so the join has maximum overlap
const NOTABLE_COUNT = 15;
const MIN_QUARTER_N = 40; // don't publish a market-aggregate calendar quarter built off fewer than this many companies
const MIN_COHORT_N = 4; // AI cohort is only 6 names — a quarter needs most of them present to be meaningful

const AI_COHORT = {
  MSFT: "Microsoft",
  GOOGL: "Alphabet",
  AMZN: "Amazon",
  META: "Meta Platforms",
  ORCL: "Oracle",
  MU: "Micron Technology",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on this endpoint — same gotcha guarded against in
// scheduled-fcf-yield-background.js and elsewhere in this codebase.
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

// Buckets a fiscal quarter-end date into the calendar quarter its month
// falls in — same convention (and same caveat about non-calendar fiscal
// years) as scheduled-margin-leverage-background.js's calendarQuarterKey.
function calendarQuarterKey(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

async function fetchQuarterlyCapex(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=CASH_FLOW&symbol=${symbol}&apikey=${apiKey}`,
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
    capitalExpenditures: num(r.capitalExpenditures),
  }));
}

// ---- Stats helpers — same methodology as /factor-analysis, duplicated
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

// Regresses a quarterly series' value against a plain 1..n quarter index,
// splits it into two equal-length halves (oldest half / most recent half —
// an even split, so neither side gets more statistical power than the
// other, the same equal-n discipline /factor-analysis's own subsample
// check settled on), and Chow-tests whether the trend (slope) differs
// between the two halves. Returns null if there isn't enough history for a
// meaningful split (needs at least 8 quarters, 4 per side).
function trendBreakTest(series) {
  const n = series.length;
  if (n < 8) return null;
  const half = Math.floor(n / 2);
  const idx = series.map((_, i) => i + 1);
  const vals = series.map((s) => s.capexIntensity);
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
  console.log(`scheduled-ai-capex-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmMeta = await getBeeswarmStore().get(META_KEY, { type: "json" });
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};

    const checkpoint = await getMarginLeverageStore().get(CHECKPOINT_KEY, { type: "json" });
    if (!checkpoint || !checkpoint.results) {
      throw new Error("margin-leverage checkpoint not populated. Run scheduled-margin-leverage-background first (it collects the revenue history this job joins against)");
    }
    const revenueResults = checkpoint.results;

    const capexResults = new Map(); // symbol -> quarters (most-recent-first)

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchQuarterlyCapex(apiKey, symbol);
        if (quarters.length >= 8) capexResults.set(symbol, quarters);
        return true;
      } catch (err) {
        console.error(`scheduled-ai-capex-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-ai-capex-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-ai-capex-background: fetched capex for ${capexResults.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (capexResults.size === 0) throw new Error("Every ticker failed. Refusing to write an empty snapshot");

    // ---- Join capex against the margin-leverage checkpoint's revenue
    // history by exact fiscalDateEnding, per company. ----
    const companyQuarters = new Map(); // symbol -> [{ q, capex, revenue, capexIntensity }] ascending

    for (const [symbol, capexRows] of capexResults.entries()) {
      const rev = revenueResults[symbol];
      if (!rev || !Array.isArray(rev.income)) continue;
      const revByDate = new Map(rev.income.map((r) => [r.fiscalDateEnding, num(r.totalRevenue)]));

      const joined = [];
      for (const row of capexRows) {
        const revenue = revByDate.get(row.fiscalDateEnding);
        if (revenue === undefined || revenue === null || revenue <= 0) continue;
        if (row.capitalExpenditures === null) continue;
        joined.push({
          q: row.fiscalDateEnding,
          capex: row.capitalExpenditures,
          revenue,
          capexIntensity: round((row.capitalExpenditures / revenue) * 100, 3),
        });
      }
      joined.sort((a, b) => (a.q < b.q ? -1 : 1)); // ascending
      if (joined.length >= 8) companyQuarters.set(symbol, joined);
    }

    console.log(`scheduled-ai-capex-background: joined ${companyQuarters.size} tickers against margin-leverage revenue history`);
    if (companyQuarters.size === 0) throw new Error("No tickers joined against the margin-leverage revenue checkpoint");

    // ---- Per-company TTM summary (latest 4 quarters vs. the prior 4, a
    // TTM-over-TTM growth rate rather than a single noisy quarter). ----
    const companies = [];
    for (const [symbol, q] of companyQuarters.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      const latest4 = q.slice(-4);
      const ttmCapex = latest4.reduce((s, r) => s + r.capex, 0);
      const ttmRevenue = latest4.reduce((s, r) => s + r.revenue, 0);
      const capexIntensity = round((ttmCapex / ttmRevenue) * 100, 3);

      let yoyCapexGrowth = null, yoyRevenueGrowth = null;
      if (q.length >= 8) {
        const prior4 = q.slice(-8, -4);
        const priorCapex = prior4.reduce((s, r) => s + r.capex, 0);
        const priorRevenue = prior4.reduce((s, r) => s + r.revenue, 0);
        if (priorCapex > 0) yoyCapexGrowth = round(((ttmCapex - priorCapex) / priorCapex) * 100, 2);
        if (priorRevenue > 0) yoyRevenueGrowth = round(((ttmRevenue - priorRevenue) / priorRevenue) * 100, 2);
      }

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        isAiCohort: !!AI_COHORT[symbol],
        ttmCapex: Math.round(ttmCapex),
        ttmRevenue: Math.round(ttmRevenue),
        capexIntensity,
        yoyCapexGrowth,
        yoyRevenueGrowth,
        quarterCount: q.length,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both capex and revenue history and sector metadata");

    // ---- Aggregate quarterly series: full market, AI cohort, rest of
    // market. One point per calendar quarter (sum capex / sum revenue
    // across whichever companies have that quarter, not a ~500-way
    // pseudo-replicated panel) — same aggregation discipline as
    // /margin-leverage and /small-cap-vs-large-cap.js's regime buckets. ----
    function buildAggregateSeries(symbols) {
      const byQuarter = new Map(); // calendarQuarterKey -> { capex, revenue, n }
      for (const symbol of symbols) {
        const q = companyQuarters.get(symbol);
        if (!q) continue;
        for (const row of q) {
          const ck = calendarQuarterKey(row.q);
          const acc = byQuarter.get(ck) || { capex: 0, revenue: 0, n: 0 };
          acc.capex += row.capex;
          acc.revenue += row.revenue;
          acc.n += 1;
          byQuarter.set(ck, acc);
        }
      }
      return [...byQuarter.entries()]
        .map(([q, acc]) => ({ q, totalCapex: Math.round(acc.capex), totalRevenue: Math.round(acc.revenue), capexIntensity: round((acc.capex / acc.revenue) * 100, 3), n: acc.n }))
        .sort((a, b) => (a.q < b.q ? -1 : 1));
    }

    const marketSymbols = [...companyQuarters.keys()];
    const cohortSymbols = marketSymbols.filter((s) => AI_COHORT[s]);
    const restSymbols = marketSymbols.filter((s) => !AI_COHORT[s]);

    const marketSeriesRaw = buildAggregateSeries(marketSymbols).filter((r) => r.n >= MIN_QUARTER_N);
    const cohortSeriesRaw = buildAggregateSeries(cohortSymbols).filter((r) => r.n >= MIN_COHORT_N);
    const restSeriesRaw = buildAggregateSeries(restSymbols).filter((r) => r.n >= MIN_QUARTER_N);

    // Trim each series' partial leading/trailing quarters (thin coverage
    // right at the edges of the 28-quarter window) by keeping the longest
    // run of consecutive calendar quarters.
    function longestRun(series) {
      if (series.length < 2) return series;
      let best = [series[0]], cur = [series[0]];
      for (let i = 1; i < series.length; i++) {
        const [py, pq] = series[i - 1].q.split("-Q").map(Number);
        const [cy, cq] = series[i].q.split("-Q").map(Number);
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

    // ---- Cross-sectional test: does elevated capex growth show up
    // alongside revenue growth, or is spending running ahead of
    // monetization? Pearson+Spearman on TTM YoY capex growth vs. TTM YoY
    // revenue growth, full index. ----
    const growthPairs = companies.filter((c) => c.yoyCapexGrowth !== null && c.yoyRevenueGrowth !== null);
    const scatter = growthPairs.map((c) => ({ symbol: c.symbol, sector: c.sector, isAiCohort: c.isAiCohort, yoyCapexGrowth: c.yoyCapexGrowth, yoyRevenueGrowth: c.yoyRevenueGrowth }));
    let growthTest = null;
    if (growthPairs.length >= 8) {
      const xs = growthPairs.map((c) => c.yoyCapexGrowth);
      const ys = growthPairs.map((c) => c.yoyRevenueGrowth);
      const pearson = linearRegression(xs, ys);
      const spear = spearmanRegression(xs, ys);
      growthTest = {
        pearson: { n: pearson.n, r: round(pearson.r, 3), r2: round(pearson.r2, 3), slope: round(pearson.slope, 4), t: round(pearson.t, 2), p: pearson.p },
        spearman: { n: spear.n, r: round(spear.r, 3), r2: round(spear.r2, 3), slope: round(spear.slope, 4), t: round(spear.t, 2), p: spear.p },
      };
    }

    // ---- Sector cross-section (latest common quarter of TTM figures). ----
    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      return {
        sector,
        count: inSector.length,
        avgCapexIntensity: round(mean(inSector.map((c) => c.capexIntensity)), 3),
        avgYoyCapexGrowth: round(mean(inSector.map((c) => c.yoyCapexGrowth)), 2),
      };
    }).filter(Boolean);

    // ---- Leaderboards ----
    const growthRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, isAiCohort: c.isAiCohort, yoyCapexGrowth: c.yoyCapexGrowth, capexIntensity: c.capexIntensity });
    const withGrowth = companies.filter((c) => c.yoyCapexGrowth !== null);
    const topGrowth = [...withGrowth].sort((a, b) => b.yoyCapexGrowth - a.yoyCapexGrowth).slice(0, NOTABLE_COUNT).map(growthRow);

    const intensityRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, isAiCohort: c.isAiCohort, capexIntensity: c.capexIntensity, ttmCapex: c.ttmCapex });
    const topIntensity = [...companies].sort((a, b) => b.capexIntensity - a.capexIntensity).slice(0, NOTABLE_COUNT).map(intensityRow);

    const spendRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, isAiCohort: c.isAiCohort, ttmCapex: c.ttmCapex, yoyCapexGrowth: c.yoyCapexGrowth });
    const topSpenders = [...companies].sort((a, b) => b.ttmCapex - a.ttmCapex).slice(0, NOTABLE_COUNT).map(spendRow);

    const market = {
      companyCount: companies.length,
      totalTtmCapex: companies.reduce((s, c) => s + c.ttmCapex, 0),
      avgCapexIntensity: round(mean(companies.map((c) => c.capexIntensity)), 3),
      avgYoyCapexGrowth: round(mean(companies.map((c) => c.yoyCapexGrowth)), 2),
      cohortTtmCapex: companies.filter((c) => c.isAiCohort).reduce((s, c) => s + c.ttmCapex, 0),
      cohortAvgYoyCapexGrowth: round(mean(companies.filter((c) => c.isAiCohort).map((c) => c.yoyCapexGrowth)), 2),
    };

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: companies.length,
      aiCohort: AI_COHORT,
      market,
      marketSeries,
      cohortSeries,
      restSeries,
      cohortTrendBreak,
      restTrendBreak,
      marketTrendBreak,
      growthTest,
      scatter,
      sectors,
      topGrowth,
      topIntensity,
      topSpenders,
      companies: companies.map((c) => ({
        symbol: c.symbol, name: c.name, sector: c.sector, isAiCohort: c.isAiCohort,
        ttmCapex: c.ttmCapex, capexIntensity: c.capexIntensity, yoyCapexGrowth: c.yoyCapexGrowth, yoyRevenueGrowth: c.yoyRevenueGrowth,
      })),
    };

    await getAiCapexStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-ai-capex-background: wrote ${companies.length} companies, market series ${marketSeries.length}q, cohort series ${cohortSeries.length}q`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-ai-capex-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
