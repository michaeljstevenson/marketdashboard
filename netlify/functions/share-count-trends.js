// Serves the share-count-trends snapshot (per-company trailing share-count
// history, buyback/dilution classification, sector aggregates, and a
// year-over-year persistence check) computed weekly by
// scheduled-share-count-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getShareCountStore, BLOB_KEY } = require("./share-count-blob-store");

exports.handler = async () => {
  try {
    const store = getShareCountStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Share count trends data not yet populated, scheduled-share-count-background hasn't run yet");
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
