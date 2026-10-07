// Tickers S&P 500 members used at some month-end since October 2021, mapped
// to the symbol Yahoo serves the same company's full price history under
// today. Needed because the put/call snapshots keep the ticker of the day,
// and Yahoo has since given some old tickers to unrelated funds (FB is a
// 2025 ProShares ETF). Each target was checked to carry the company's 2021
// prices. Members with no such history (taken private, merged away) are left
// out of the forward-return study on the dates they can't be priced.
const TICKER_NOW = {
  ABC: "COR",
  ANTM: "ELV",
  BK: "BNY",
  BLL: "BALL",
  DISCA: "WBD",
  DISCK: "WBD",
  FB: "META",
  FBHS: "FBIN",
  FI: "FISV",
  FLT: "CPAY",
  GPS: "GAP",
  MMC: "MRSH",
  NLOK: "GEN",
  PEAK: "DOC",
  PKI: "RVTY",
  RE: "EG",
  WLTW: "WTW",
};

module.exports = { TICKER_NOW };
