// Shared helper for opening the "quality-lowvol" Netlify Blobs store, used
// by scheduled-quality-lowvol-background.js (writes) and
// quality-lowvol-factors.js (reads). Mirrors congressional-trading-blob-
// store.js — see breadth-blob-store.js for why the explicit siteID/token
// fallback is needed on this site (automatic context injection doesn't
// work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "quality-lowvol";
const BLOB_KEY = "snapshot.json";

function getQualityLowVolStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getQualityLowVolStore, BLOB_STORE, BLOB_KEY };
