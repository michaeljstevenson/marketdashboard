// Shared helper for opening the "smallcap-liquidity" Netlify Blobs store,
// used by scheduled-smallcap-liquidity-background.js (writes) and
// smallcap-liquidity.js (reads). Mirrors revisions-blob-store.js — see
// breadth-blob-store.js for why the explicit siteID/token fallback is
// needed on this site (automatic context injection doesn't work here).
//
// latest.json is the page payload, rebuilt from scratch every week.
// checkpoint.json holds per-stock summaries while a sweep spans more than
// one run (see the job's header).

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "smallcap-liquidity";
const LATEST_KEY = "latest.json";
const CHECKPOINT_KEY = "checkpoint.json";

function getSmallcapLiquidityStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getSmallcapLiquidityStore, BLOB_STORE, LATEST_KEY, CHECKPOINT_KEY };
