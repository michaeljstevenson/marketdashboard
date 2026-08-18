// Shared helper for opening the "countries" Netlify Blobs store, used by
// scheduled-countries-background.js (writes) and country-performance.js
// (reads). Mirrors sector-blob-store.js — see that file for why the
// explicit siteID/token fallback is needed on this site (automatic
// context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "countries";
const BLOB_KEY = "performance.json";

function getCountryStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getCountryStore, BLOB_STORE, BLOB_KEY };
