// Scheduled Background Function (see [functions."scheduled-quality-
// financials-background"] in netlify.toml) — stage 1 of 2 for the Financial
// Quality Screener (Piotroski F-Score) page. Sweeps Alpha Vantage's
// BALANCE_SHEET and INCOME_STATEMENT endpoints (annual reports) across the
// full S&P 500 and writes each company's last two fiscal years of raw
// figures to Netlify Blobs. scheduled-quality-score-background.js (stage 2)
// separately sweeps CASH_FLOW, joins it against this blob, and computes the
// actual F-Score.
//
// Why two jobs instead of one three-statement sweep: a Piotroski F-Score
// needs BALANCE_SHEET + INCOME_STATEMENT + CASH_FLOW, i.e. 3 calls/company
// (~1509 total) — at the ~750ms/call pacing scheduled-margin-leverage-
// background.js already found necessary for a 2-statement (~1006-call)
// sweep to fit inside a Background Function's ~15-minute ceiling, 1509
// calls would run ~18.9 minutes with zero room for a retry pass, i.e.
// wouldn't fit at all. Splitting into a 2-statement job (this one, same
// ~1006-call/750ms shape as margin-leverage) and a 1-statement job (stage 2,
// ~503 calls) keeps each comfortably inside the ceiling.
//
// Piotroski's original methodology compares fiscal year T against T-1 using
// *ending* balance-sheet figures (not average-of-T-and-T-1, which would
// need a third year, T-2, that a two-year pull doesn't have) — see this
// job's own field-selection comments below, and the page's methodology
// blurb for the explicit callout of this simplification.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than
// paying for a third ~503-call OVERVIEW sweep just for labels — same
// pattern as scheduled-margin-leverage-background.js.
//
// One-time snapshot, no recurring schedule (see this function's own
// netlify.toml comment) — matches every other full-index sweep added to
// this site since 2026-09-16: run manually via the Netlify dashboard's
// "Run now" whenever a fresh snapshot is wanted, not on an ongoing cadence.

const { getQualityFinancialsStore, BLOB_KEY } = require("./quality-financials-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Same 750ms pacing scheduled-margin-leverage-background.js uses for its own
// ~1006-call, 2-statement sweep — proven to fit inside the ~15-minute
// Background Function ceiling with room for a short retry pass.
const CALL_SLEEP_MS = 750;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchAnnual(apiKey, fn, symbol) {
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
  const rows = payload.annualReports;
  if (!Array.isArray(rows)) throw new Error(`${fn} unexpected response shape for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  return rows.slice(0, 2); // most-recent-first: [T, T-1]
}

// Long-term debt: prefer the direct longTermDebt field; some tickers only
// report longTermDebtNoncurrent instead. Deliberately not falling back to
// shortLongTermDebtTotal (that's total debt including the current portion,
// which would conflate the leverage signal with short-term financing).
function longTermDebtOf(bal) {
  return num(bal.longTermDebt) ?? num(bal.longTermDebtNoncurrent);
}

exports.handler = async () => {
  console.log(`scheduled-quality-financials-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = new Map(); // symbol -> { balance, income }

    async function fetchInto(symbol) {
      try {
        const balance = await fetchAnnual(apiKey, "BALANCE_SHEET", symbol);
        await sleep(CALL_SLEEP_MS);
        const income = await fetchAnnual(apiKey, "INCOME_STATEMENT", symbol);
        results.set(symbol, { balance, income });
        return true;
      } catch (err) {
        console.error(`scheduled-quality-financials-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-quality-financials-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(45000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(CALL_SLEEP_MS);
      }
      todo = missed;
    }

    console.log(`scheduled-quality-financials-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const tickers = {};
    for (const [symbol, { balance, income }] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      if (balance.length < 2 || income.length < 2) continue; // need two fiscal years for every year-over-year signal

      const [balT, balT1] = balance;
      const [incT, incT1] = income;
      if (balT.fiscalDateEnding !== incT.fiscalDateEnding || balT1.fiscalDateEnding !== incT1.fiscalDateEnding) {
        continue; // statements out of sync (e.g. a mid-sweep restatement) — skip rather than mismatch fiscal years
      }

      tickers[symbol] = {
        name: m.name || symbol,
        sector: m.sector,
        fiscalYearT: balT.fiscalDateEnding,
        fiscalYearT1: balT1.fiscalDateEnding,
        totalAssetsT: num(balT.totalAssets),
        totalAssetsT1: num(balT1.totalAssets),
        totalCurrentAssetsT: num(balT.totalCurrentAssets),
        totalCurrentAssetsT1: num(balT1.totalCurrentAssets),
        totalCurrentLiabilitiesT: num(balT.totalCurrentLiabilities),
        totalCurrentLiabilitiesT1: num(balT1.totalCurrentLiabilities),
        longTermDebtT: longTermDebtOf(balT),
        longTermDebtT1: longTermDebtOf(balT1),
        sharesOutstandingT: num(balT.commonStockSharesOutstanding),
        sharesOutstandingT1: num(balT1.commonStockSharesOutstanding),
        totalRevenueT: num(incT.totalRevenue),
        totalRevenueT1: num(incT1.totalRevenue),
        grossProfitT: num(incT.grossProfit),
        grossProfitT1: num(incT1.grossProfit),
        netIncomeT: num(incT.netIncome),
        netIncomeT1: num(incT1.netIncome),
      };
    }

    const tickerCount = Object.keys(tickers).length;
    if (!tickerCount) throw new Error("No tickers resolved with two-year statement history and sector metadata");

    await getQualityFinancialsStore().setJSON(BLOB_KEY, {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      tickers,
    });
    console.log(`scheduled-quality-financials-background: wrote ${tickerCount} companies' raw two-year financials`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, tickers: tickerCount }) };
  } catch (err) {
    console.error(`scheduled-quality-financials-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
