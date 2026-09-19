// Serves the SPY / URTH daily close history for the "% off all-time highs"
// charts on ath-index.html, from the blob written by
// scheduled-drawdown-background.js. No live upstream calls.

const { getDrawdownStore, BLOB_KEY } = require("./drawdown-blob-store");

exports.handler = async () => {
  try {
    const payload = await getDrawdownStore().get(BLOB_KEY, { type: "json" });
    if (!payload) {
      throw new Error("Drawdown history not yet populated — scheduled-drawdown-background hasn't run");
    }
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
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
