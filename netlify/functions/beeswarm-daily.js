// Serves one day's end-of-day sector-beeswarm snapshot for the
// sector-beeswarm page, plus the list of archived dates so the page can
// build its date scrubber. Snapshots are captured after each close by
// scheduled-beeswarm-daily-background.js and stored one blob per day.
// Makes no Alpha Vantage calls itself.
//
//   GET /api/beeswarm-daily              -> latest archived day
//   GET /api/beeswarm-daily?date=2026-09-08 -> that day (404 if not archived)

const { getBeeswarmStore, DAY_INDEX_KEY, dayKey } = require("./beeswarm-blob-store");

exports.handler = async (event) => {
  try {
    const store = getBeeswarmStore();
    const index = await store.get(DAY_INDEX_KEY, { type: "json" });
    const dates = (index && index.dates) || [];
    if (!dates.length) {
      throw new Error("No beeswarm snapshots archived yet — scheduled-beeswarm-daily-background hasn't run");
    }

    const requested = event.queryStringParameters && event.queryStringParameters.date;
    const date = requested || dates[dates.length - 1];
    if (requested && !dates.includes(requested)) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: JSON.stringify({ error: `No snapshot for ${requested}`, dates }),
      };
    }

    const day = await store.get(dayKey(date), { type: "json" });
    if (!day) throw new Error(`Snapshot blob for ${date} is missing`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // A given past day never changes; today's keeps updating until the
        // next close. Short-ish cache is a fine middle ground.
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ ...day, dates }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
