// Serves the market-level concentration series for concentration.html:
//
//   - SPY  (cap-weighted S&P 500 proxy) daily adjusted close
//   - RSP  (equal-weighted S&P 500 proxy) daily adjusted close
//
// Both as split/dividend-adjusted closes (total-return proxies), from
// RSP's April 2003 inception to present. The page indexes each to 100 at
// the first common date and also plots the equal/cap relative-strength
// ratio (chart D).
//
// Only two Alpha Vantage calls per invocation, so this runs live (with a
// long cache header) rather than via a scheduled blob job like the
// 500-symbol breadth feed.

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SYMBOLS = ["SPY", "RSP"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDailyAdjusted(apiKey, symbol) {
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const payload = await res.json();
  const series = payload["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      `Alpha Vantage TIME_SERIES_DAILY_ADJUSTED missing data for ${symbol}: ` +
        (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 200))
    );
  }
  const out = new Map();
  for (const [date, day] of Object.entries(series)) {
    const v = parseFloat(day["5. adjusted close"]);
    if (Number.isFinite(v)) out.set(date, v);
  }
  return out;
}

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const bySymbol = {};
    for (const symbol of SYMBOLS) {
      bySymbol[symbol] = await fetchDailyAdjusted(apiKey, symbol);
      await sleep(300);
    }

    // Intersection of dates both series report, ascending. RSP's
    // inception (~2003-04-24) sets the start.
    const dates = [...bySymbol.SPY.keys()]
      .filter((d) => bySymbol.RSP.has(d))
      .sort();

    const rows = dates.map((date) => ({
      date,
      spy: bySymbol.SPY.get(date),
      rsp: bySymbol.RSP.get(date),
    }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      note:
        "SPY = cap-weighted S&P 500 proxy, RSP = equal-weighted S&P 500 proxy. " +
        "Split/dividend-adjusted closes (total-return basis). Common trading dates only.",
      rows,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=43200",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
