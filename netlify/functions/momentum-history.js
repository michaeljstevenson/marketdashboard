// Long-run S&P 500 series for the Price Momentum modal's chart: weekly closes
// 1980-2020, daily since 2021. Computed live, fetched lazily by the frontend
// only when that modal opens (it's a much bigger payload than the main /data
// endpoint's needs).

const SP500_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const WEEKLY_START = Date.UTC(1980, 0, 1) / 1000;
const WEEKLY_END = Date.UTC(2020, 11, 31) / 1000;
const DAILY_START = Date.UTC(2021, 0, 1) / 1000;

function toDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function fetchRange(interval, period1, period2) {
  const url = `${SP500_CHART_URL}?period1=${period1}&period2=${period2}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const payload = await res.json();
  const result = payload.chart.result[0];
  const timestamps = result.timestamp || [];
  const closes = result.indicators.quote[0].close || [];
  return timestamps
    .map((ts, i) => ({ date: toDateStr(ts * 1000), value: closes[i] }))
    .filter((p) => p.value !== null && p.value !== undefined)
    .map((p) => ({ date: p.date, value: round(p.value, 2) }));
}

exports.handler = async () => {
  try {
    const nowSec = Math.floor(Date.now() / 1000);

    const [weekly, daily] = await Promise.all([
      fetchRange("1wk", WEEKLY_START, WEEKLY_END),
      fetchRange("1d", DAILY_START, nowSec),
    ]);

    const merged = [...weekly, ...daily];

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(merged),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
