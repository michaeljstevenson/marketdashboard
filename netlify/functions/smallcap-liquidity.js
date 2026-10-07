// Serves the Russell 2000 vs. S&P 500 liquidity snapshot (medians by
// index, size fifth and sector, monthly and weekly series, the gap test and
// the per-member table) computed weekly by
// scheduled-smallcap-liquidity-background.js and stored in Netlify Blobs.
// It only reads the pre-computed blob. Mirrors earnings-revisions.js.

const { getSmallcapLiquidityStore, LATEST_KEY } = require("./smallcap-liquidity-blob-store");

exports.handler = async () => {
  try {
    const store = getSmallcapLiquidityStore();
    const payload = await store.get(LATEST_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Small-cap liquidity data not yet populated, scheduled-smallcap-liquidity-background hasn't run yet");
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
