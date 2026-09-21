// Serves the Magnificent Seven concentration series (charts C and F on
// concentration.html) from the blob written by
// scheduled-concentration-background.js. No upstream calls here.

const { getConcentrationStore, BLOB_KEY } = require("./concentration-blob-store");

exports.handler = async () => {
  try {
    const store = getConcentrationStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });
    if (!payload) {
      throw new Error("Concentration series not yet populated, scheduled-concentration-background hasn't run");
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
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
