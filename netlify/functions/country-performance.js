// Serves the country/region daily-close history computed by
// scheduled-countries-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob. Mirrors sector-performance.js.

const { getCountryStore, BLOB_KEY } = require("./country-blob-store");

exports.handler = async () => {
  try {
    const store = getCountryStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Country performance not yet populated — scheduled-countries-background hasn't run yet");
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
