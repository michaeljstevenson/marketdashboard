// Serves the "Analyst Price Target Upside" latest snapshot, pre-computed
// by scheduled-analyst-price-target-background.js and stored in Netlify
// Blobs, plus whatever accumulated history points exist. This function
// makes no Alpha Vantage calls itself — it just reads the pre-computed
// blob.

const { getPriceTargetStore, LATEST_KEY, HISTORY_KEY } = require("./analyst-price-target-blob-store");

exports.handler = async () => {
  try {
    const store = getPriceTargetStore();
    const [latest, history] = await Promise.all([
      store.get(LATEST_KEY, { type: "json" }),
      store.get(HISTORY_KEY, { type: "json" }),
    ]);

    if (!latest) {
      throw new Error("Analyst price target data not yet populated — scheduled-analyst-price-target-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ ...latest, history: (history && history.points) || [] }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
