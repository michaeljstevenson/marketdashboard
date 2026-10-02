// Shared helper for opening the "overnight-intraday" Netlify Blobs store,
// used by scheduled-overnight-background.js (writes) and overnight.js
// (reads). Mirrors smallcap-blob-store.js — see insider-blob-store.js for
// why the explicit siteID/token fallback is needed on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "overnight-intraday";
const BLOB_KEY = "overnight.json";

function getOvernightStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getOvernightStore, BLOB_STORE, BLOB_KEY };
