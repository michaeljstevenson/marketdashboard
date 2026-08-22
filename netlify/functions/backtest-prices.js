// On-demand daily adjusted price history for the backtesting page
// (/backtesting.html). Fetched live per request (not scheduled/cached in
// Blobs) since backtests are run ad hoc against whatever ticker + date
// range the user picks — unlike the sector/breadth/ticker jobs, there's
// no fixed small universe of symbols worth pre-computing. The frontend
// caches the response client-side (sessionStorage) so repeated runs
// against the same ticker in one sitting don't re-hit Alpha Vantage.

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const { recordAvCall } = require("./av-call-counter");

async function fetchJson(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

exports.handler = async (event) => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const symbol = (event.queryStringParameters && event.queryStringParameters.symbol || "").trim().toUpperCase();
    if (!symbol) throw new Error("Missing required 'symbol' query parameter");
    if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) throw new Error(`Invalid symbol: ${symbol}`);

    const payload = await fetchJson(
      `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${apiKey}`
    );

    const series = payload["Time Series (Daily)"];
    if (!series) {
      throw new Error(
        `Alpha Vantage TIME_SERIES_DAILY_ADJUSTED missing data for ${symbol}: ` +
          (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 200))
      );
    }

    // adjClose (total-return, dividend/split-adjusted) drives all
    // return/equity-curve math; rawClose (unadjusted) drives stop-loss and
    // take-profit checks and the chart's price display, since those
    // should reflect what price was actually observable that day, not a
    // retroactively-adjusted figure.
    const bars = Object.entries(series)
      .map(([date, day]) => ({
        date,
        open: round(parseFloat(day["1. open"]), 4),
        high: round(parseFloat(day["2. high"]), 4),
        low: round(parseFloat(day["3. low"]), 4),
        rawClose: round(parseFloat(day["4. close"]), 4),
        adjClose: round(parseFloat(day["5. adjusted close"]), 4),
        volume: parseInt(day["6. volume"], 10) || 0,
        dividend: round(parseFloat(day["7. dividend amount"]) || 0, 4),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ symbol, bars }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
