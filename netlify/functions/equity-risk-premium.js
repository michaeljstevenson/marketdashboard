// Serves the "Equity Risk Premium by Sector" latest snapshot, pre-computed
// weekly by scheduled-equity-risk-premium-background.js and stored in
// Netlify Blobs. This function makes no Alpha Vantage calls itself — it
// just reads the pre-computed blob.

const { getErpStore, LATEST_KEY } = require("./equity-risk-premium-blob-store");

exports.handler = async () => {
  try {
    const store = getErpStore();
    const payload = await store.get(LATEST_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Equity risk premium data not yet populated — scheduled-equity-risk-premium-background hasn't run yet");
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
