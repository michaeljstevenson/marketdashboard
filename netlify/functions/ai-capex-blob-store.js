// Shared helper for opening the "ai-capex" Netlify Blobs store, used by
// scheduled-ai-capex-background.js (writes) and ai-capex.js (reads).
// Mirrors fcf-yield-blob-store.js — see breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "ai-capex";
const BLOB_KEY = "ai-capex.json";

function getAiCapexStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getAiCapexStore, BLOB_STORE, BLOB_KEY };
