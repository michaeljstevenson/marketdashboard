// Scheduled Background Function (see [functions."scheduled-rd-intensity-
// background"] in netlify.toml) that sweeps Alpha Vantage's
// INCOME_STATEMENT endpoint (quarterly) across the full S&P 500 for the
// R&D Intensity page: how much of revenue each company plows back into
// research & development, and whether that shows up in revenue growth or
// relative price performance. A single-endpoint sweep (~503 calls, no
// checkpoint needed — same pattern as scheduled-buyback-effectiveness-
// background.js, well within a single Background Function's ~15-minute
// ceiling), unlike ROIC vs. Cost of Capital's and Cash Conversion Cycle's
// two-statement sweeps.
//
// One-time snapshot, no recurring schedule — matches the convention this
// site has settled into for every page added since 2026-09-16.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob, same pattern as every other full-universe sweep in this
// codebase. Also does one optional, read-only cross-page read — Relative
// Strength Leaders/Laggards' own 3-month relative return — for this page's
// "does the market currently reward heavier R&D spenders" test, with a
// graceful fallback (the test just doesn't render) if that blob isn't
// populated yet.

const { getRdIntensityStore, BLOB_KEY } = require("./rd-intensity-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 8 quarters: the most recent 4 give this year's TTM revenue/R&D, the next
// 4 give the prior year's TTM revenue — a smoothed year-over-year growth
// figure rather than a single noisy quarter-over-quarter comparison.
const QUARTERS_NEEDED = 8;
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
// numeric field on several fundamentals endpoints — same gotcha guarded
// against elsewhere in this codebase (e.g. scheduled-margin-leverage-
// background.js's num() helper). For researchAndDevelopment specifically,
// "None" here is treated as "this company doesn't break out R&D at all"
// (most Financials, Real Estate, Utilities, and many retailers) rather
// than assumed to be a true zero — see computeCompanyMetrics() below.
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

async function fetchQuarterlyIncome(apiKey, symbol) {
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
  // Alpha Vantage returns quarterlyReports most-recent-first already.
  return rows.slice(0, QUARTERS_NEEDED).map((r) => ({
    fiscalDateEnding: r.fiscalDateEnding,
    totalRevenue: num(r.totalRevenue),
    researchAndDevelopment: num(r.researchAndDevelopment),
  }));
}

// Requires a clean 8-quarter window: the most recent 4 for this year's TTM
// revenue/R&D, the next 4 for the prior year's TTM revenue. A company that
// never reports R&D across all 8 quarters is excluded entirely (this page
// only screens R&D-reporting companies, mostly Information Technology,
// Health Care, and Communication Services — a real scope limitation of
// the metric itself, not a data-quality problem, flagged in the
// methodology). A company that reports it in some quarters but not others
// is also excluded, rather than silently treating the gaps as zero.
function computeCompanyMetrics(quarters) {
  if (quarters.length < 8) return null;
  const recent4 = quarters.slice(0, 4);
  const prior4 = quarters.slice(4, 8);

  if (recent4.some((q) => q.totalRevenue === null) || prior4.some((q) => q.totalRevenue === null)) return null;
  const ttmRevenue = recent4.reduce((s, q) => s + q.totalRevenue, 0);
  const ttmRevenuePriorYear = prior4.reduce((s, q) => s + q.totalRevenue, 0);
  if (ttmRevenue <= 0 || ttmRevenuePriorYear <= 0) return null;

  if (recent4.some((q) => q.researchAndDevelopment === null)) return null; // no R&D reported at all, or partial — excluded either way
  const ttmRnd = recent4.reduce((s, q) => s + q.researchAndDevelopment, 0);

  const rdIntensity = (ttmRnd / ttmRevenue) * 100;
  const revenueGrowthYoY = ((ttmRevenue - ttmRevenuePriorYear) / ttmRevenuePriorYear) * 100;

  return {
    fiscalQuarter: recent4[0].fiscalDateEnding,
    ttmRevenue, ttmRnd,
    rdIntensity, revenueGrowthYoY,
  };
}

exports.handler = async () => {
  console.log(`scheduled-rd-intensity-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
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
      console.error("scheduled-rd-intensity-background: could not read relative-strength blob, continuing without the R&D-vs-return test:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchQuarterlyIncome(apiKey, symbol);
        if (quarters.length >= 8) results.set(symbol, quarters);
        return true;
      } catch (err) {
        console.error(`scheduled-rd-intensity-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-rd-intensity-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-rd-intensity-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
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
        rdIntensity: round(metrics.rdIntensity),
        revenueGrowthYoY: round(metrics.revenueGrowthYoY),
        rel3M: rel3MBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable R&D history and sector metadata");

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianRdIntensity: round(median(inSector.map((c) => c.rdIntensity))),
          medianRevenueGrowth: round(median(inSector.map((c) => c.revenueGrowthYoY))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianRdIntensity: round(median(companies.map((c) => c.rdIntensity))),
      medianRevenueGrowth: round(median(companies.map((c) => c.revenueGrowthYoY))),
    };

    const rankedByIntensity = [...companies].sort((a, b) => b.rdIntensity - a.rdIntensity);
    const topSpenders = rankedByIntensity.slice(0, NOTABLE_COUNT);

    const rankedByGrowth = [...companies].sort((a, b) => b.revenueGrowthYoY - a.revenueGrowthYoY);
    const topGrowers = rankedByGrowth.slice(0, NOTABLE_COUNT);

    const intensityVsGrowthPairs = companies.map((c) => ({ x: c.rdIntensity, y: c.revenueGrowthYoY, symbol: c.symbol }));
    const intensityVsRel3MPairs = hasRel3M
      ? companies.filter((c) => c.rel3M !== null).map((c) => ({ x: c.rdIntensity, y: c.rel3M, symbol: c.symbol }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasRel3M,
      market,
      sectors,
      topSpenders,
      topGrowers,
      intensityVsGrowthPairs,
      intensityVsRel3MPairs,
      companies,
    };

    await getRdIntensityStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-rd-intensity-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-rd-intensity-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
