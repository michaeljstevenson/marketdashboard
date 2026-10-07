// Serves the Implied vs. Realized Volatility page's data, computed once per
// weekday after the close by scheduled-volatility-background.js and stored
// in Netlify Blobs (see that file for the definitions). This function makes
// no Yahoo calls itself. Mirrors country-performance.js.

const { getVolatilityStore, BLOB_KEY } = require("./volatility-blob-store");

exports.handler = async () => {
  try {
    const payload = await getVolatilityStore().get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Volatility data not yet populated, scheduled-volatility-background hasn't run yet");
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
