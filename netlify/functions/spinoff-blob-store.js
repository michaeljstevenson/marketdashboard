// Shared helper for opening the "spinoff-performance" Netlify Blobs store,
// used by scheduled-spinoff-background.js (writes) and
// spinoff-performance.js (reads). Mirrors share-count-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "spinoff-performance";
const BLOB_KEY = "spinoffs.json";

function getSpinoffStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSpinoffStore, BLOB_STORE, BLOB_KEY };
