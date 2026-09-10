// Shared helper for the "concentration" Netlify Blobs store — written by
// scheduled-concentration-background.js, read by concentration-mag7.js.
// Same explicit siteID/token fallback as breadth-blob-store.js (getStore
// with no args fails on this site — see that file's note).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "concentration";
const BLOB_KEY = "mag7.json";

function getConcentrationStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getConcentrationStore, BLOB_STORE, BLOB_KEY };
