// Shared helper for the "valuations" Netlify Blobs store: the monthly S&P
// 500 multiples behind the Valuations page, written by
// scheduled-valuations-background.js and served by valuations.js. See
// breadth-blob-store.js for why the explicit siteID/token fallback is needed
// on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "valuations";
const LATEST_KEY = "latest.json";
// One record per monthly run, kept so the page's history becomes
// point-in-time from the first run on.
const SNAPSHOTS_KEY = "snapshots.json";

function getValuationsStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getValuationsStore, BLOB_STORE, LATEST_KEY, SNAPSHOTS_KEY };
