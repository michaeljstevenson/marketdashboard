// Serves the Fama-French daily factor history computed weekly by
// scheduled-factors-background.js and stored in Netlify Blobs. This
// function makes no outbound requests itself — it just reads the
// pre-computed blob.

const { getFactorsStore, BLOB_KEY } = require("./factors-blob-store");

exports.handler = async () => {
  try {
    const store = getFactorsStore();
    const payload = await store.get(BLOB_KEY, { type: "json" });

    if (!payload || !payload.rows || !payload.rows.length) {
      throw new Error("Factor data not yet populated — scheduled-factors-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
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
