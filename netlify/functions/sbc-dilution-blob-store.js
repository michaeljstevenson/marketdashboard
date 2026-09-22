// Shared helper for opening the "sbc-dilution" Netlify Blobs store, used by
// scheduled-sbc-dilution-background.js (writes) and sbc-dilution.js (reads).
// Mirrors ai-capex-blob-store.js — see breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "sbc-dilution";
const BLOB_KEY = "sbc-dilution.json";

function getSbcDilutionStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSbcDilutionStore, BLOB_STORE, BLOB_KEY };
