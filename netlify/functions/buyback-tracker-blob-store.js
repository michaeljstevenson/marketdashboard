// Shared helper for opening the "buyback-tracker" Netlify Blobs store, used
// by scheduled-buyback-tracker-background.js (writes) and
// buyback-tracker.js (reads). Mirrors sector-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "buyback-tracker";
const LATEST_KEY = "latest.json";

function getBuybackTrackerStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getBuybackTrackerStore, BLOB_STORE, LATEST_KEY };
