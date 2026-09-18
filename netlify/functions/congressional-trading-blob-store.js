// Shared helper for opening the "congressional-trading" Netlify Blobs
// store, used by scheduled-congressional-trading-background.js (writes)
// and congressional-trading.js (reads). Mirrors news-sentiment-blob-
// store.js — see breadth-blob-store.js for why the explicit siteID/token
// fallback is needed on this site (automatic context injection doesn't
// work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "congressional-trading";
const BLOB_KEY = "snapshot.json";

function getCongressionalTradingStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getCongressionalTradingStore, BLOB_STORE, BLOB_KEY };
