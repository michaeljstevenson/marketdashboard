// Serves the "Earnings Growth vs. Price Performance Divergence" latest
// snapshot, pre-computed weekly by
// scheduled-earnings-growth-divergence-background.js and stored in
// Netlify Blobs. This function makes no Alpha Vantage calls itself — it
// just reads the pre-computed blob.

const { getEarningsGrowthStore, LATEST_KEY, SPLIT_KEY } = require("./earnings-growth-divergence-blob-store");

exports.handler = async (event) => {
  try {
    const store = getEarningsGrowthStore();
    const v2 = event && event.queryStringParameters && event.queryStringParameters.v === "2";
    const payload = await store.get(v2 ? SPLIT_KEY : LATEST_KEY, { type: "json" });

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
