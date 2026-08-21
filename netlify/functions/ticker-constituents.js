// Curated list of ~150 of the largest US-listed companies by market cap,
// for the homepage ticker tape (see scheduled-ticker-background.js).
//
// Unlike breadth-constituents.js, this isn't pulled from a sourced
// dataset — there's no free live "rank by market cap" feed wired up, so
// this is a hand-curated list of well-known mega/large-cap names, built
// from general market knowledge as of 2026-08-09. It will drift out of
// date as rankings shift (a company growing into/out of the top ~150,
// M&A, spinoffs) with nothing keeping it current automatically — refresh
// periodically against a real market-cap ranking if precision matters.
// One ticker per company (no dual share classes) to keep this at exactly
// company-count, not ticker-count.

const TICKER_CONSTITUENTS = [
  "AAPL", "ABBV", "ABT", "ACN", "ADBE", "ADI", "ADP", "AEP", "AIG", "AJG",
  "ALL", "AMAT", "AMD", "AME", "AMGN", "AMT", "AMZN", "ANET", "AON", "APD",
  "APH", "AVGO", "AXP", "AZO", "BA", "BAC", "BK", "BKNG", "BLK", "BMY",
  "BRK-B", "BSX", "C", "CAT", "CB", "CDNS", "CI", "CL", "CME", "CMG",
  "COF", "COP", "COST", "CRM", "CSCO", "CSX", "CTAS", "CVX", "DE", "DHR",
  "DIS", "ECL", "EMR", "EOG", "EQIX", "ETN", "FDX", "GD", "GE", "GILD",
  "GOOGL", "GS", "HCA", "HD", "HON", "IBM", "ICE", "INTU", "ISRG", "ITW",
  "JNJ", "JPM", "KLAC", "KMB", "KO", "LIN", "LLY", "LMT", "LOW", "LRCX",
  "MA", "MAR", "MCD", "MCO", "MDT", "META", "MMC", "MO", "MRK", "MS",
  "MSFT", "MSI", "MU", "NEE", "NFLX", "NKE", "NOC", "NOW", "NSC", "NVDA",
  "ORCL", "ORLY", "PANW", "PEP", "PFE", "PG", "PGR", "PH", "PLD", "PM",
  "PNC", "PSA", "PYPL", "QCOM", "REGN", "RTX", "SBUX", "SCHW", "SHW", "SLB",
  "SNPS", "SO", "SPGI", "SYK", "T", "TFC", "TJX", "TMO", "TMUS", "TRV",
  "TSLA", "TT", "TXN", "UNH", "UNP", "UPS", "USB", "V", "VZ", "WFC",
  "WM", "WMT", "XOM", "YUM", "ZTS", "ADM", "CTVA", "DOW", "DUK", "VLO",
];

module.exports = { TICKER_CONSTITUENTS };
