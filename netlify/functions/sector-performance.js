// Serves the sector performance data (absolute and relative-to-SPY
// returns across daily, weekly, MTD, QTD, YTD, and trailing 1/3/6/12-month
// timeframes for the 11 SPDR sector ETFs) computed daily by
// scheduled-sectors-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getSectorStore, BLOB_KEY } = require("./sector-blob-store");

exports.handler = async () => {
  try {
    const store = getSectorStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Sector performance not yet populated — scheduled-sectors-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=7200",
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
