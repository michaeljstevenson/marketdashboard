// Serves the dividend-growth data (streaks, CAGR, YoY growth by sector and
// market-wide, the growth-rate distribution, and the grower/cutter
// leaderboards) computed weekly by scheduled-dividend-growth-background.js.
// Makes no Alpha Vantage calls itself — just reads the one pre-computed
// blob.

const { getDividendStore, LATEST_KEY } = require("./dividend-blob-store");

exports.handler = async () => {
  try {
    const store = getDividendStore();
    const latest = await store.get(LATEST_KEY, { type: "json" });

    if (!latest) {
      throw new Error("Dividend growth data not yet populated, scheduled-dividend-growth-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
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
