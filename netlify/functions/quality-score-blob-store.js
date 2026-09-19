// Shared helper for opening the "quality-score" Netlify Blobs store, used by
// scheduled-quality-score-background.js (writes the final computed Piotroski
// F-Score payload) and quality-score.js (reads it). Mirrors
// margin-leverage-blob-store.js — see breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "quality-score";
const BLOB_KEY = "quality-score.json";

function getQualityScoreStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getQualityScoreStore, BLOB_STORE, BLOB_KEY };
