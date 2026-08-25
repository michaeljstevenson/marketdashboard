// Serves the pre-computed S&P 500 seasonality statistics (day of week, day
// of month, calendar month, quarter, election cycle, holiday effect, and
// the year-by-month heatmap — one set per history window) computed daily
// by scheduled-seasonality-background.js and stored in Netlify Blobs.
// This function makes no outbound calls itself — it just reads the blob,
// so /seasonality.html does zero client-side aggregation on load.

const { getSeasonalityStore, BLOB_KEY } = require("./seasonality-blob-store");

exports.handler = async () => {
  try {
    const store = getSeasonalityStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Seasonality stats not yet populated — scheduled-seasonality-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
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
