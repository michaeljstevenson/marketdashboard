// Serves the margin-and-leverage-cycle snapshot (per-company latest-quarter
// margins/leverage, sector-median quarterly time series, and the Fed-regime
// comparison) computed weekly by scheduled-margin-leverage-background.js and
// stored in Netlify Blobs. This function makes no Alpha Vantage calls itself
// — it just reads the pre-computed blob.

const { getMarginLeverageStore, BLOB_KEY } = require("./margin-leverage-blob-store");

exports.handler = async () => {
  try {
    const store = getMarginLeverageStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Margin & leverage data not yet populated — scheduled-margin-leverage-background hasn't run yet");
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
