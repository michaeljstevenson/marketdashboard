// Serves the S&P 500 valuation payload for the Valuations page,
// pre-computed by scheduled-valuations-background.js and stored in
// Netlify Blobs. No outbound calls.

const { getValuationsStore, LATEST_KEY } = require("./valuations-blob-store");

exports.handler = async () => {
  try {
    const payload = await getValuationsStore().get(LATEST_KEY, { type: "json" });
    if (!payload) {
      throw new Error("Valuation data not yet populated, scheduled-valuations-background hasn't run yet");
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
