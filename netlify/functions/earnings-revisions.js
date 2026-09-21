// Serves the earnings-revisions data (sector/market Net Revision Ratio and
// Estimate Drift, the per-stock scatter, and the upgrade/downgrade
// leaderboards) computed weekly by scheduled-revisions-background.js, plus
// the accumulating history series it appends to on every run. This
// function makes no Alpha Vantage calls itself — it just reads the two
// pre-computed blobs.

const { getRevisionsStore, LATEST_KEY, HISTORY_KEY } = require("./revisions-blob-store");

exports.handler = async () => {
  try {
    const store = getRevisionsStore();
    const [latest, history] = await Promise.all([
      store.get(LATEST_KEY, { type: "json" }),
      store.get(HISTORY_KEY, { type: "json" }),
    ]);

    if (!latest) {
      throw new Error("Earnings revisions not yet populated, scheduled-revisions-background hasn't run yet");
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
