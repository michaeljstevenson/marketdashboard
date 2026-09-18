// Serves the "Buyback Dollar-Value Tracker" latest snapshot, pre-computed
// by scheduled-buyback-tracker-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getBuybackTrackerStore, LATEST_KEY } = require("./buyback-tracker-blob-store");

exports.handler = async () => {
  try {
    const store = getBuybackTrackerStore();
    const payload = await store.get(LATEST_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Buyback tracker data not yet populated — scheduled-buyback-tracker-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
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
