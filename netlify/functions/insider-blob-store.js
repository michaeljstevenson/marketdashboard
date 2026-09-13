// Shared helper for opening the "insider-transactions" Netlify Blobs
// store, used by scheduled-insider-transactions-background.js (writes)
// and insider-transactions.js (reads). Mirrors sector-blob-store.js — see
// that file for why the explicit siteID/token fallback is needed on this
// site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "insider-transactions";
const BLOB_KEY = "insider.json";

function getInsiderStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getInsiderStore, BLOB_STORE, BLOB_KEY };
