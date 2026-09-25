// Shared helper for opening the "rsi-reversal" Netlify Blobs store, used by
// scheduled-rsi-reversal-background.js (writes) and rsi-reversal.js (reads).
// Mirrors relative-strength-blob-store.js — see breadth-blob-store.js for
// why the explicit siteID/token fallback is needed on this site (automatic
// context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "rsi-reversal";
const LATEST_KEY = "latest.json";
const HISTORY_KEY = "history.json";

function getRsiReversalStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getRsiReversalStore, BLOB_STORE, LATEST_KEY, HISTORY_KEY };
