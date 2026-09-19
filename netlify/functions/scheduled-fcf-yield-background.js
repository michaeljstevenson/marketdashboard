// Scheduled Background Function (see [functions."scheduled-fcf-yield-
// background"] in netlify.toml) that sweeps Alpha Vantage's CASH_FLOW
// endpoint (quarterly) across the full S&P 500 for /fcf-yield.html — a
// bottom-up, stock-level complement to /valuations.html's industry-level
// Damodaran multiples (P/E, EV/EBITDA, P/B), and a genuinely different
// question from /equity-risk-premium.html's trailing-P/E-based earnings
// yield: does a company's reported earnings actually show up as cash?
//
// Free cash flow = operatingCashflow - capitalExpenditures, both read
// straight off the same CASH_FLOW quarterly report already proven out by
// scheduled-buyback-effectiveness-background.js (see that file's header
// comment for the "None"-vs-populated field gotchas on this endpoint —
// operatingCashflow, capitalExpenditures, and netIncome are all reliably
// populated across the mega-caps checked during design, unlike the
// buyback-specific fields that motivated that file's fallback chain).
//
// Earnings yield here is deliberately re-derived bottom-up (trailing net
// income / market cap) rather than reused from Equity Risk Premium's own
// OVERVIEW-based trailing P/E — the point of this page is comparing two
// yields computed the *same way* (both TTM dollars over the same market
// cap), so a FCF/earnings mismatch reflects a real cash-vs-accrual gap,
// not a methodology mismatch between two different pages' conventions.
//
// One-time snapshot, no recurring schedule — matches the convention this
// site settled into for every page added since 2026-09-16 (see this
// function's own entry in netlify.toml). ~503 sequential CASH_FLOW calls
// at 1050ms spacing plus a retry pass.

const { getFcfYieldStore, BLOB_KEY } = require("./fcf-yield-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const NOTABLE_COUNT = 15;
const MIN_YIELD_FOR_CONVERSION = 0.1; // % of market cap — below this, net income is too close to $0 for a conversion ratio to mean anything

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
// scheduled-buyback-effectiveness-background.js and elsewhere in this
// codebase.
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

  // Alpha Vantage returns quarterlyReports most-recent-first already. Only
  // the most recent 4 (a trailing-twelve-month window) are needed here,
  // unlike the buyback page's longer history for its quarterly time series.
  return rows.slice(0, 4).map((r) => ({
    fiscalDateEnding: r.fiscalDateEnding,
    operatingCashflow: num(r.operatingCashflow),
    capitalExpenditures: num(r.capitalExpenditures),
    netIncome: num(r.netIncome),
  }));
}

exports.handler = async () => {
  console.log(`scheduled-fcf-yield-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmMeta = await getBeeswarmStore().get(META_KEY, { type: "json" });
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchQuarterlyCashFlow(apiKey, symbol);
        if (quarters.length >= 4) results.set(symbol, quarters);
        return true;
      } catch (err) {
        console.error(`scheduled-fcf-yield-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-fcf-yield-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-fcf-yield-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, quarters] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      const haveAll4 = quarters.every((q) => q.operatingCashflow !== null && q.capitalExpenditures !== null && q.netIncome !== null);
      if (!haveAll4) continue; // a genuine data gap, not approximated

      const ttmOperatingCashflow = quarters.reduce((s, q) => s + q.operatingCashflow, 0);
      const ttmCapex = quarters.reduce((s, q) => s + q.capitalExpenditures, 0);
      const ttmFcf = ttmOperatingCashflow - ttmCapex;
      const ttmNetIncome = quarters.reduce((s, q) => s + q.netIncome, 0);

      const marketCap = m.marketCap;
      if (!marketCap || marketCap <= 0) continue;

      const fcfYield = round((ttmFcf / marketCap) * 100, 3);
      const earningsYield = round((ttmNetIncome / marketCap) * 100, 3);
      const capexIntensity = ttmOperatingCashflow > 0 ? round((ttmCapex / ttmOperatingCashflow) * 100) : null;
      const fcfConversion = ttmNetIncome > 0 && earningsYield >= MIN_YIELD_FOR_CONVERSION
        ? round((ttmFcf / ttmNetIncome) * 100)
        : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        ttmFcf: Math.round(ttmFcf),
        ttmNetIncome: Math.round(ttmNetIncome),
        fcfYield,
        earningsYield,
        capexIntensity,
        fcfConversion,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both CASH_FLOW history and sector metadata");

    // ---- Market + sector aggregates ----
    const market = {
      companyCount: companies.length,
      avgFcfYield: round(mean(companies.map((c) => c.fcfYield)), 3),
      avgEarningsYield: round(mean(companies.map((c) => c.earningsYield)), 3),
      avgCapexIntensity: round(mean(companies.map((c) => c.capexIntensity))),
      avgFcfConversion: round(mean(companies.map((c) => c.fcfConversion))),
    };

    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      return {
        sector,
        count: inSector.length,
        avgFcfYield: round(mean(inSector.map((c) => c.fcfYield)), 3),
        avgEarningsYield: round(mean(inSector.map((c) => c.earningsYield)), 3),
        avgCapexIntensity: round(mean(inSector.map((c) => c.capexIntensity))),
        avgFcfConversion: round(mean(inSector.map((c) => c.fcfConversion))),
      };
    }).filter(Boolean);

    // ---- Cross-sectional test: does FCF yield track earnings yield, or
    // do they diverge? Pearson+Spearman, same convention as every other
    // page on this site. ----
    const scatter = companies
      .filter((c) => c.fcfYield !== null && c.earningsYield !== null)
      .map((c) => ({ symbol: c.symbol, sector: c.sector, fcfYield: c.fcfYield, earningsYield: c.earningsYield }));

    // ---- Leaderboards ----
    const yieldRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, fcfYield: c.fcfYield, earningsYield: c.earningsYield });
    const topFcfYield = [...companies].sort((a, b) => b.fcfYield - a.fcfYield).slice(0, NOTABLE_COUNT).map(yieldRow);

    const conversionRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, fcfConversion: c.fcfConversion, earningsYield: c.earningsYield });
    const withConversion = companies.filter((c) => c.fcfConversion !== null);
    const lowestConversion = [...withConversion].sort((a, b) => a.fcfConversion - b.fcfConversion).slice(0, NOTABLE_COUNT).map(conversionRow);
    const highestConversion = [...withConversion].sort((a, b) => b.fcfConversion - a.fcfConversion).slice(0, NOTABLE_COUNT).map(conversionRow);

    const gapRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, fcfYield: c.fcfYield, earningsYield: c.earningsYield, gap: round(c.fcfYield - c.earningsYield, 2) });
    const withGap = companies.filter((c) => c.fcfYield !== null && c.earningsYield !== null);
    const biggestPositiveGap = [...withGap].sort((a, b) => (b.fcfYield - b.earningsYield) - (a.fcfYield - a.earningsYield)).slice(0, NOTABLE_COUNT).map(gapRow);
    const biggestNegativeGap = [...withGap].sort((a, b) => (a.fcfYield - a.earningsYield) - (b.fcfYield - b.earningsYield)).slice(0, NOTABLE_COUNT).map(gapRow);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      market,
      sectors,
      scatter,
      topFcfYield,
      lowestConversion,
      highestConversion,
      biggestPositiveGap,
      biggestNegativeGap,
      companies: companies.map((c) => ({
        symbol: c.symbol, name: c.name, sector: c.sector,
        ttmFcf: c.ttmFcf, fcfYield: c.fcfYield, earningsYield: c.earningsYield,
        capexIntensity: c.capexIntensity, fcfConversion: c.fcfConversion,
      })),
    };

    await getFcfYieldStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-fcf-yield-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-fcf-yield-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
