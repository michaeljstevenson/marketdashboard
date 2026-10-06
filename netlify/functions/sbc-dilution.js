// Serves the sbc-dilution snapshot (stock-based compensation intensity and
// its relationship to actual share dilution across the S&P 500) computed by
// scheduled-sbc-dilution-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getSbcDilutionStore, BLOB_KEY } = require("./sbc-dilution-blob-store");

exports.handler = async () => {
  try {
    const store = getSbcDilutionStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("SBC dilution data not yet populated, scheduled-sbc-dilution-background hasn't run yet");
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
