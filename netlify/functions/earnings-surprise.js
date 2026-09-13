// Serves the earnings-surprise data (beat/miss rates and magnitude by
// sector and over time, the surprise-magnitude distribution, the
// beat/miss-persistence test, and the streak/biggest-surprise leaderboards)
// computed weekly by scheduled-surprise-background.js. Makes no Alpha
// Vantage calls itself — just reads the one pre-computed blob.

const { getSurpriseStore, LATEST_KEY } = require("./surprise-blob-store");

exports.handler = async () => {
  try {
    const store = getSurpriseStore();
    const latest = await store.get(LATEST_KEY, { type: "json" });

    if (!latest) {
      throw new Error("Earnings surprise data not yet populated — scheduled-surprise-background hasn't run yet");
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=21600",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(latest),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
