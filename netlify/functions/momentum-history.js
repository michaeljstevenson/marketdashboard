// SPY series for the Price Momentum modal's chart. Yahoo Finance has true
// S&P 500 index data going back to 1980, but blocks Netlify's IP range.
// Alpha Vantage's free tier works from Netlify but caps daily history at
// 100 points (~4-5 months) — outputsize=full requires a paid plan. See
// data.js for the fuller explanation.

const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function fetchSpyDaily(apiKey) {
  const url = `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY&symbol=SPY&outputsize=compact&apikey=${apiKey}`;
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for Alpha Vantage`);
  const payload = await res.json();

  const series = payload["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      "Alpha Vantage response missing daily series: " + (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 200))
    );
  }

  return Object.entries(series)
    .map(([date, day]) => ({ date, value: round(parseFloat(day["4. close"]), 2) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const series = await fetchSpyDaily(apiKey);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // This barely changes intraday and Alpha Vantage's free tier has a
        // tight daily quota, so cache generously at the edge.
        "Cache-Control": "public, max-age=21600",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(series),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
