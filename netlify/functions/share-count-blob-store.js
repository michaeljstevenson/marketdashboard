// Shared helper for opening the "share-count-trends" Netlify Blobs store,
// used by scheduled-share-count-background.js (writes) and
// share-count-trends.js (reads). Mirrors insider-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "share-count-trends";
const BLOB_KEY = "trends.json";

function getShareCountStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getShareCountStore, BLOB_STORE, BLOB_KEY };
