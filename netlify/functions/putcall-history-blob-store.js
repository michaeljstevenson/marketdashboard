// Shared helper for the "putcall-history" Netlify Blobs store: month-end
// put/call snapshots of every S&P 500 member, written by
// scheduled-putcall-history-background.js and read by the put/call page's
// jobs. See breadth-blob-store.js for why the explicit siteID/token fallback
// is needed on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "putcall-history";
const PROGRESS_KEY = "progress.json";
const snapshotKey = (date) => `snapshots/${date}.json`;

function getPutCallHistoryStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getPutCallHistoryStore, BLOB_STORE, PROGRESS_KEY, snapshotKey };
