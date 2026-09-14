// Shared helper for opening the "international-us" Netlify Blobs store,
// used by scheduled-international-background.js (writes) and
// international-us.js (reads). Mirrors smallcap-blob-store.js — see that
// file for why the explicit siteID/token fallback is needed on this site
// (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "international-us";
const BLOB_KEY = "international.json";

function getInternationalStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getInternationalStore, BLOB_STORE, BLOB_KEY };
