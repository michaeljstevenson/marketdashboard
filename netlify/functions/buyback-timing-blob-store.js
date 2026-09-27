// Shared helper for opening the "buyback-timing" Netlify Blobs store, used
// by scheduled-buyback-timing-background.js (writes latest.json and a
// resumable checkpoint) and buyback-timing.js (reads latest.json). Mirrors
// buyback-effectiveness-blob-store.js — see breadth-blob-store.js for why
// the explicit siteID/token fallback is needed on this site (automatic
// context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "buyback-timing";
const BLOB_KEY = "latest.json";
const CHECKPOINT_KEY = "checkpoint.json";

function getBuybackTimingStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getBuybackTimingStore, BLOB_STORE, BLOB_KEY, CHECKPOINT_KEY };
