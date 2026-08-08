// Serves the market breadth internals (advances/declines, 52-week new
// highs/lows, % above 200-day SMA, cumulative A-D line) computed daily by
// scheduled-breadth.js and stored in Netlify Blobs. This function itself
// makes no Alpha Vantage calls — it just reads the pre-computed blob, so
// it's fast and cheap regardless of page-load volume.

const { getStore } = require("@netlify/blobs");

const BLOB_STORE = "breadth";
const BLOB_KEY = "internals.json";

exports.handler = async () => {
  try {
    const store = getStore(BLOB_STORE);
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Breadth internals not yet populated — scheduled-breadth hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=7200",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
