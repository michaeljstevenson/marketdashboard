// Serves the R&D intensity snapshot computed by
// scheduled-rd-intensity-background.js and stored in Netlify Blobs. This
// function makes no Alpha Vantage calls itself — it just reads the
// pre-computed blob.

const { getRdIntensityStore, BLOB_KEY } = require("./rd-intensity-blob-store");

exports.handler = async () => {
  try {
    const store = getRdIntensityStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload) {
      throw new Error("R&D intensity data not yet populated — scheduled-rd-intensity-background hasn't run yet");
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
