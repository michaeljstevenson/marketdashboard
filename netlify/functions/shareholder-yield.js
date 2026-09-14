// Serves the shareholder-yield snapshot (per-stock dividend yield, buyback
// yield, and combined total, sector aggregates, and the top-yield
// leaderboards) computed weekly by scheduled-shareholder-yield-
// background.js and stored in Netlify Blobs. This function makes no Alpha
// Vantage calls itself — it just reads the pre-computed blob.

const { getShareholderYieldStore, BLOB_KEY } = require("./shareholder-yield-blob-store");

exports.handler = async () => {
  try {
    const store = getShareholderYieldStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Shareholder yield data not yet populated — scheduled-shareholder-yield-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
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
