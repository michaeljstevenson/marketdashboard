// Serves the RSI Mean-Reversion / Short-Term Reversal Screen data (current
// cross-sectional RSI snapshot, sector medians, oversold/overbought
// leaderboards, and the accumulating weekly reversal-pair history) computed
// by scheduled-rsi-reversal-background.js. Makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob and derives the market-median
// RSI history line from the same history points the reversal test uses.

const { getRsiReversalStore, LATEST_KEY, HISTORY_KEY } = require("./rsi-reversal-blob-store");

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

exports.handler = async () => {
  try {
    const store = getRsiReversalStore();
    const [latest, history] = await Promise.all([
      store.get(LATEST_KEY, { type: "json" }),
      store.get(HISTORY_KEY, { type: "json" }),
    ]);

    if (!latest) {
      throw new Error("RSI reversal data not yet populated, scheduled-rsi-reversal-background hasn't run yet");
    }

    const points = (history && history.points) || [];
    const medianRsiHistory = points.map((p) => ({
      date: p.date,
      medianRsi: median(Object.values(p.rsi || {})),
    }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ ...latest, medianRsiHistory }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
