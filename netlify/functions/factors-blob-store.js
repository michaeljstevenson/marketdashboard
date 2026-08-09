// Shared helper for opening the "factors" Netlify Blobs store. Mirrors
// breadth-blob-store.js — see that file for why the explicit
// siteID/token fallback is needed on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "factors";
const BLOB_KEY = "daily.json";

function getFactorsStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getFactorsStore, BLOB_STORE, BLOB_KEY };
