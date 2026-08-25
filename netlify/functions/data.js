// Serves the U.S. Market Sentiment Index. Computation moved out of this
// function entirely — see scheduled-sentiment-background.js — which now
// runs once daily and writes the full result (composite score, every
// component, and the history chart) to Netlify Blobs. This function is
// just a blob read: no live Alpha Vantage calls, no per-page-load
// latency scaling with the number of factors, and no risk of the
// request itself timing out.

const { getSentimentStore, BLOB_KEY } = require("./sentiment-blob-store");

exports.handler = async () => {
  try {
    const store = getSentimentStore();
    const data = await store.get(BLOB_KEY, { type: "json" });
    if (!data) {
      throw new Error("Sentiment blob not yet populated — scheduled-sentiment-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Cached at the edge for 30 minutes — the underlying blob only
        // changes once a day, but a shorter TTL than that keeps a manual
        // re-run of the background job (or a mid-day fix) reaching
        // visitors reasonably quickly without every page load hitting
        // Blobs directly.
        "Cache-Control": "public, max-age=1800",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
