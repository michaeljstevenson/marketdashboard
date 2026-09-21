// Serves the international-vs-US snapshot (aligned daily indexed price
// series for EFA/EEM/SPY, a trailing-return ladder, and monthly EUR/USD
// history) computed daily by scheduled-international-background.js and
// stored in Netlify Blobs. This function makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob.

const { getInternationalStore, BLOB_KEY } = require("./international-blob-store");

exports.handler = async () => {
  try {
    const store = getInternationalStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("International-vs-US data not yet populated, scheduled-international-background hasn't run yet");
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
