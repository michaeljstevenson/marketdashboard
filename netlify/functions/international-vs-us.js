// Serves the international-vs-US snapshot (aligned daily indexed price
// series for SPY/EFA/EEM/UUP and a trailing-return ladder) computed daily
// by scheduled-intl-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getIntlStore, BLOB_KEY } = require("./intl-blob-store");

exports.handler = async () => {
  try {
    const store = getIntlStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("International-vs-US data not yet populated — scheduled-intl-background hasn't run yet");
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
