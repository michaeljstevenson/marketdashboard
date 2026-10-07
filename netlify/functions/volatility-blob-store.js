// Shared helper for opening the "volatility" Netlify Blobs store, used by
// scheduled-volatility-background.js (writes) and volatility.js (reads).
// Mirrors country-blob-store.js. See that file for why the explicit
// siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "volatility";
const BLOB_KEY = "history.json";

function getVolatilityStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getVolatilityStore, BLOB_STORE, BLOB_KEY };
