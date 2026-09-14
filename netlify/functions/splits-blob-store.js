// Shared helper for opening the "stock-splits" Netlify Blobs store, used by
// scheduled-splits-background.js (writes) and stock-splits.js (reads).
// Mirrors share-count-blob-store.js — see breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "stock-splits";
const BLOB_KEY = "splits.json";

function getSplitsStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSplitsStore, BLOB_STORE, BLOB_KEY };
