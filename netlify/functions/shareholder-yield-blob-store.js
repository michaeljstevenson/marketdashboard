// Shared helper for opening the "shareholder-yield" Netlify Blobs store,
// used by scheduled-shareholder-yield-background.js (writes) and
// shareholder-yield.js (reads). Mirrors dispersion-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "shareholder-yield";
const BLOB_KEY = "latest.json";

function getShareholderYieldStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getShareholderYieldStore, BLOB_STORE, BLOB_KEY };
