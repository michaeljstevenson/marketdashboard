// Shared helper for opening the "short-sale-volume" Netlify Blobs store,
// used by scheduled-short-sale-volume-background.js (writes) and
// short-sale-volume.js (reads). Mirrors equity-risk-premium-blob-store.js —
// see breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "short-sale-volume";
const LATEST_KEY = "latest.json";

function getShortSaleVolumeStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getShortSaleVolumeStore, BLOB_STORE, LATEST_KEY };
