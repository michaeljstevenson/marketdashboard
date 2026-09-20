// Collector job: one Alpha Vantage EARNINGS_ESTIMATES sweep of the S&P 500,
// published to the shared av-collected store (see av-collector.js) for every
// job that reads analyst estimates: the fiscal-year rows only (consensus EPS
// high/low/average, how it moved over 7/30/90 days, analyst count and
// revision counts). Manual for now (no schedule).

const { runCollector, pickFields } = require("./av-collector");

const AV_FUNCTION = "EARNINGS_ESTIMATES";

const KEYS = [
  "date", "horizon", "eps_estimate_average", "eps_estimate_average_7_days_ago",
  "eps_estimate_average_30_days_ago", "eps_estimate_average_90_days_ago",
  "eps_estimate_high", "eps_estimate_low", "eps_estimate_analyst_count",
  "eps_estimate_revision_up_trailing_30_days", "eps_estimate_revision_down_trailing_30_days",
];

function pick(payload) {
  if (!Array.isArray(payload.estimates)) return null;
  const rows = payload.estimates.filter((e) => e.horizon === "fiscal year" && e.date);
  if (!rows.length) return null;
  return { estimates: rows.map((e) => pickFields(e, KEYS)) };
}

exports.handler = async () => runCollector({ kind: "estimates", fn: AV_FUNCTION, pick });
