// Shared helper for opening the "dividend-growth" Netlify Blobs store,
// used by scheduled-dividend-growth-background.js (writes) and
// dividend-growth.js (reads). Mirrors surprise-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "dividend-growth";
const LATEST_KEY = "latest.json";

function getDividendStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getDividendStore, BLOB_STORE, LATEST_KEY };
