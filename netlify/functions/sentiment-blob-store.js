// Shared helper for opening the "sentiment" Netlify Blobs store, used by
// scheduled-sentiment-background.js (writes) and data.js (reads). Same
// explicit siteID/token workaround as breadth-blob-store.js — see that
// file for why getStore(name) alone doesn't work on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "sentiment";
const BLOB_KEY = "latest.json";

function getSentimentStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSentimentStore, BLOB_STORE, BLOB_KEY };
