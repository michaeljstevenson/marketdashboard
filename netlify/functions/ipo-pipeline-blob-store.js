// Shared helper for opening the "ipo-pipeline" Netlify Blobs store, used by
// scheduled-ipo-pipeline-background.js (writes) and ipo-pipeline.js (reads).
// Mirrors revisions-blob-store.js — see breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site (automatic context
// injection doesn't work here). Unlike earnings-revisions' two-blob split,
// this page's weekly history is small (one point per week, forever) and
// lives inside the single "latest.json" payload alongside the calendar and
// roster, so there's no separate history key.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "ipo-pipeline";
const LATEST_KEY = "latest.json";

function getIpoPipelineStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getIpoPipelineStore, BLOB_STORE, LATEST_KEY };
