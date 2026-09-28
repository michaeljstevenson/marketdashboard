// Serves the "Insider Ownership" latest snapshot, pre-computed by
// scheduled-insider-ownership-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getInsiderOwnershipStore, LATEST_KEY } = require("./insider-ownership-blob-store");

exports.handler = async () => {
  try {
    const store = getInsiderOwnershipStore();
    const latest = await store.get(LATEST_KEY, { type: "json" });

    if (!latest) {
      throw new Error("Insider ownership data not yet populated, scheduled-insider-ownership-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(latest),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
