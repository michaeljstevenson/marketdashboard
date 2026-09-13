// Shared helper for opening the "earnings-revisions" Netlify Blobs store,
// used by scheduled-revisions-background.js (writes) and
// earnings-revisions.js (reads). Mirrors sector-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "earnings-revisions";
const LATEST_KEY = "latest.json";
const HISTORY_KEY = "history.json";

function getRevisionsStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getRevisionsStore, BLOB_STORE, LATEST_KEY, HISTORY_KEY };
