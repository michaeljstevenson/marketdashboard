// Canonical sector taxonomy for the sector-beeswarm page, shared by the
// annual (sector-ETF) and daily (individual-company) backend jobs.
//
// The 11 GICS sectors, in the left-to-right column order used on the page
// (which matches the order in the Chartfleau reference: broadly ascending
// by column population / descending by cyclicality isn't the point — it's
// just a fixed, familiar order).

const SECTOR_ORDER = [
  "Energy",
  "Industrials",
  "Health Care",
  "Consumer Staples",
  "Information Technology",
  "Materials",
  "Financials",
  "Consumer Discretionary",
  "Communication Services",
  "Real Estate",
  "Utilities",
];

// The SPDR Select Sector ETF for each canonical sector. These are what the
// annual view plots (one bubble per ETF per year). XLRE began trading in
// Oct 2015 and XLC in Jun 2018 — earlier years simply omit those bubbles
// (handled in the annual job by dropping years with no full-year data).
const SECTOR_ETF = {
  Energy: "XLE",
  Industrials: "XLI",
  "Health Care": "XLV",
  "Consumer Staples": "XLP",
  "Information Technology": "XLK",
  Materials: "XLB",
  Financials: "XLF",
  "Consumer Discretionary": "XLY",
  "Communication Services": "XLC",
  "Real Estate": "XLRE",
  Utilities: "XLU",
};

// Alpha Vantage's OVERVIEW endpoint returns a free-text "Sector" field that
// is neither GICS-canonical nor stable in casing ("TECHNOLOGY", "FINANCIAL
// SERVICES", "CONSUMER CYCLICAL", ...). Normalize it to one of SECTOR_ORDER.
const OVERVIEW_SECTOR_MAP = {
  "TECHNOLOGY": "Information Technology",
  "INFORMATION TECHNOLOGY": "Information Technology",
  "FINANCIAL SERVICES": "Financials",
  "FINANCIAL": "Financials",
  "FINANCIALS": "Financials",
  "HEALTHCARE": "Health Care",
  "HEALTH CARE": "Health Care",
  "CONSUMER CYCLICAL": "Consumer Discretionary",
  "CONSUMER DISCRETIONARY": "Consumer Discretionary",
  "CONSUMER DEFENSIVE": "Consumer Staples",
  "CONSUMER STAPLES": "Consumer Staples",
  "COMMUNICATION SERVICES": "Communication Services",
  "COMMUNICATION": "Communication Services",
  "INDUSTRIALS": "Industrials",
  "ENERGY": "Energy",
  "UTILITIES": "Utilities",
  "REAL ESTATE": "Real Estate",
  "BASIC MATERIALS": "Materials",
  "MATERIALS": "Materials",
};

// A few index members are chronically missing or miscategorized in
// OVERVIEW (holding companies, recent spinoffs, dual classes). Hardcode
// their canonical sector so they still land in the right column.
const TICKER_SECTOR_OVERRIDE = {
  "GOOG": "Communication Services",
  "GOOGL": "Communication Services",
  "META": "Communication Services",
  "NFLX": "Communication Services",
  "BRK-B": "Financials",
  "FOX": "Communication Services",
  "FOXA": "Communication Services",
  "NWS": "Communication Services",
  "NWSA": "Communication Services",
  "TKO": "Communication Services",
  "WBD": "Communication Services",
  "AMZN": "Consumer Discretionary",
  "TSLA": "Consumer Discretionary",
  "ABNB": "Consumer Discretionary",
  "DASH": "Consumer Discretionary",
  "SW": "Materials",
  "AMCR": "Materials",
  "LYB": "Materials",
  "CTVA": "Materials",
  "KVUE": "Consumer Staples",
  "SOLV": "Health Care",
  "GEHC": "Health Care",
  "GEV": "Industrials",
  "VLTO": "Industrials",
  "HWM": "Industrials",
  "CARR": "Industrials",
  "OTIS": "Industrials",
  "PSKY": "Communication Services",
};

function normalizeSector(ticker, overviewSector) {
  if (TICKER_SECTOR_OVERRIDE[ticker]) return TICKER_SECTOR_OVERRIDE[ticker];
  if (!overviewSector) return null;
  const key = String(overviewSector).trim().toUpperCase();
  return OVERVIEW_SECTOR_MAP[key] || null;
}

module.exports = {
  SECTOR_ORDER,
  SECTOR_ETF,
  OVERVIEW_SECTOR_MAP,
  TICKER_SECTOR_OVERRIDE,
  normalizeSector,
};
