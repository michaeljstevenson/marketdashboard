// Serves the forward-vs-trailing P/E divergence snapshot (per-company P/E
// pair, sector aggregates, the accumulating weekly history, and the
// implied-growth-vs-actual-growth regression pairs) computed weekly by
// scheduled-pe-divergence-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getPeDivergenceStore, BLOB_KEY } = require("./pe-divergence-blob-store");

exports.handler = async () => {
  try {
    const store = getPeDivergenceStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("P/E divergence data not yet populated — scheduled-pe-divergence-background hasn't run yet");
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
