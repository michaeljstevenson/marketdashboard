// Scheduled Background Function (see [functions."scheduled-dividend-
// coverage-background"] in netlify.toml) that sweeps Alpha Vantage's
// CASH_FLOW endpoint (quarterly) across the full S&P 500 for the Dividend
// Coverage & Cut Risk page.
//
// This page started life as a different proposed idea, "Buyback Timing
// Skill" (does heavier quarterly buyback spend predict better or worse
// subsequent stock performance — the Ikenberry/Lakonishok/Vermaelen 1995
// long-run-performance question). That idea was investigated first and
// deliberately not built — see this run's ROUTINE_BRIEF.md entry and PR
// description for the full duplication-check writeup. Short version: it
// would need per-company QUARTERLY buyback intensity joined against
// forward returns, but /buyback-effectiveness.html's own checkpoint blob
// (scheduled-buyback-effectiveness-background.js) discards each company's
// per-quarter figures after computing the TTM aggregate — only a market-
// wide cross-sectional quarterly median survives into the stored payload
// (see that file's own `companies.push(...)` vs. the final `payload.
// companies.map(...)` — `quarters` is dropped). Building the timing-skill
// test properly would need a brand-new ~503-call CASH_FLOW sweep that
// keeps full quarterly history AND a second, separate multi-year price
// sweep per company to compute forward returns from every historical
// quarter-end — roughly double the Alpha Vantage cost of any other single
// page on this site, for a page whose core question (does the market's
// buyback-timing behavior look smart or dumb) sits close enough to
// /buyback-effectiveness.html's own Fed-regime timing test that it reads
// more like a natural extension of that page than a clearly separate one
// — and this routine's boundaries say not to modify that page.
//
// Pivoted instead to a genuinely different capital-returns question no
// existing page asks: is the dividend actually safe? /dividend-growth-
// screener.html tracks streak/CAGR (has it grown), /shareholder-yield.html
// tracks combined yield magnitude (how much), neither asks whether the
// cash to keep paying it is really there. This page compares two payout
// ratios computed from the *same* CASH_FLOW TTM window: an earnings-based
// ratio (dividends / net income — the "accounting" view) and a free-cash-
// flow-based ratio (dividends / (operating cash flow - capex) — the "can
// they actually afford it" view). A wide gap between the two, or an FCF
// ratio above 100%, is the accruals-style "reported profit isn't showing
// up as real cash" signal (see /accruals.html, this same session's first
// page) applied specifically to dividend sustainability rather than
// earnings quality in general.
//
// Single-endpoint sweep (~503 calls, no checkpoint needed — same pattern
// as scheduled-buyback-effectiveness-background.js and scheduled-rd-
// intensity-background.js), unlike the two-statement sweeps ROIC vs. Cost
// of Capital/Cash Conversion Cycle/Accruals needed. One-time snapshot, no
// recurring schedule — matches the convention this site has settled into
// for every page added since 2026-09-16. Reuses Sector Beeswarm's own
// weekly meta.json for company name/sector, and optionally reads (not
// writes) Relative Strength Leaders/Laggards' own latest.json for the
// payout-ratio-vs-relative-return test, with a graceful fallback if that
// blob isn't populated yet.

const { getDividendCoverageStore, BLOB_KEY } = require("./dividend-coverage-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_NEEDED = 4; // TTM only — this page doesn't need a longer lookback
const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3;

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
// this codebase (e.g. scheduled-buyback-effectiveness-background.js's own
// num()).
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

async function fetchQuarterlyCashFlow(apiKey, symbol) {
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

  // Alpha Vantage returns quarterlyReports most-recent-first already.
  return rows.slice(0, QUARTERS_NEEDED).map((r) => ({
    fiscalDateEnding: r.fiscalDateEnding,
    // dividendPayoutCommonStock is the field actually populated on every
    // real payer checked during design (JPM, AAPL, O); dividendPayout
    // (which also includes preferred dividends) is the fallback for the
    // rare filer where the common-stock-specific field is "None" but the
    // combined one isn't.
    dividendPayout: num(r.dividendPayoutCommonStock) ?? num(r.dividendPayout),
    netIncome: num(r.netIncome),
    operatingCashflow: num(r.operatingCashflow),
    capitalExpenditures: num(r.capitalExpenditures),
  }));
}

// Requires all 4 trailing quarters to carry netIncome/operatingCashflow/
// capitalExpenditures — without those a payout ratio can't be computed at
// all, so a partial window is excluded rather than summed over gaps.
// dividendPayout itself is treated as 0 in any quarter it's missing (same
// "missing means no repurchase that quarter" convention buybackSpendOf()
// uses in scheduled-buyback-effectiveness-background.js) — a company with
// zero reported dividend payout across all 4 quarters is a non-payer, and
// is dropped from this dividend-focused page entirely rather than shown
// with a meaningless 0% payout ratio.
function computeCompanyMetrics(quarters) {
  if (quarters.length < QUARTERS_NEEDED) return null;
  const last4 = quarters.slice(0, QUARTERS_NEEDED);

  if (last4.some((q) => q.netIncome === null || q.operatingCashflow === null || q.capitalExpenditures === null)) return null;

  const ttmDividendPayout = last4.reduce((s, q) => s + (q.dividendPayout || 0), 0);
  if (ttmDividendPayout <= 0) return null; // not a dividend payer over the trailing year

  const ttmNetIncome = last4.reduce((s, q) => s + q.netIncome, 0);
  const ttmOperatingCashflow = last4.reduce((s, q) => s + q.operatingCashflow, 0);
  const ttmCapex = last4.reduce((s, q) => s + q.capitalExpenditures, 0);
  const ttmFcf = ttmOperatingCashflow - ttmCapex;

  const earningsPayoutRatio = ttmNetIncome > 0 ? (ttmDividendPayout / ttmNetIncome) * 100 : null;
  const fcfPayoutRatio = ttmFcf > 0 ? (ttmDividendPayout / ttmFcf) * 100 : null;
  const coverageGap = earningsPayoutRatio !== null && fcfPayoutRatio !== null ? fcfPayoutRatio - earningsPayoutRatio : null;

  return {
    fiscalQuarter: last4[0].fiscalDateEnding,
    ttmDividendPayout, ttmNetIncome, ttmFcf,
    earningsPayoutRatio, fcfPayoutRatio, coverageGap,
    negativeEarnings: ttmNetIncome <= 0,
    negativeFcf: ttmFcf <= 0,
  };
}

exports.handler = async () => {
  console.log(`scheduled-dividend-coverage-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let rel3MBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) if (c.rel3M !== null && c.rel3M !== undefined) rel3MBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-dividend-coverage-background: could not read relative-strength blob, continuing without the payout-vs-return test:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchQuarterlyCashFlow(apiKey, symbol);
        if (quarters.length >= QUARTERS_NEEDED) results.set(symbol, quarters);
        return true;
      } catch (err) {
        console.error(`scheduled-dividend-coverage-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-dividend-coverage-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-dividend-coverage-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, quarters] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const metrics = computeCompanyMetrics(quarters);
      if (!metrics) continue;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalQuarter: metrics.fiscalQuarter,
        ttmDividendPayout: Math.round(metrics.ttmDividendPayout),
        earningsPayoutRatio: round(metrics.earningsPayoutRatio),
        fcfPayoutRatio: round(metrics.fcfPayoutRatio),
        coverageGap: round(metrics.coverageGap),
        negativeEarnings: metrics.negativeEarnings,
        negativeFcf: metrics.negativeFcf,
        rel3M: rel3MBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved as dividend payers with usable CASH_FLOW history and sector metadata");

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianFcfPayoutRatio: round(median(inSector.map((c) => c.fcfPayoutRatio))),
          medianEarningsPayoutRatio: round(median(inSector.map((c) => c.earningsPayoutRatio))),
        };
      })
      .filter(Boolean);

    const withFcfRatio = companies.filter((c) => c.fcfPayoutRatio !== null);
    const overCoveredCount = withFcfRatio.filter((c) => c.fcfPayoutRatio > 100).length;

    const market = {
      companyCount: companies.length,
      medianFcfPayoutRatio: round(median(companies.map((c) => c.fcfPayoutRatio))),
      medianEarningsPayoutRatio: round(median(companies.map((c) => c.earningsPayoutRatio))),
      negativeFcfPayerCount: companies.filter((c) => c.negativeFcf).length,
      overCoveredCount, // fcfPayoutRatio > 100%, i.e. paying out more than trailing FCF
      overCoveredPct: withFcfRatio.length ? round((overCoveredCount / withFcfRatio.length) * 100, 1) : null,
    };

    const safestCoverage = [...withFcfRatio].sort((a, b) => a.fcfPayoutRatio - b.fcfPayoutRatio).slice(0, NOTABLE_COUNT);
    const mostStretched = [...withFcfRatio].sort((a, b) => b.fcfPayoutRatio - a.fcfPayoutRatio).slice(0, NOTABLE_COUNT);
    const widestGap = [...companies].filter((c) => c.coverageGap !== null).sort((a, b) => b.coverageGap - a.coverageGap).slice(0, NOTABLE_COUNT);

    const earningsVsFcfPairs = companies
      .filter((c) => c.earningsPayoutRatio !== null && c.fcfPayoutRatio !== null)
      .map((c) => ({ x: c.earningsPayoutRatio, y: c.fcfPayoutRatio, symbol: c.symbol, sector: c.sector }));

    const fcfVsRel3MPairs = hasRel3M
      ? withFcfRatio.filter((c) => c.rel3M !== null).map((c) => ({ x: c.fcfPayoutRatio, y: c.rel3M, symbol: c.symbol, sector: c.sector }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasRel3M,
      market,
      sectors,
      safestCoverage,
      mostStretched,
      widestGap,
      earningsVsFcfPairs,
      fcfVsRel3MPairs,
      companies,
    };

    await getDividendCoverageStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-dividend-coverage-background: wrote ${companies.length} dividend payers across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-dividend-coverage-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
