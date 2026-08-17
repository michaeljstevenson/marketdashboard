// Shared helper for opening the "daychange" Netlify Blobs store, used by
// scheduled-daychange-background.js (writes) and daychange.js (reads).
// Separate store from breadth-blob-store.js's "breadth" store on purpose:
// this one refreshes hourly during market hours, the breadth store only
// once daily after the close — keeping them independent means the slow
// full-history breadth job never blocks or gets blocked by this one.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "daychange";
const BLOB_KEY = "daychange.json";

function getDayChangeStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getDayChangeStore, BLOB_STORE, BLOB_KEY };
