// Collector job: one Alpha Vantage EARNINGS sweep of the S&P 500, published
// to the shared av-collected store (see av-collector.js) for every job that
// reads earnings history: reported and estimated EPS and surprise by quarter
// (about the last ten years), plus the fiscal-year-end dates of the annual
// series. Runs monthly (see netlify.toml).

const { runCollector, pickFields } = require("./av-collector");

const AV_FUNCTION = "EARNINGS";

const QUARTERLY_KEYS = ["fiscalDateEnding", "reportedDate", "reportedEPS", "estimatedEPS", "surprise", "surprisePercentage"];
const QUARTERS_KEPT = 40;
const ANNUAL_KEPT = 30;

function pick(payload) {
  const quarterly = Array.isArray(payload.quarterlyEarnings) ? payload.quarterlyEarnings : [];
  const annual = Array.isArray(payload.annualEarnings) ? payload.annualEarnings : [];
  if (!quarterly.length && !annual.length) return null;
  return {
    quarterlyEarnings: quarterly.slice(0, QUARTERS_KEPT).map((q) => pickFields(q, QUARTERLY_KEYS)),
    annualEarnings: annual.slice(0, ANNUAL_KEPT).map((a) => pickFields(a, ["fiscalDateEnding"])),
  };
}

exports.handler = async () => runCollector({ kind: "earnings", fn: AV_FUNCTION, pick });
