// Shared helper for opening the "analyst-price-targets" Netlify Blobs
// store, used by scheduled-analyst-price-targets-background.js (writes) and
// analyst-price-targets.js (reads). Mirrors equity-risk-premium-blob-store.js
// — see breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "analyst-price-targets";
const LATEST_KEY = "latest.json";

function getAnalystPriceTargetsStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getAnalystPriceTargetsStore, BLOB_STORE, LATEST_KEY };
