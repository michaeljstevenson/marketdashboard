// Shared helper for opening the "post-earnings-drift" Netlify Blobs store,
// used by scheduled-post-earnings-drift-background.js (writes) and
// post-earnings-drift.js (reads). Mirrors relative-strength-blob-store.js —
// see breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).
//
// No accumulating history blob, same choice /spin-off-performance made:
// each run recomputes the full drift panel fresh from whatever quarter
// window is currently available rather than building up a time series.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "post-earnings-drift";
const LATEST_KEY = "latest.json";

function getPeadStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getPeadStore, BLOB_STORE, LATEST_KEY };
