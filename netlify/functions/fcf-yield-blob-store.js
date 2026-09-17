// Shared helper for opening the "fcf-yield" Netlify Blobs store, used by
// scheduled-fcf-yield-background.js (writes) and fcf-yield.js (reads).
// Mirrors pe-divergence-blob-store.js exactly — see breadth-blob-store.js
// for why the explicit siteID/token fallback is needed on this site
// (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "fcf-yield";
const BLOB_KEY = "snapshot.json";

function getFcfYieldStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getFcfYieldStore, BLOB_STORE, BLOB_KEY };
