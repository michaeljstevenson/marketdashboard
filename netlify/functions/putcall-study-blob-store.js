// Shared helper for the "putcall-study" Netlify Blobs store: the put/call
// ratio page's payload, written by scheduled-putcall-study-background.js and
// served by putcall-study.js. See breadth-blob-store.js for why the explicit
// siteID/token fallback is needed on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "putcall-study";
const BLOB_KEY = "latest.json";

function getPutCallStudyStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getPutCallStudyStore, BLOB_STORE, BLOB_KEY };
