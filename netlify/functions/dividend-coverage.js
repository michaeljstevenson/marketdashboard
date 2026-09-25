// Serves the dividend coverage snapshot computed by
// scheduled-dividend-coverage-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getDividendCoverageStore, BLOB_KEY } = require("./dividend-coverage-blob-store");

exports.handler = async () => {
  try {
    const store = getDividendCoverageStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Dividend coverage data not yet populated — scheduled-dividend-coverage-background hasn't run yet");
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
