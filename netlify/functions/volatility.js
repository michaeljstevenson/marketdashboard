// Realized vs. Implied Volatility research page data.
//
// This uses the textbook definitions, deliberately different from the
// ATR-based "Realized Volatility" factor in the sentiment index (data.js):
// that factor prioritizes simplicity and consistency with the rest of the
// dashboard's scoring method. This page is meant to stand on its own as a
// recognizable comparison to anyone with finance training, so it uses the
// standard construction instead:
//   - Realized volatility: 20-trading-day rolling standard deviation of
//     daily log returns, annualized (x sqrt(252)) and expressed as a %.
//   - Implied volatility: the VIX itself, which is already an annualized
//     30-day-forward volatility estimate by construction — no transform.
// The gap between them (implied - realized) is the "volatility risk
// premium": historically positive most of the time (options tend to
// slightly overprice future volatility), so its sign and size are
// interesting in their own right.

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const REALIZED_VOL_WINDOW = 20; // trading days
const HISTORY_POINTS = 180; // ~6 months

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function fetchIndexDaily(apiKey, symbol) {
  const url = `${ALPHA_VANTAGE_URL}?function=INDEX_DATA&symbol=${symbol}&interval=daily&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for INDEX_DATA ${symbol}`);
  const payload = await res.json();

  const data = payload.data;
  if (!data || !data.length) {
    throw new Error(`Alpha Vantage INDEX_DATA missing data for ${symbol}: ` + (payload.Note || payload.Information || payload.error || JSON.stringify(payload).slice(0, 200)));
  }

  return data
    .map((d) => ({ date: d.date, close: parseFloat(d.close) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function computeRealizedVolSeries(closes, window) {
  const points = [];
  for (let i = window; i < closes.length; i++) {
    const rets = [];
    for (let j = i - window + 1; j <= i; j++) {
      rets.push(Math.log(closes[j].close / closes[j - 1].close));
    }
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    const annualized = Math.sqrt(variance) * Math.sqrt(252) * 100;
    points.push({ date: closes[i].date, value: annualized });
  }
  return points;
}

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    // Sequential, not Promise.all: firing both at once trips Alpha
    // Vantage's burst-rate detector (same issue hit in ticker.js).
    const spx = await fetchIndexDaily(apiKey, "SPX");
    const vix = await fetchIndexDaily(apiKey, "VIX");

    const realizedSeries = computeRealizedVolSeries(spx, REALIZED_VOL_WINDOW);
    const vixByDate = new Map(vix.map((v) => [v.date, v.close]));

    const merged = realizedSeries
      .filter((p) => vixByDate.has(p.date))
      .map((p) => ({
        date: p.date,
        realized: round(p.value, 2),
        implied: round(vixByDate.get(p.date), 2),
        spread: round(vixByDate.get(p.date) - p.value, 2),
      }));

    const trimmed = merged.slice(-HISTORY_POINTS);
    const latest = merged.length ? merged[merged.length - 1] : null;

    const now = new Date();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=7200",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        timestamp: now.toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }) + " ET",
        latest,
        history: trimmed,
        window: REALIZED_VOL_WINDOW,
      }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
