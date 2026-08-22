// Shared helper for counting Alpha Vantage API calls per UTC day, so we can
// see actual daily usage against the account's ~71-75 calls/minute
// entitlement (the Alpha Vantage dashboard itself shows no call counter).
//
// Every function that calls Alpha Vantage should call recordAvCall() once per
// request made (not once per function invocation - some invocations make
// several AV calls). Counts are stored in Netlify Blobs, one JSON object
// keyed by "YYYY-MM-DD" -> count, so history accumulates day over day.
//
// See breadth-blob-store.js for why siteID/token are passed explicitly.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "av-usage";
const BLOB_KEY = "call-counts.json";
const MAX_DAYS_KEPT = 90; // trim old entries so the blob doesn't grow forever

function getUsageStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function trimOldEntries(counts) {
  const keys = Object.keys(counts).sort();
  if (keys.length <= MAX_DAYS_KEPT) return counts;
  const trimmed = {};
  for (const k of keys.slice(-MAX_DAYS_KEPT)) trimmed[k] = counts[k];
  return trimmed;
}

// Increments today's call count by `n` (default 1). Never throws - a
// counter failure should never take down the actual data fetch it's
// instrumenting.
async function recordAvCall(n = 1) {
  try {
    const store = getUsageStore();
    const raw = await store.get(BLOB_KEY, { type: "json" });
    const counts = raw && typeof raw === "object" ? raw : {};
    const key = todayKey();
    counts[key] = (counts[key] || 0) + n;
    await store.setJSON(BLOB_KEY, trimOldEntries(counts));
  } catch (err) {
    console.error("av-call-counter: failed to record call", err);
  }
}

async function getAvCallCounts() {
  const store = getUsageStore();
  const raw = await store.get(BLOB_KEY, { type: "json" });
  return raw && typeof raw === "object" ? raw : {};
}

module.exports = { recordAvCall, getAvCallCounts, BLOB_STORE, BLOB_KEY };
