// Shared helper for opening the "golden-cross" Netlify Blobs store, used
// by scheduled-golden-cross-background.js (writes) and golden-cross.js
// (reads). Mirrors analyst-price-target-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "golden-cross";
const LATEST_KEY = "latest.json";

function getGoldenCrossStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getGoldenCrossStore, BLOB_STORE, LATEST_KEY };
