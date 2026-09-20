// Shared helper for opening the "cash-conversion-cycle" Netlify Blobs
// store, used by scheduled-cash-conversion-cycle-background.js (writes)
// and cash-conversion-cycle.js (reads). Mirrors roic-wacc-blob-store.js —
// see breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "cash-conversion-cycle";
const BLOB_KEY = "cash-conversion-cycle.json";
const CHECKPOINT_KEY = "checkpoint.json";

function getCashConversionCycleStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getCashConversionCycleStore, BLOB_STORE, BLOB_KEY, CHECKPOINT_KEY };
