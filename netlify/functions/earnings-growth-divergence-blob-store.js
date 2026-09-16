// Shared helper for opening the "earnings-growth-divergence" Netlify Blobs
// store, used by scheduled-earnings-growth-divergence-background.js
// (writes) and earnings-growth-divergence.js (reads). Mirrors
// sector-blob-store.js — see breadth-blob-store.js for why the explicit
// siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "earnings-growth-divergence";
const LATEST_KEY = "latest.json";

function getEarningsGrowthStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getEarningsGrowthStore, BLOB_STORE, LATEST_KEY };
