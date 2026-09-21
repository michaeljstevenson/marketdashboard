// Scheduled Background Function (see [functions."scheduled-quality-score-
// background"] in netlify.toml) — stage 2 of 2 for the Financial Quality
// Screener (Piotroski F-Score) page. Sweeps Alpha Vantage's CASH_FLOW
// endpoint (annual reports, for operating cash flow) across the full S&P
// 500, joins it against scheduled-quality-financials-background.js's
// already-swept BALANCE_SHEET/INCOME_STATEMENT blob (stage 1 — must have
// already run at least once), computes the classic 9-signal Piotroski
// (2000) F-Score per company, and writes the final page payload.
//
// The F-Score (Piotroski, "Value Investing: The Use of Historical Financial
// Statement Information to Separate Winners from Losers," 2000) is 9 binary
// tests across profitability, leverage/liquidity, and operating efficiency,
// comparing the latest fiscal year (T) against the prior one (T-1):
//   Profitability:     1. ROA > 0        2. CFO > 0
//                       3. ΔROA > 0       4. CFO > net income (accrual quality)
//   Leverage/Liquidity: 5. Δ(LT debt/assets) < 0   6. Δcurrent ratio > 0
//                       7. no new shares issued (shares_T <= shares_T-1)
//   Operating eff.:     8. Δgross margin > 0        9. Δasset turnover > 0
// See computeFScore() below for the exact arithmetic, and the page's
// methodology blurb for the "ending assets, not average" simplification
// this two-fiscal-year data window requires (Piotroski's original paper
// uses average total assets for ROA, which needs a third year, T-2, that a
// two-year pull doesn't have).
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob, and — for a single-snapshot cross-sectional check of
// whether the market currently prices quality (does a higher F-Score
// coincide with stronger recent relative price performance?) — reads
// Relative Strength Leaders/Laggards' own latest.json for each company's
// 3-month relative return, with a graceful no-data fallback (same "read
// another page's blob, degrade gracefully if it's missing" pattern
// scheduled-earnings-growth-divergence-background.js uses). This is
// explicitly a concurrent association check, not a forward-return
// prediction — see the page's methodology section.
//
// ~503 sequential CASH_FLOW calls, 1050ms apart with a retry pass — same
// pacing proven at this scale by scheduled-share-count-background.js's
// BALANCE_SHEET sweep.
//
// One-time snapshot, no recurring schedule (see this function's own
// netlify.toml comment) — matches every other full-index sweep added to
// this site since 2026-09-16.

const { getQualityFinancialsStore, BLOB_KEY: FINANCIALS_KEY } = require("./quality-financials-blob-store");
const { getQualityScoreStore, BLOB_KEY } = require("./quality-score-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LEADERBOARD_COUNT = 15;
const MIN_SECTOR_N = 3; // don't publish a sector median built off fewer than this many companies

const SIGNAL_LABELS = [
  { key: "roaPositive", label: "ROA positive" },
  { key: "cfoPositive", label: "CFO positive" },
  { key: "roaImproved", label: "ROA improved YoY" },
  { key: "accrualQuality", label: "CFO exceeds net income" },
  { key: "leverageDown", label: "Leverage decreased" },
  { key: "liquidityUp", label: "Current ratio improved" },
  { key: "noDilution", label: "No new shares issued" },
  { key: "marginUp", label: "Gross margin improved" },
  { key: "turnoverUp", label: "Asset turnover improved" },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchAnnualCashflow(apiKey, symbol) {
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
  const rows = payload.annualReports;
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  return rows.slice(0, 2); // [T, T-1]
}

// Computes the 9-signal Piotroski F-Score for one company. Returns null if
// any required field is missing (a company is scored out of 9 or not at
// all — a partial score wouldn't be comparable across companies). This
// naturally excludes most banks/insurers, whose balance sheets don't carry
// a conventional current-assets/current-liabilities split — a real
// consequence of applying a screener built for industrial/operating
// companies, not a hand-picked sector exclusion, and called out as such in
// the page's methodology section.
function computeFScore(f, cfoT, cfoT1) {
  const assetsT = f.totalAssetsT, assetsT1 = f.totalAssetsT1;
  const niT = f.netIncomeT, niT1 = f.netIncomeT1;
  const curAssetsT = f.totalCurrentAssetsT, curAssetsT1 = f.totalCurrentAssetsT1;
  const curLiabT = f.totalCurrentLiabilitiesT, curLiabT1 = f.totalCurrentLiabilitiesT1;
  const sharesT = f.sharesOutstandingT, sharesT1 = f.sharesOutstandingT1;
  const revT = f.totalRevenueT, revT1 = f.totalRevenueT1;
  const gpT = f.grossProfitT, gpT1 = f.grossProfitT1;

  if (
    !(assetsT > 0) || !(assetsT1 > 0) ||
    niT === null || niT1 === null ||
    cfoT === null || cfoT1 === null ||
    !(curAssetsT > 0) || !(curAssetsT1 > 0) || !(curLiabT > 0) || !(curLiabT1 > 0) ||
    !(sharesT > 0) || !(sharesT1 > 0) ||
    !(revT > 0) || !(revT1 > 0) || gpT === null || gpT1 === null
  ) {
    return null;
  }

  const ltDebtT = f.longTermDebtT ?? 0; // "None"/missing long-term debt reasonably means none, unlike a missing income-statement line
  const ltDebtT1 = f.longTermDebtT1 ?? 0;

  const roaT = niT / assetsT;
  const roaT1 = niT1 / assetsT1;
  const currentRatioT = curAssetsT / curLiabT;
  const currentRatioT1 = curAssetsT1 / curLiabT1;
  const leverageT = ltDebtT / assetsT;
  const leverageT1 = ltDebtT1 / assetsT1;
  const grossMarginT = gpT / revT;
  const grossMarginT1 = gpT1 / revT1;
  const turnoverT = revT / assetsT;
  const turnoverT1 = revT1 / assetsT1;

  const signals = {
    roaPositive: roaT > 0 ? 1 : 0,
    cfoPositive: cfoT > 0 ? 1 : 0,
    roaImproved: roaT > roaT1 ? 1 : 0,
    accrualQuality: cfoT > niT ? 1 : 0,
    leverageDown: leverageT < leverageT1 ? 1 : 0,
    liquidityUp: currentRatioT > currentRatioT1 ? 1 : 0,
    noDilution: sharesT <= sharesT1 ? 1 : 0,
    marginUp: grossMarginT > grossMarginT1 ? 1 : 0,
    turnoverUp: turnoverT > turnoverT1 ? 1 : 0,
  };

  const score = Object.values(signals).reduce((a, b) => a + b, 0);

  return {
    score,
    signals,
    roa: round(roaT * 100),
    roaChange: round((roaT - roaT1) * 100),
    cfoToNetIncome: round(niT !== 0 ? cfoT / niT : null),
    currentRatio: round(currentRatioT),
    leverage: round(leverageT * 100),
    grossMargin: round(grossMarginT * 100),
    assetTurnover: round(turnoverT),
  };
}

exports.handler = async () => {
  console.log(`scheduled-quality-score-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const financialsBlob = await getQualityFinancialsStore().get(FINANCIALS_KEY, { type: "json" });
    if (!financialsBlob || !financialsBlob.tickers || !Object.keys(financialsBlob.tickers).length) {
      throw new Error("quality-financials blob not populated, run scheduled-quality-financials-background first");
    }
    const financials = financialsBlob.tickers;

    let relativeStrengthBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relativeStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-quality-score-background: could not read relative-strength blob, continuing without it:", err.message);
    }
    const hasPriceData = Object.keys(relativeStrengthBySymbol).length > 0;

    // Only fetch CASH_FLOW for tickers stage 1 already has usable financials
    // for — no point spending an Alpha Vantage call on a ticker that'll be
    // excluded anyway for missing balance-sheet/income-statement fields.
    const candidates = Object.keys(financials);
    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const rows = await fetchAnnualCashflow(apiKey, symbol);
        if (rows.length === 2) {
          const cfoT = num(rows[0].operatingCashflow);
          const cfoT1 = num(rows[1].operatingCashflow);
          // Only usable if CASH_FLOW's own fiscal year-ends line up with
          // what stage 1 already recorded for this ticker.
          if (rows[0].fiscalDateEnding === financials[symbol].fiscalYearT &&
              rows[1].fiscalDateEnding === financials[symbol].fiscalYearT1) {
            results.set(symbol, { cfoT, cfoT1 });
          }
        }
        return true;
      } catch (err) {
        console.error(`scheduled-quality-score-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...candidates];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-quality-score-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-quality-score-background: fetched cash flow for ${results.size}/${candidates.length} candidates`);
    if (results.size === 0) throw new Error("Every CASH_FLOW fetch failed. Refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, { cfoT, cfoT1 }] of results.entries()) {
      const f = financials[symbol];
      const scored = computeFScore(f, cfoT, cfoT1);
      if (!scored) continue;
      companies.push({
        symbol,
        name: f.name,
        sector: f.sector,
        score: scored.score,
        signals: scored.signals,
        roa: scored.roa,
        roaChange: scored.roaChange,
        currentRatio: scored.currentRatio,
        leverage: scored.leverage,
        grossMargin: scored.grossMargin,
        assetTurnover: scored.assetTurnover,
        fiscalYear: f.fiscalYearT,
        rel3M: Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, symbol)
          ? relativeStrengthBySymbol[symbol]
          : null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with a computable F-Score");

    const distribution = Array.from({ length: 10 }, (_, score) => ({
      score,
      count: companies.filter((c) => c.score === score).length,
    }));

    const signalPassRates = SIGNAL_LABELS.map(({ key, label }) => ({
      key,
      label,
      passRate: round((companies.filter((c) => c.signals[key] === 1).length / companies.length) * 100, 1),
    }));

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianScore: round(median(inSector.map((c) => c.score)), 1),
          avgScore: round(mean(inSector.map((c) => c.score)), 2),
          highQualityPct: round((inSector.filter((c) => c.score >= 8).length / inSector.length) * 100, 1),
        };
      })
      .filter(Boolean);

    const ranked = [...companies].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    const market = {
      companyCount: companies.length,
      medianScore: round(median(companies.map((c) => c.score)), 1),
      avgScore: round(mean(companies.map((c) => c.score)), 2),
      highQualityPct: round((companies.filter((c) => c.score >= 8).length / companies.length) * 100, 1),
      lowQualityPct: round((companies.filter((c) => c.score <= 2).length / companies.length) * 100, 1),
    };

    const highQualityLeaders = ranked.filter((c) => c.score >= 8).slice(0, LEADERBOARD_COUNT);
    const lowQualityWatchlist = [...companies]
      .sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol))
      .filter((c) => c.score <= 3)
      .slice(0, LEADERBOARD_COUNT);

    const qualityVsMomentumPairs = hasPriceData
      ? companies.filter((c) => c.rel3M !== null).map((c) => ({ x: c.score, y: c.rel3M, symbol: c.symbol }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasPriceData,
      market,
      distribution,
      signalPassRates,
      sectors,
      highQualityLeaders,
      lowQualityWatchlist,
      qualityVsMomentumPairs,
      companies: ranked,
    };

    await getQualityScoreStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-quality-score-background: wrote ${companies.length} companies across ${sectors.length} sectors, median score ${market.medianScore}`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-quality-score-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
