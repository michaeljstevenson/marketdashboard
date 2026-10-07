// Serves the short interest payload for the Short Sale Volume page,
// pre-computed by scheduled-short-interest-background.js and stored in
// Netlify Blobs. No outbound calls.

const { getShortInterestStore, LATEST_KEY } = require("./short-interest-blob-store");

exports.handler = async () => {
  try {
    const payload = await getShortInterestStore().get(LATEST_KEY, { type: "json" });
    if (!payload) {
      throw new Error("Short interest data not yet populated, scheduled-short-interest-background hasn't run yet");
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
