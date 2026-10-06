// Serves the 52-Week High Momentum data (current cross-sectional
// range-position snapshot, sector medians, near-high/near-low leaderboards,
// and the accumulating weekly momentum-pair history) computed by
// scheduled-high52-momentum-background.js. Makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob and derives the
// market-median range-position history from the same history points the
// momentum test uses.

const { getHigh52Store, LATEST_KEY, HISTORY_KEY } = require("./high52-momentum-blob-store");

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

exports.handler = async () => {
  try {
    const store = getHigh52Store();
    const [latest, history] = await Promise.all([
      store.get(LATEST_KEY, { type: "json" }),
      store.get(HISTORY_KEY, { type: "json" }),
    ]);

    if (!latest) {
      throw new Error("52-week high momentum data not yet populated, scheduled-high52-momentum-background hasn't run yet");
    }

    const points = (history && history.points) || [];
    const medianRangePosHistory = points.map((p) => ({
      date: p.date,
      medianRangePos: median(Object.values(p.rangePos || {})),
    }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ ...latest, medianRangePosHistory }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
