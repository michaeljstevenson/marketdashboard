// Serves the "Congressional Trading Tracker" snapshot (per-company trailing-
// 12-month STOCK Act disclosure metrics, sector aggregates, cluster-buying
// screen, leaderboards, party cross-tab, and the net-flow-vs-forward-return
// regression pairs) computed by scheduled-congressional-trading-
// background.js and stored in Netlify Blobs. This function makes no Alpha
// Vantage calls itself — it just reads the pre-computed blob.

const { getCongressionalTradingStore, BLOB_KEY } = require("./congressional-trading-blob-store");

exports.handler = async () => {
  try {
    const store = getCongressionalTradingStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Congressional trading data not yet populated — scheduled-congressional-trading-background hasn't run yet");
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
