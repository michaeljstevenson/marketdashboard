// Serves the small-cap-vs-mega-cap liquidity snapshot (cohort-level
// dollar-volume / Amihud illiquidity / Corwin-Schultz spread history, the
// Small/Mega Amihud ratio series, and the full per-ticker latest-day
// table) computed weekly by scheduled-smallcap-liquidity-background.js and
// stored in Netlify Blobs. This function makes no Alpha Vantage calls
// itself — it just reads the pre-computed blob. Mirrors earnings-
// revisions.js.

const { getSmallcapLiquidityStore, LATEST_KEY } = require("./smallcap-liquidity-blob-store");

exports.handler = async () => {
  try {
    const store = getSmallcapLiquidityStore();
    const payload = await store.get(LATEST_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Small-cap liquidity data not yet populated — scheduled-smallcap-liquidity-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
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
