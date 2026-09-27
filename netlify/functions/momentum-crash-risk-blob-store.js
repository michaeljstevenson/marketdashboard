// Shared helper for opening the "momentum-crash-risk" Netlify Blobs store,
// used by scheduled-momentum-crash-risk-background.js (writes) and
// momentum-crash-risk.js (reads). Mirrors buyback-timing-blob-store.js —
// see breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "momentum-crash-risk";
const BLOB_KEY = "latest.json";

function getMomentumCrashRiskStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getMomentumCrashRiskStore, BLOB_STORE, BLOB_KEY };
