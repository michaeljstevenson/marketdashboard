// Serves the "Golden Cross / Death Cross" latest snapshot, pre-computed
// by scheduled-golden-cross-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getGoldenCrossStore, LATEST_KEY } = require("./golden-cross-blob-store");

exports.handler = async () => {
  try {
    const store = getGoldenCrossStore();
    const latest = await store.get(LATEST_KEY, { type: "json" });

    if (!latest) {
      throw new Error("Golden cross data not yet populated, scheduled-golden-cross-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(latest),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
