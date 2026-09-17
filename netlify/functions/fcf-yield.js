// Serves the TTM free-cash-flow-yield snapshot (per-company FCF yield,
// sector aggregates, the accumulating weekly market-median history, the
// FCF-yield-vs-earnings-yield regression pairs, and leaderboards) computed
// by scheduled-fcf-yield-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getFcfYieldStore, BLOB_KEY } = require("./fcf-yield-blob-store");

exports.handler = async () => {
  try {
    const store = getFcfYieldStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("FCF yield data not yet populated — scheduled-fcf-yield-background hasn't run yet");
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
