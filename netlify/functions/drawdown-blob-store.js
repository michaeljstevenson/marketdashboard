// Shared helper for the "drawdown" Netlify Blobs store — written by
// scheduled-drawdown-background.js, read by drawdown-history.js. Same
// explicit siteID/token fallback as breadth-blob-store.js.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "drawdown";
const BLOB_KEY = "history.json";

function getDrawdownStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getDrawdownStore, BLOB_STORE, BLOB_KEY };
