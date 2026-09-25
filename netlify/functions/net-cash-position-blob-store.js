// Shared helper for opening the "net-cash-position" Netlify Blobs store,
// used by scheduled-net-cash-position-background.js (writes) and
// net-cash-position.js (reads). Mirrors rd-intensity-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "net-cash-position";
const BLOB_KEY = "net-cash-position.json";

function getNetCashStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getNetCashStore, BLOB_STORE, BLOB_KEY };
