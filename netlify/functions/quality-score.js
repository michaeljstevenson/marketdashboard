// Serves the Financial Quality Screener (Piotroski F-Score) snapshot,
// computed by scheduled-quality-score-background.js (which itself depends
// on scheduled-quality-financials-background.js having already run) and
// stored in Netlify Blobs. This function makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob.

const { getQualityScoreStore, BLOB_KEY } = require("./quality-score-blob-store");

exports.handler = async () => {
  try {
    const store = getQualityScoreStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Quality score data not yet populated. Scheduled-quality-financials-background and scheduled-quality-score-background haven't run yet");
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
