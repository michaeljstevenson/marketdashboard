// Collector job: one Alpha Vantage OVERVIEW sweep of the S&P 500, published
// to the shared av-collected store (see av-collector.js) for every job that
// reads company overview fields: name, sector, share count, market cap,
// P/E, analyst targets and ratings, dividend yield and beta. Manual for
// now (no schedule); the jobs that read it fail with a clear message until
// it has run once.

const { runCollector, pickFields } = require("./av-collector");

const AV_FUNCTION = "OVERVIEW";

const FIELDS = [
  "Symbol", "Name", "Sector", "SharesOutstanding", "MarketCapitalization",
  "TrailingPE", "PERatio", "ForwardPE", "QuarterlyEarningsGrowthYOY",
  "AnalystTargetPrice", "AnalystRatingStrongBuy", "AnalystRatingBuy", "AnalystRatingHold",
  "AnalystRatingSell", "AnalystRatingStrongSell", "DividendYield", "Beta",
];

// Alpha Vantage returns {} for an unrecognized or delisted symbol.
function pick(payload) {
  if (!payload.Symbol) return null;
  return pickFields(payload, FIELDS);
}

exports.handler = async () => runCollector({ kind: "overview", fn: AV_FUNCTION, pick });
