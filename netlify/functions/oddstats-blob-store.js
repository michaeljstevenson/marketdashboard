// Shared helper for opening the "oddstats" Netlify Blobs store, used by
// scheduled-oddstats-background.js (writes) and oddstats.js (reads). Same
// explicit siteID/token workaround as sentiment-blob-store.js — see that
// file for why getStore(name) alone doesn't work on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "oddstats";
const BLOB_KEY = "latest.json";
// Per-user curation of the "recently ended" feed (archived entries + dismissed
// keys), written by oddstats-curation.js.
const CURATION_KEY = "curation.json";

function getOddstatsStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getOddstatsStore, BLOB_STORE, BLOB_KEY, CURATION_KEY };
