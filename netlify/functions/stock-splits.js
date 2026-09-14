// Serves the stock-split-tracker snapshot (split frequency history, sector
// activity, the post-split relative-performance event study, and the
// recent-splits table) computed weekly by scheduled-splits-background.js
// and stored in Netlify Blobs. This function makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob.

const { getSplitsStore, BLOB_KEY } = require("./splits-blob-store");

exports.handler = async () => {
  try {
    const store = getSplitsStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Stock split data not yet populated — scheduled-splits-background hasn't run yet");
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
