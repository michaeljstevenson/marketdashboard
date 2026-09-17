// Serves the "Analyst Ratings & Price Targets" latest snapshot,
// pre-computed by scheduled-analyst-price-targets-background.js and stored
// in Netlify Blobs. This function makes no Alpha Vantage calls itself — it
// just reads the pre-computed blob.

const { getAnalystPriceTargetsStore, LATEST_KEY } = require("./analyst-price-targets-blob-store");

exports.handler = async () => {
  try {
    const store = getAnalystPriceTargetsStore();
    const payload = await store.get(LATEST_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Analyst ratings & price target data not yet populated — scheduled-analyst-price-targets-background hasn't run yet");
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
