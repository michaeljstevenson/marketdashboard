// Shared helper for opening the "smallcap-liquidity" Netlify Blobs store,
// used by scheduled-smallcap-liquidity-background.js (writes) and
// smallcap-liquidity.js (reads). Mirrors revisions-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).
//
// Only a single latest.json is kept (no accumulating history.json like
// earnings-revisions.js) — each weekly run recomputes the full ~2-year
// cohort history from scratch rather than appending one new data point,
// so there's nothing to accumulate across runs.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "smallcap-liquidity";
const LATEST_KEY = "latest.json";

function getSmallcapLiquidityStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSmallcapLiquidityStore, BLOB_STORE, LATEST_KEY };
