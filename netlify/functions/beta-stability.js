// Serves the Beta Stability snapshot computed by scheduled-beta-stability-
// background.js and stored in Netlify Blobs. This function makes no Yahoo
// or Alpha Vantage calls itself — it just reads the pre-computed blob.

const { getBetaStabilityStore, BLOB_KEY } = require("./beta-stability-blob-store");

exports.handler = async () => {
  try {
    const store = getBetaStabilityStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Beta stability data not yet populated — scheduled-beta-stability-background hasn't run yet");
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
