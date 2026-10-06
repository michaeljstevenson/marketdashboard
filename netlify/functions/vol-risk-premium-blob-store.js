// Shared helper for opening the "vol-risk-premium" Netlify Blobs store, used
// by scheduled-vol-risk-premium-background.js (writes) and
// vol-risk-premium.js (reads). Mirrors rd-intensity-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "vol-risk-premium";
const BLOB_KEY = "vol-risk-premium.json";

function getVolRiskPremiumStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getVolRiskPremiumStore, BLOB_STORE, BLOB_KEY };
