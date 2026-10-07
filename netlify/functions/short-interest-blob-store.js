// Shared helper for the "short-interest" Netlify Blobs store: FINRA's
// twice-monthly short interest for S&P 500 members (one blob per settlement
// date) and the page payload built from them. Written by
// scheduled-short-interest-background.js, served by short-interest.js. See
// breadth-blob-store.js for why the explicit siteID/token fallback is needed
// on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "short-interest";
const INDEX_KEY = "index.json";
const LATEST_KEY = "latest.json";
const dateKey = (date) => `dates/${date}.json`;

function getShortInterestStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getShortInterestStore, BLOB_STORE, INDEX_KEY, LATEST_KEY, dateKey };
