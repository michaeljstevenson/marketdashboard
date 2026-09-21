// Serves the buyback-effectiveness snapshot (trailing-12-month buyback $
// spend, buyback intensity, dollar buyback yield, and the dilution-offset
// comparison against Share Count Trends' own net share-count change)
// computed by scheduled-buyback-effectiveness-background.js and stored in
// Netlify Blobs. This function makes no Alpha Vantage calls itself — it
// just reads the pre-computed blob.

const { getBuybackEffectivenessStore, BLOB_KEY } = require("./buyback-effectiveness-blob-store");

exports.handler = async () => {
  try {
    const store = getBuybackEffectivenessStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Buyback effectiveness data not yet populated, scheduled-buyback-effectiveness-background hasn't run yet");
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
