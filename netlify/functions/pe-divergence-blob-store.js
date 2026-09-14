// Shared helper for opening the "pe-divergence" Netlify Blobs store, used
// by scheduled-pe-divergence-background.js (writes) and pe-divergence.js
// (reads). Mirrors share-count-blob-store.js / splits-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "pe-divergence";
const BLOB_KEY = "snapshot.json";

function getPeDivergenceStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getPeDivergenceStore, BLOB_STORE, BLOB_KEY };
