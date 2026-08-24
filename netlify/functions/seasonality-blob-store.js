// Shared helper for opening the "seasonality" Netlify Blobs store, used by
// scheduled-seasonality-background.js (writes) and seasonality-history.js
// (reads). See breadth-blob-store.js for why siteID/token are passed
// explicitly instead of relying on getStore(name) alone.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "seasonality";
const BLOB_KEY = "stats.json";

function getSeasonalityStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSeasonalityStore, BLOB_STORE, BLOB_KEY };
