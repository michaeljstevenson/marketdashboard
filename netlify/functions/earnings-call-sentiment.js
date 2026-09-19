// Serves the earnings-call-sentiment snapshot (per-company statement-level
// sentiment aggregates, sector breakdown, distribution, and the two
// sentiment-vs-surprise regressions) computed by
// scheduled-earnings-sentiment-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getEarningsSentimentStore, BLOB_KEY } = require("./earnings-sentiment-blob-store");

exports.handler = async () => {
  try {
    const store = getEarningsSentimentStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Earnings call sentiment data not yet populated — scheduled-earnings-sentiment-background hasn't run yet");
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
