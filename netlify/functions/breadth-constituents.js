// Sample of ~100 liquid S&P 500 constituents used to compute real market
// breadth internals (advance/decline, new highs/lows, % above 200-day SMA).
// Not the full index — a liquid, sector-diverse sample is a standard
// practical substitute when the full 500-name list isn't worth the API
// budget (each name costs one Alpha Vantage call per scheduled run).
// Shared by scheduled-breadth.js.

const BREADTH_CONSTITUENTS = [
  "AAPL", "MSFT", "AMZN", "NVDA", "GOOGL", "GOOG", "META", "BRK.B", "AVGO", "TSLA",
  "JPM", "LLY", "V", "UNH", "XOM", "MA", "PG", "COST", "HD", "MRK",
  "ABBV", "CVX", "PEP", "KO", "ADBE", "WMT", "BAC", "CRM", "MCD", "TMO",
  "ACN", "CSCO", "NFLX", "ABT", "LIN", "AMD", "DHR", "WFC", "DIS", "TXN",
  "PM", "VZ", "CMCSA", "INTU", "COP", "AMGN", "NEE", "IBM", "UNP", "RTX",
  "LOW", "HON", "SPGI", "QCOM", "BA", "CAT", "GE", "ELV", "PFE", "AMAT",
  "DE", "SBUX", "PLD", "ISRG", "BKNG", "GS", "MDT", "BLK", "T", "ADI",
  "GILD", "MS", "TJX", "AXP", "C", "LRCX", "VRTX", "MMC", "SYK", "SCHW",
  "REGN", "ADP", "CB", "ETN", "PGR", "MU", "ZTS", "BSX", "CI", "SO",
  "PANW", "FI", "BDX", "MO", "APD", "DUK", "ITW", "SLB", "EOG", "CME",
];

module.exports = { BREADTH_CONSTITUENTS };
