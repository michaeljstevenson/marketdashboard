// Shared helper for opening the "institutional-ownership" Netlify Blobs
// store, used by scheduled-institutional-ownership-background.js (writes)
// and institutional-ownership.js (reads). Mirrors margin-leverage-blob-
// store.js — see breadth-blob-store.js for why the explicit siteID/token
// fallback is needed on this site (automatic context injection doesn't
// work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "institutional-ownership";
const BLOB_KEY = "institutional-ownership.json";

function getInstitutionalOwnershipStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getInstitutionalOwnershipStore, BLOB_STORE, BLOB_KEY };
