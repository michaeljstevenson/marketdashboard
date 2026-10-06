// Serves the effective-tax-rate snapshot (corporate effective tax rate
// trends and cross-sectional patterns across the S&P 500) computed by
// scheduled-effective-tax-rate-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getEffectiveTaxRateStore, BLOB_KEY } = require("./effective-tax-rate-blob-store");

exports.handler = async () => {
  try {
    const store = getEffectiveTaxRateStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Effective tax rate data not yet populated, scheduled-effective-tax-rate-background hasn't run yet");
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
