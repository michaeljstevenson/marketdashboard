// Shared helper for opening the "accruals" Netlify Blobs store, used by
// scheduled-accruals-background.js (writes) and accruals.js (reads).
// Mirrors roic-wacc-blob-store.js — see breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "accruals";
const BLOB_KEY = "accruals.json";
const CHECKPOINT_KEY = "checkpoint.json";

function getAccrualsStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getAccrualsStore, BLOB_STORE, BLOB_KEY, CHECKPOINT_KEY };
