// Serves the ai-capex snapshot (capital expenditure trend and intensity
// across the S&P 500, with a hand-curated hyperscaler/AI-infrastructure
// cohort broken out separately) computed by scheduled-ai-capex-background.js
// and stored in Netlify Blobs. This function makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob.

const { getAiCapexStore, BLOB_KEY } = require("./ai-capex-blob-store");

exports.handler = async () => {
  try {
    const store = getAiCapexStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("AI capex data not yet populated, scheduled-ai-capex-background hasn't run yet");
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
