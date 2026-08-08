// Shared helper for opening the "sectors" Netlify Blobs store, used by
// scheduled-sectors-background.js (writes) and sector-performance.js
// (reads). Mirrors breadth-blob-store.js — see that file for why the
// explicit siteID/token fallback is needed on this site (automatic
// context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "sectors";
const BLOB_KEY = "performance.json";

function getSectorStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSectorStore, BLOB_STORE, BLOB_KEY };
