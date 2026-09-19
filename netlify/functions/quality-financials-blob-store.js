// Shared helper for opening the "quality-financials" Netlify Blobs store —
// an intermediate raw-data blob written by scheduled-quality-financials-
// background.js (BALANCE_SHEET + INCOME_STATEMENT sweep) and read by
// scheduled-quality-score-background.js, which joins it against its own
// CASH_FLOW sweep to compute the Piotroski F-Score. Split into two jobs
// because a combined 3-statement sweep (~1509 calls) doesn't fit inside a
// single Background Function's ~15-minute ceiling at a safe pacing — see
// scheduled-quality-financials-background.js for the full accounting.
//
// Mirrors margin-leverage-blob-store.js — see breadth-blob-store.js for why
// the explicit siteID/token fallback is needed on this site (automatic
// context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "quality-financials";
const BLOB_KEY = "quality-financials.json";

function getQualityFinancialsStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getQualityFinancialsStore, BLOB_STORE, BLOB_KEY };
