// Serves the long-history concentration series (charts G and H on
// concentration.html) from the blob written by
// scheduled-concentration-history-background.js.

const { getConcentrationStore } = require("./concentration-blob-store");

const HISTORY_BLOB_KEY = "history.json";

exports.handler = async () => {
  try {
    const store = getConcentrationStore();
    const payload = await store.get(HISTORY_BLOB_KEY, { type: "json" });
    if (!payload) {
      throw new Error("Concentration history not yet populated — scheduled-concentration-history-background hasn't run");
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
