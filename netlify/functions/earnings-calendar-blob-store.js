// Shared helper for opening the "earnings-calendar" Netlify Blobs store, used
// by scheduled-earnings-calendar-background.js (writes) and
// earnings-calendar.js (reads). See breadth-blob-store.js for why the
// explicit siteID/token fallback is needed on this site.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "earnings-calendar";
const LATEST_KEY = "latest.json";

function getEarningsCalendarStore() {
  const { BLOBS_SITE_ID, BLOBS_API_TOKEN } = process.env;
  if (BLOBS_SITE_ID && BLOBS_API_TOKEN) {
    return getStore({ name: BLOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_API_TOKEN });
  }
  return getStore(BLOB_STORE);
}

module.exports = { getEarningsCalendarStore, BLOB_STORE, LATEST_KEY };
