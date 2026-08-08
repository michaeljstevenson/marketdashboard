// Shared helper for opening the "breadth" Netlify Blobs store, used by
// scheduled-breadth-background.js (writes), breadth-internals.js and
// data.js (reads).
//
// getStore(name) alone is supposed to pick up site context automatically
// inside Netlify Functions, but on this site it doesn't — every call
// fails with "The environment has not been configured to use Netlify
// Blobs" even from a plain read, and the dashboard's Blobs page shows no
// store was ever created. Falling back to explicit siteID/token (read
// from env vars set in the Netlify UI) works around that; see the
// BLOBS_SITE_ID / BLOBS_API_TOKEN setup note in the deploy docs.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "breadth";
const BLOB_KEY = "internals.json";

function getBreadthStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getBreadthStore, BLOB_STORE, BLOB_KEY };
