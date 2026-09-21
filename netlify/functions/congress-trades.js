// Serves the congressional-trading snapshot (per-stock and per-party/
// chamber net buy/sell flow, disclosure-lag stats, and the buy/sell-vs-
// price-performance regression) computed by
// scheduled-congress-trades-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getCongressTradesStore, BLOB_KEY } = require("./congress-trades-blob-store");

exports.handler = async () => {
  try {
    const store = getCongressTradesStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Congressional trading data not yet populated, scheduled-congress-trades-background hasn't run yet");
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
