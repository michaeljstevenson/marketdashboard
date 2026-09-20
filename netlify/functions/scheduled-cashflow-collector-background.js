// Collector job: one Alpha Vantage CASH_FLOW sweep of the S&P 500, published
// to the shared av-collected store (see av-collector.js) for every job that
// reads cash flow: the last six years of quarterly operating cash flow,
// capex, net income and buyback spend, plus the last two annual reports.
// Manual for now (no schedule).

const { runCollector, pickFields } = require("./av-collector");

const AV_FUNCTION = "CASH_FLOW";

const QUARTERLY_KEYS = [
  "fiscalDateEnding", "operatingCashflow", "capitalExpenditures", "netIncome",
  "proceedsFromRepurchaseOfEquity", "paymentsForRepurchaseOfCommonStock", "paymentsForRepurchaseOfEquity",
];
const ANNUAL_KEYS = ["fiscalDateEnding", "operatingCashflow", "netIncome", "capitalExpenditures"];
const QUARTERS_KEPT = 24;
const ANNUAL_KEPT = 2;

// A response with neither report list is an error, so the symbol is retried.
function pick(payload) {
  if (!Array.isArray(payload.quarterlyReports) && !Array.isArray(payload.annualReports)) {
    throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);
  }
  return {
    quarterlyReports: (payload.quarterlyReports || []).slice(0, QUARTERS_KEPT).map((r) => pickFields(r, QUARTERLY_KEYS)),
    annualReports: (payload.annualReports || []).slice(0, ANNUAL_KEPT).map((r) => pickFields(r, ANNUAL_KEYS)),
  };
}

exports.handler = async () => runCollector({ kind: "cashflow", fn: AV_FUNCTION, pick });
