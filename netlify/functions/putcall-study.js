// Serves the put/call ratio page's payload from the putcall-study blob.

const { getPutCallStudyStore, BLOB_KEY } = require("./putcall-study-blob-store");

exports.handler = async () => {
  try {
    const data = await getPutCallStudyStore().get(BLOB_KEY, { type: "json" });
    if (!data) {
      return { statusCode: 503, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Put/call study not built yet" }) };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: err.message }) };
  }
};
