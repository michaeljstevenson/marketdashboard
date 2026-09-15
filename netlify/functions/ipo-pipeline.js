// Serves the IPO pipeline snapshot (current IPO_CALENDAR pull, the
// accumulating aftermarket-tracking roster, and the weekly pipeline-size
// history) computed weekly by scheduled-ipo-pipeline-background.js and
// stored in Netlify Blobs. This function makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob.

const { getIpoPipelineStore, LATEST_KEY } = require("./ipo-pipeline-blob-store");

exports.handler = async () => {
  try {
    const store = getIpoPipelineStore();
    const payload = await store.get(LATEST_KEY, { type: "json" });

    if (!payload) {
      throw new Error("IPO pipeline data not yet populated — scheduled-ipo-pipeline-background hasn't run yet");
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
