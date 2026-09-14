// Shared helper for opening the "relative-strength" Netlify Blobs store,
// used by scheduled-relative-strength-background.js (writes) and
// relative-strength.js (reads). Mirrors sector-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "relative-strength";
const LATEST_KEY = "latest.json";
const HISTORY_KEY = "history.json";

function getRelativeStrengthStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getRelativeStrengthStore, BLOB_STORE, LATEST_KEY, HISTORY_KEY };
