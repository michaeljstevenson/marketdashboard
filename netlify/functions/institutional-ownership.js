// Serves the "Institutional Ownership & 13F Flow Tracker" snapshot (per-
// company latest 13F aggregates, sector-median ownership/flow, the
// accumulating market-median-flow history, and the flow-vs-momentum
// regression pairs) computed weekly by scheduled-institutional-ownership-
// background.js and stored in Netlify Blobs. This function makes no Alpha
// Vantage calls itself — it just reads the pre-computed blob.

const { getInstitutionalOwnershipStore, BLOB_KEY } = require("./institutional-ownership-blob-store");

exports.handler = async () => {
  try {
    const store = getInstitutionalOwnershipStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Institutional ownership data not yet populated, scheduled-institutional-ownership-background hasn't run yet");
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
