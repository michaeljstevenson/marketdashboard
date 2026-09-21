// Serves the analyst estimate dispersion snapshot (sector aggregates, the
// full dispersion histogram, the dispersion-vs-revision-churn scatter, and
// the most-/least-disagreement leaderboards) computed weekly by
// scheduled-dispersion-background.js, plus the accumulating history series
// it appends to on every run. This function makes no Alpha Vantage calls
// itself — it just reads the two pre-computed blobs.

const { getDispersionStore, LATEST_KEY, HISTORY_KEY } = require("./dispersion-blob-store");

exports.handler = async () => {
  try {
    const store = getDispersionStore();
    const [latest, history] = await Promise.all([
      store.get(LATEST_KEY, { type: "json" }),
      store.get(HISTORY_KEY, { type: "json" }),
    ]);

    if (!latest) {
      throw new Error("Analyst dispersion data not yet populated, scheduled-dispersion-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
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
