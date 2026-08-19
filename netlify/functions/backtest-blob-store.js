// Shared helper for opening the "backtest-configs" Netlify Blobs store.
// Mirrors ticker-blob-store.js — see that file for why the explicit
// siteID/token fallback is needed on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "backtest-configs";
const BLOB_KEY = "saved.json";

function getBacktestStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getBacktestStore, BLOB_STORE, BLOB_KEY };
