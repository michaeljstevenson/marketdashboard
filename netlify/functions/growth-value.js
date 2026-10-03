// Serves the growth vs. value snapshot (aligned daily indexed price series
// for IWF/IWD/SPY, a trailing-return ladder, and the monthly 10-year
// Treasury yield) computed daily by scheduled-growth-value-background.js and
// stored in Netlify Blobs. Makes no Alpha Vantage calls itself.

const { getGrowthValueStore, BLOB_KEY } = require("./growthvalue-blob-store");

exports.handler = async () => {
  try {
    const payload = await getGrowthValueStore().get(BLOB_KEY, { type: "json" });
    if (!payload) {
      throw new Error("Growth/value data not yet populated, scheduled-growth-value-background hasn't run yet");
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
