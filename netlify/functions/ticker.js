// Serves the homepage ticker tape's data, computed every 15 minutes
// during market hours by scheduled-ticker-background.js and stored in
// Netlify Blobs. This function itself makes no Alpha Vantage calls — it
// just reads the pre-computed blob, so it's fast and cheap regardless of
// page-load volume (this used to fetch live on every request; see
// scheduled-ticker-background.js for why that stopped being viable once
// the watchlist grew to ~150 stocks).

const { getTickerStore, BLOB_KEY } = require("./ticker-blob-store");

exports.handler = async () => {
  try {
    const store = getTickerStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload || !payload.items || !payload.items.length) {
      throw new Error("Ticker data not yet populated — scheduled-ticker-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
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
