// Collector job: one Alpha Vantage BALANCE_SHEET sweep of the S&P 500,
// published to the shared av-collected store (see av-collector.js) for every
// job that reads balance sheets: seven years of quarterly reports and the
// last two annual reports, trimmed to the fields those jobs use.
// Manual for now (no schedule).

const { runCollector, pickFields } = require("./av-collector");

const AV_FUNCTION = "BALANCE_SHEET";

const KEYS = [
  "fiscalDateEnding", "totalAssets", "totalCurrentAssets", "totalLiabilities", "totalCurrentLiabilities",
  "totalShareholderEquity", "retainedEarnings", "commonStockSharesOutstanding",
  "cashAndCashEquivalentsAtCarryingValue", "cashAndShortTermInvestments",
  "shortLongTermDebtTotal", "shortTermDebt", "currentDebt", "longTermDebt", "longTermDebtNoncurrent",
];
const QUARTERS_KEPT = 28;
const ANNUAL_KEPT = 2;

function pick(payload) {
  if (!Array.isArray(payload.quarterlyReports) && !Array.isArray(payload.annualReports)) {
    throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);
  }
  return {
    quarterlyReports: (payload.quarterlyReports || []).slice(0, QUARTERS_KEPT).map((r) => pickFields(r, KEYS)),
    annualReports: (payload.annualReports || []).slice(0, ANNUAL_KEPT).map((r) => pickFields(r, KEYS)),
  };
}

exports.handler = async () => runCollector({ kind: "balance", fn: AV_FUNCTION, pick });
