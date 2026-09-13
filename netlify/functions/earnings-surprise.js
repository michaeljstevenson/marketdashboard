// Serves the earnings-surprise snapshot (per-company trailing-8-quarter
// beat/miss history, sector aggregates, a market-wide beat-rate trend, and
// leaderboards) computed weekly by scheduled-earnings-surprise-background.js
// and stored in Netlify Blobs. This function makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob.

const { getSurpriseStore, BLOB_KEY } = require("./earnings-surprise-blob-store");

exports.handler = async () => {
  try {
    const store = getSurpriseStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Earnings surprise data not yet populated — scheduled-earnings-surprise-background hasn't run yet");
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
