// Shared helper for opening the "earnings-sentiment" Netlify Blobs store,
// used by scheduled-earnings-sentiment-background.js (writes) and
// earnings-call-sentiment.js (reads). Mirrors margin-leverage-blob-store.js
// — see breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "earnings-sentiment";
const BLOB_KEY = "earnings-sentiment.json";

function getEarningsSentimentStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getEarningsSentimentStore, BLOB_STORE, BLOB_KEY };
