// Shared helper for opening the "buyback-effectiveness" Netlify Blobs store,
// used by scheduled-buyback-effectiveness-background.js (writes) and
// buyback-effectiveness.js (reads). Mirrors share-count-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "buyback-effectiveness";
const BLOB_KEY = "latest.json";

function getBuybackEffectivenessStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getBuybackEffectivenessStore, BLOB_STORE, BLOB_KEY };
