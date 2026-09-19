// Shared helper for opening the "news-sentiment" Netlify Blobs store, used
// by scheduled-news-sentiment-background.js (writes) and news-sentiment.js
// (reads). Mirrors institutional-ownership-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "news-sentiment";
const BLOB_KEY = "snapshot.json";

function getNewsSentimentStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getNewsSentimentStore, BLOB_STORE, BLOB_KEY };
