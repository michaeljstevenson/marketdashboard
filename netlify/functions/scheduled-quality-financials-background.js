// Scheduled Background Function (see [functions."scheduled-quality-
// financials-background"] in netlify.toml) — stage 1 of 2 for the Financial
// Quality Screener (Piotroski F-Score) page. Writes each company's last two
// fiscal years of raw balance-sheet and income-statement figures to Netlify
// Blobs. scheduled-quality-score-background.js (stage 2) separately sweeps
// CASH_FLOW, joins it against this blob, and computes the actual F-Score.
//
// Makes no Alpha Vantage calls of its own: it reads the annual reports that
// scheduled-margin-leverage-background.js already keeps in its checkpoint
// (each BALANCE_SHEET / INCOME_STATEMENT call returns quarterly and annual
// reports together), so both pages share one ~1006-call sweep instead of
// each paying for it. Run margin-leverage first; this job reads whatever
// that checkpoint holds, and marks the snapshot partial if the sweep is
// still mid-cycle.
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

const { getQualityFinancialsStore, BLOB_KEY } = require("./quality-financials-blob-store");
const { getMarginLeverageStore, CHECKPOINT_KEY } = require("./margin-leverage-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on several fundamentals endpoints — same gotcha guarded
// against elsewhere in this codebase (e.g. scheduled-margin-leverage-
// background.js's num() helper).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
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
    const checkpoint = await getMarginLeverageStore().get(CHECKPOINT_KEY, { type: "json" });
    if (!checkpoint || !checkpoint.results) {
      throw new Error("margin-leverage checkpoint not populated. Run scheduled-margin-leverage-background first (it collects the statements this job reads)");
    }
    const partial = !checkpoint.complete;

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = new Map(); // symbol -> { balance, income }
    for (const symbol of BREADTH_CONSTITUENTS) {
      const r = checkpoint.results[symbol];
      if (r && r.annualBalance && r.annualIncome) results.set(symbol, { balance: r.annualBalance, income: r.annualIncome });
    }

    console.log(`scheduled-quality-financials-background: read ${results.size}/${BREADTH_CONSTITUENTS.length} tickers from the margin-leverage checkpoint${partial ? " (sweep still mid-cycle)" : ""}`);
    if (results.size === 0) throw new Error("Checkpoint holds no annual statements, rerun scheduled-margin-leverage-background");

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

    const store = getQualityFinancialsStore();
    if (partial) {
      const published = await store.get(BLOB_KEY, { type: "json" });
      if (published && !published.partial) {
        console.log("scheduled-quality-financials-background: checkpoint is mid-cycle, keeping the last complete published snapshot");
        return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, published: false }) };
      }
    }
    await store.setJSON(BLOB_KEY, {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      partial,
      tickers,
    });
    console.log(`scheduled-quality-financials-background: wrote ${tickerCount} companies' raw two-year financials`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial, tickers: tickerCount }) };
  } catch (err) {
    console.error(`scheduled-quality-financials-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
