// Serves the annual (sector-ETF) data for the sector-beeswarm page:
// calendar-year total returns for the 11 SPDR sector ETFs plus SPY across
// roughly the last 15 years, computed weekly by
// scheduled-beeswarm-annual-background.js and stored in Netlify Blobs.
// Makes no Alpha Vantage calls itself — just reads the pre-computed blob.

const { getBeeswarmStore, ANNUAL_KEY } = require("./beeswarm-blob-store");

exports.handler = async () => {
  try {
    const payload = await getBeeswarmStore().get(ANNUAL_KEY, { type: "json" });
    if (!payload || !payload.dates || !payload.dates.length || !payload.years || !payload.years.length) {
      throw new Error("Annual beeswarm data not yet populated — scheduled-beeswarm-annual-background hasn't run yet");
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
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
