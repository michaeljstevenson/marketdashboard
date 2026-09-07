// Shared helper for opening the "beeswarm" Netlify Blobs store, used by the
// sector-beeswarm page's backend:
//   - scheduled-beeswarm-annual-background.js  writes  annual.json
//   - scheduled-beeswarm-meta-background.js    writes  meta.json
//   - scheduled-beeswarm-daily-background.js   writes  day/<YYYY-MM-DD>.json
//                                              and     day-index.json
//   - beeswarm-annual.js / beeswarm-daily.js   read
//
// Mirrors sector-blob-store.js — see breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site (automatic context
// injection doesn't work here).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "beeswarm";

const ANNUAL_KEY = "annual.json";
const META_KEY = "meta.json";
const DAY_INDEX_KEY = "day-index.json";
const dayKey = (date) => `day/${date}.json`;

function getBeeswarmStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = {
  getBeeswarmStore,
  BLOB_STORE,
  ANNUAL_KEY,
  META_KEY,
  DAY_INDEX_KEY,
  dayKey,
};
