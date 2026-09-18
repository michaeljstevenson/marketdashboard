// Serves the "Institutional Ownership & Smart-Money Flow" latest snapshot,
// pre-computed by scheduled-institutional-holdings-background.js and stored
// in Netlify Blobs. This function makes no outbound calls itself — it just
// reads the pre-computed blob.

const { getInstitutionalHoldingsStore, LATEST_KEY } = require("./institutional-holdings-blob-store");

exports.handler = async () => {
  try {
    const store = getInstitutionalHoldingsStore();
    const payload = await store.get(LATEST_KEY, { type: "json" });

    if (!payload) {
      throw new Error("Institutional holdings data not yet populated — scheduled-institutional-holdings-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
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
