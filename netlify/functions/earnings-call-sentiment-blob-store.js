// Shared helper for opening the "earnings-call-sentiment" Netlify Blobs
// store, used by scheduled-earnings-call-sentiment-background.js (writes)
// and earnings-call-sentiment.js (reads). Mirrors margin-leverage-blob-
// store.js — see breadth-blob-store.js for why the explicit siteID/token
// fallback is needed on this site (automatic context injection doesn't
// work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "earnings-call-sentiment";
const BLOB_KEY = "latest.json";

function getEarningsCallSentimentStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getEarningsCallSentimentStore, BLOB_STORE, BLOB_KEY };
