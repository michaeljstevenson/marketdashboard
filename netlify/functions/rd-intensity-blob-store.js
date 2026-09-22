// Shared helper for opening the "rd-intensity" Netlify Blobs store, used
// by scheduled-rd-intensity-background.js (writes) and rd-intensity.js
// (reads). Mirrors roic-wacc-blob-store.js — see breadth-blob-store.js for
// why the explicit siteID/token fallback is needed on this site (automatic
// context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "rd-intensity";
const BLOB_KEY = "rd-intensity.json";

function getRdIntensityStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getRdIntensityStore, BLOB_STORE, BLOB_KEY };
