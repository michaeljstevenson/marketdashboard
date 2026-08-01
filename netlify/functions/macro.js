// Macro stats (Fed funds rate, Treasury yields) shown alongside the
// homepage ticker. These are daily-cadence economic series, not something
// that needs sub-hour freshness, so this is cached for 24h — keeps total
// Alpha Vantage usage low and comfortably within the free tier's 25
// requests/day cap alongside the sentiment index's own usage in data.js.
//
// The 10Yr-3Mo spread is computed here rather than fetched: it's the
// classic recession-warning indicator (inversion = 10Yr below 3Mo).

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

async function fetchSeries(apiKey, params) {
  const url = `${ALPHA_VANTAGE_URL}?${params}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${params}`);
  const payload = await res.json();
  const data = payload.data;
  if (!data || !data.length) {
    throw new Error("Missing data: " + (payload.Note || payload.Information || JSON.stringify(payload).slice(0, 200)));
  }
  return parseFloat(data[0].value);
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    // Sequential with a delay: Alpha Vantage's free tier caps bursts at
    // 1 request/second, and firing these three in parallel trips that.
    const fedFunds = await fetchSeries(apiKey, "function=FEDERAL_FUNDS_RATE&interval=daily");
    await sleep(1100);
    const us10y = await fetchSeries(apiKey, "function=TREASURY_YIELD&interval=daily&maturity=10year");
    await sleep(1100);
    const us03m = await fetchSeries(apiKey, "function=TREASURY_YIELD&interval=daily&maturity=3month");

    const data = {
      fedFunds: round(fedFunds, 2),
      us10y: round(us10y, 2),
      us03m: round(us03m, 2),
      spread: round(us10y - us03m, 2),
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
