// Serves the earnings-quality/accruals snapshot computed by
// scheduled-accruals-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getAccrualsStore, BLOB_KEY } = require("./accruals-blob-store");

exports.handler = async () => {
  try {
    const store = getAccrualsStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Accruals data not yet populated — scheduled-accruals-background hasn't run yet");
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
