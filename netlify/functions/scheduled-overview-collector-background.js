// Collector job: one Alpha Vantage OVERVIEW sweep of the S&P 500, published
// to the shared av-collected store (see av-collector.js) for every job that
// reads company overview fields: name, sector, share count, market cap,
// P/E, analyst targets and ratings, dividend yield, beta, 52-week range,
// 50/200-day moving averages, insider/institutional ownership, and the
// industry, EBITDA, EV/EBITDA, price/book and revenue fields behind the
// Valuations page. Runs monthly (see netlify.toml).

const { runCollector, pickFields } = require("./av-collector");

const AV_FUNCTION = "OVERVIEW";

const FIELDS = [
  "Symbol", "Name", "Sector", "SharesOutstanding", "MarketCapitalization",
  "TrailingPE", "PERatio", "ForwardPE", "QuarterlyEarningsGrowthYOY",
  "AnalystTargetPrice", "AnalystRatingStrongBuy", "AnalystRatingBuy", "AnalystRatingHold",
  "AnalystRatingSell", "AnalystRatingStrongSell", "DividendYield", "Beta",
  "52WeekHigh", "52WeekLow", "50DayMovingAverage", "200DayMovingAverage",
  "PercentInsiders", "PercentInstitutions",
  // For the Valuations page's S&P 500 multiples. CIK identifies a company
  // across share classes (GOOG/GOOGL), whose company-level figures repeat.
  "CIK", "Industry", "EBITDA", "EVToEBITDA", "PriceToBookRatio", "RevenueTTM",
];

// Alpha Vantage returns {} for an unrecognized or delisted symbol.
function pick(payload) {
  if (!payload.Symbol) return null;
  return pickFields(payload, FIELDS);
}

exports.handler = async () => runCollector({ kind: "overview", fn: AV_FUNCTION, pick });
