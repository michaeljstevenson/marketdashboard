// Serves the Earnings Growth vs. Price return decomposition, pre-computed
// weekly by scheduled-earnings-growth-divergence-background.js and stored
// in Netlify Blobs. No outbound calls.

const { getEarningsGrowthStore, SPLIT_KEY } = require("./earnings-growth-divergence-blob-store");

exports.handler = async () => {
  try {
    const store = getEarningsGrowthStore();
    const payload = await store.get(SPLIT_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Earnings growth divergence data not yet populated, scheduled-earnings-growth-divergence-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
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
