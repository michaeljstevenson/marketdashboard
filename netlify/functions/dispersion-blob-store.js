// Shared helper for opening the "analyst-dispersion" Netlify Blobs store,
// used by scheduled-dispersion-background.js (writes) and dispersion.js
// (reads). Mirrors revisions-blob-store.js — see breadth-blob-store.js for
// why the explicit siteID/token fallback is needed on this site (automatic
// context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "analyst-dispersion";
const LATEST_KEY = "latest.json";
const HISTORY_KEY = "history.json";

function getDispersionStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getDispersionStore, BLOB_STORE, LATEST_KEY, HISTORY_KEY };
