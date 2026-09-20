// Shared blob store for the Alpha Vantage collectors (see av-collector.js).
// Each collector does one sweep of the S&P 500 for one Alpha Vantage
// endpoint and publishes the raw fields here, so every job that needs that
// endpoint reads one shared copy instead of sweeping it again. See
// breadth-blob-store.js for why the explicit siteID/token fallback is needed
// on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "av-collected";

function getCollectedStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

// The published snapshot only ever holds a finished sweep; the in-flight
// sweep lives under progressKey until it completes.
const publishedKey = (kind) => `${kind}.json`;
const progressKey = (kind) => `${kind}.progress.json`;

// -> { generated_at_utc, kind, loadedCount, data: { SYMBOL: {...raw fields} } }
async function loadCollected(kind) {
  const published = await getCollectedStore().get(publishedKey(kind), { type: "json" });
  if (!published || !published.data) {
    throw new Error(`Shared ${kind} data not available: run scheduled-${kind}-collector-background first`);
  }
  return published;
}

module.exports = { getCollectedStore, loadCollected, publishedKey, progressKey, BLOB_STORE };
