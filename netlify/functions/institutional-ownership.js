// Serves the "Institutional Ownership Trends" latest snapshot, pre-computed
// by scheduled-institutional-ownership-background.js and stored in Netlify
// Blobs, plus whatever accumulated history points exist. This function
// makes no Alpha Vantage calls itself — it just reads the pre-computed blob.

const { getInstitutionalOwnershipStore, LATEST_KEY, HISTORY_KEY } = require("./institutional-ownership-blob-store");

exports.handler = async () => {
  try {
    const store = getInstitutionalOwnershipStore();
    const [latest, history] = await Promise.all([
      store.get(LATEST_KEY, { type: "json" }),
      store.get(HISTORY_KEY, { type: "json" }),
    ]);

    if (!latest) {
      throw new Error("Institutional ownership data not yet populated — scheduled-institutional-ownership-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ ...latest, history: (history && history.points) || [] }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
