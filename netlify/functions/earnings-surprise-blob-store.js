// Shared helper for opening the "earnings-surprise" Netlify Blobs store,
// used by scheduled-earnings-surprise-background.js (writes) and
// earnings-surprise.js (reads). Mirrors revisions-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "earnings-surprise";
const BLOB_KEY = "surprise.json";

function getSurpriseStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSurpriseStore, BLOB_STORE, BLOB_KEY };
