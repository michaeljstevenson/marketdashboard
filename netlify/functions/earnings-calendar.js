// Serves the earnings-calendar snapshot (upcoming S&P 500 reports, implied
// growth, and the expectations-vs-surprise test) computed by
// scheduled-earnings-calendar-background.js. Makes no Alpha Vantage calls.

const { getEarningsCalendarStore, LATEST_KEY } = require("./earnings-calendar-blob-store");

exports.handler = async () => {
  try {
    const store = getEarningsCalendarStore();
    const latest = await store.get(LATEST_KEY, { type: "json" });
    if (!latest) {
      throw new Error("Earnings calendar data not yet populated, scheduled-earnings-calendar-background hasn't run yet");
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
