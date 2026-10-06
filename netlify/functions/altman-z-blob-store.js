// Shared helper for opening the "altman-z" Netlify Blobs store, used by
// scheduled-altman-z-background.js (writes) and altman-z.js (reads).
// Mirrors roic-wacc-blob-store.js — see breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "altman-z";
const BLOB_KEY = "altman-z.json";
const CHECKPOINT_KEY = "checkpoint.json";

function getAltmanZStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getAltmanZStore, BLOB_STORE, BLOB_KEY, CHECKPOINT_KEY };
