// Shared helper for opening the "52-week-high-momentum" Netlify Blobs
// store, used by scheduled-high52-momentum-background.js (writes) and
// high52-momentum.js (reads). Mirrors rsi-reversal-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "52-week-high-momentum";
const LATEST_KEY = "latest.json";
const HISTORY_KEY = "history.json";

function getHigh52Store() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getHigh52Store, BLOB_STORE, LATEST_KEY, HISTORY_KEY };
