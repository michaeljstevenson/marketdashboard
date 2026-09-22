// Shared helper for opening the "options-positioning" Netlify Blobs store,
// used by scheduled-options-positioning-background.js (writes) and
// options-positioning.js (reads). Mirrors pe-divergence-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "options-positioning";
const BLOB_KEY = "options-positioning.json";

function getOptionsPositioningStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getOptionsPositioningStore, BLOB_STORE, BLOB_KEY };
