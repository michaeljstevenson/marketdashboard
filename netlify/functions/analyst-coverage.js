// Serves the analyst-coverage snapshot computed by
// scheduled-analyst-coverage-background.js and stored in Netlify Blobs.
// This function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getAnalystCoverageStore, LATEST_KEY, HISTORY_KEY } = require("./analyst-coverage-blob-store");

exports.handler = async () => {
  try {
    const store = getAnalystCoverageStore();
    const latest = await store.get(LATEST_KEY, { type: "json" });

    if (!latest) {
      throw new Error("Analyst coverage data not yet populated — scheduled-analyst-coverage-background hasn't run yet");
    }

    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=7200",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ ...latest, history: history.points || [] }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
