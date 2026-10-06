// Shared helper for opening the "effective-tax-rate" Netlify Blobs store,
// used by scheduled-effective-tax-rate-background.js (writes) and
// effective-tax-rate.js (reads). Mirrors sbc-dilution-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "effective-tax-rate";
const BLOB_KEY = "effective-tax-rate.json";

function getEffectiveTaxRateStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getEffectiveTaxRateStore, BLOB_STORE, BLOB_KEY };
