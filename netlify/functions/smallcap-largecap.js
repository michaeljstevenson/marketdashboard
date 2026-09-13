// Serves the small-cap vs. large-cap spread snapshot (aligned daily indexed
// price series for IWM/MDY/SPY, a trailing-return ladder, and monthly Fed
// funds rate / 10-year Treasury yield series) computed daily by
// scheduled-smallcap-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getSmallcapStore, BLOB_KEY } = require("./smallcap-blob-store");

exports.handler = async () => {
  try {
    const store = getSmallcapStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Small-cap/large-cap data not yet populated — scheduled-smallcap-background hasn't run yet");
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
