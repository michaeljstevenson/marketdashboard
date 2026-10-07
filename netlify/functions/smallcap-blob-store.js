// Shared helper for opening the "smallcap-largecap" Netlify Blobs store,
// used by scheduled-smallcap-background.js (writes) and
// smallcap-largecap.js (reads). Mirrors insider-blob-store.js — see that
// file for why the explicit siteID/token fallback is needed on this site
// (automatic context injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "smallcap-largecap";
const BLOB_KEY = "smallcap.json";
// Parsed Ken French size portfolios, kept apart from the page payload so the
// daily job can skip the download until Dartmouth publishes a new file.
const SIZE_KEY = "kf-size-portfolios.json";

function getSmallcapStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSmallcapStore, BLOB_STORE, BLOB_KEY, SIZE_KEY };
