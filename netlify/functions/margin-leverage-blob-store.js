// Shared helper for opening the "margin-leverage" Netlify Blobs store, used
// by scheduled-margin-leverage-background.js (writes) and margin-leverage.js
// (reads). Mirrors share-count-blob-store.js — see breadth-blob-store.js for
// why the explicit siteID/token fallback is needed on this site (automatic
// context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "margin-leverage";
const BLOB_KEY = "margin-leverage.json";
// Raw per-ticker statements (quarterly + annual) shared with
// scheduled-quality-financials-background.js so it makes no calls of its own.
const CHECKPOINT_KEY = "checkpoint.json";

function getMarginLeverageStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getMarginLeverageStore, BLOB_STORE, BLOB_KEY, CHECKPOINT_KEY };
