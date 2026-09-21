// Serves the "Quality & Low-Volatility Factor Screen" snapshot (per-company
// quality/low-vol z-scores and combined score, quintiles, sector aggregates,
// quintile-bucketed and continuous forward-return tests, and leaderboards)
// computed by scheduled-quality-lowvol-background.js and stored in Netlify
// Blobs. This function makes no Alpha Vantage calls itself — it just reads
// the pre-computed blob.

const { getQualityLowVolStore, BLOB_KEY } = require("./quality-lowvol-blob-store");

exports.handler = async () => {
  try {
    const store = getQualityLowVolStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Quality & low-vol factor data not yet populated, scheduled-quality-lowvol-background hasn't run yet");
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
