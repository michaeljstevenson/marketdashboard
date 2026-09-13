// Serves the insider buying/selling snapshot (per-stock and per-sector
// open-market Form 4 activity, trailing 90 days) computed weekly by
// scheduled-insider-transactions-background.js and stored in Netlify
// Blobs. This function makes no Alpha Vantage calls itself — it just
// reads the pre-computed blob.

const { getInsiderStore, BLOB_KEY } = require("./insider-blob-store");

exports.handler = async () => {
  try {
    const store = getInsiderStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Insider transactions data not yet populated — scheduled-insider-transactions-background hasn't run yet");
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
