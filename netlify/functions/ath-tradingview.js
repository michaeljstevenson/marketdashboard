// Serves the TradingView-sourced all-time-high history computed daily by
// scheduled-ath-tradingview.js and stored in Netlify Blobs. This function
// makes no outbound requests itself — it just reads the pre-computed blob.

const { getTvAthStore, BLOB_KEY } = require("./tv-ath-blob-store");

exports.handler = async () => {
  try {
    const store = getTvAthStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload || !payload.rows || !payload.rows.length) {
      throw new Error("TradingView ATH data not yet populated — scheduled-ath-tradingview hasn't run yet");
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
