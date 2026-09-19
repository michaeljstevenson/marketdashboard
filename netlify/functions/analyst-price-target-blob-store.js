// Shared helper for opening the "analyst-price-target" Netlify Blobs
// store, used by scheduled-analyst-price-target-background.js (writes)
// and analyst-price-target.js (reads). Mirrors sector-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "analyst-price-target";
const LATEST_KEY = "latest.json";
const HISTORY_KEY = "history.json";

function getPriceTargetStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getPriceTargetStore, BLOB_STORE, LATEST_KEY, HISTORY_KEY };
