// Serves the "News Sentiment Momentum" snapshot (per-company weighted
// sentiment/attention metrics, sector aggregates, the accumulating weekly
// median-sentiment history, leaderboards, the attention-vs-sentiment
// scatter, and the sentiment-vs-forward-return regression pairs) computed
// by scheduled-news-sentiment-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getNewsSentimentStore, BLOB_KEY } = require("./news-sentiment-blob-store");

exports.handler = async () => {
  try {
    const store = getNewsSentimentStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("News sentiment data not yet populated — scheduled-news-sentiment-background hasn't run yet");
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
