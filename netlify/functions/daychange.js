// Serves the "Day's change distribution" snapshot (median/mean % change,
// up/down counts, full per-symbol list) computed hourly during market
// hours by scheduled-daychange-background.js and stored in Netlify Blobs.
// This function itself makes no Alpha Vantage calls — it just reads the
// pre-computed blob, so it's fast and cheap regardless of page-load volume.

const { getDayChangeStore, BLOB_KEY } = require("./daychange-blob-store");

exports.handler = async () => {
  try {
    const store = getDayChangeStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Day's-change data not yet populated — scheduled-daychange-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=900",
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
