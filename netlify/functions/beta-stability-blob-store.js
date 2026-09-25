// Shared helper for opening the "beta-stability" Netlify Blobs store, used
// by scheduled-beta-stability-background.js (writes) and beta-stability.js
// (reads). Mirrors vol-risk-premium-blob-store.js — see breadth-blob-
// store.js for why the explicit siteID/token fallback is needed on this
// site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "beta-stability";
const BLOB_KEY = "beta-stability.json";

function getBetaStabilityStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getBetaStabilityStore, BLOB_STORE, BLOB_KEY };
