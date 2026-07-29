// Live sentiment + market data for the dashboard, computed fresh on every request.
// Port of fetch_data.py's logic to run as a Netlify Function (server-side, so no
// CORS issue reaching CNN/Yahoo — browsers can't call those APIs directly).

const CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const SP500_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HISTORY_POINTS = 180; // ~6 months, kept compact for the browser

const COMPONENTS = [
  {
    id: "vix",
    cnnKey: "market_volatility_vix",
    name: "VIX Volatility",
    unit: "index",
    weight: 20,
    description: "Low volatility usually reflects investor confidence.",
  },
  {
    id: "putcall",
    cnnKey: "put_call_options",
    name: "Equity Put/Call Ratio",
    unit: "ratio",
    weight: 20,
    description: "Low put demand indicates bullish positioning.",
  },
  {
    id: "breadth",
    cnnKey: "stock_price_breadth",
    name: "Market Breadth",
    unit: "advance/decline volume",
    weight: 20,
    description: "Measures participation beneath the headline index.",
  },
  {
    id: "momentum",
    cnnKey: "market_momentum_sp500",
    name: "Price Momentum",
    unit: "S&P 500 vs 125-day avg",
    weight: 20,
    description: "Strong price trends increase investor optimism.",
  },
  {
    id: "credit",
    cnnKey: "junk_bond_demand",
    name: "Credit Conditions",
    unit: "HY bond spread proxy",
    weight: 20,
    description: "Narrow credit spreads suggest risk appetite.",
  },
];

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function fetchCnn() {
  return fetchJson(CNN_URL, {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Referer: "https://www.cnn.com/markets/fear-and-greed",
  });
}

function fetchSP500Range(interval, period1, period2) {
  const url = `${SP500_CHART_URL}?period1=${period1}&period2=${period2}&interval=${interval}`;
  return fetchJson(url, { "User-Agent": USER_AGENT }).then((payload) => {
    const result = payload.chart.result[0];
    const timestamps = result.timestamp || [];
    const closes = result.indicators.quote[0].close || [];
    return timestamps
      .map((ts, i) => ({ date: toDateStr(ts * 1000), value: closes[i] }))
      .filter((p) => p.value !== null && p.value !== undefined)
      .map((p) => ({ date: p.date, value: round(p.value, 2) }));
  });
}

function toDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function percentileRank(history, latestValue) {
  const values = history.map((p) => p.y).sort((a, b) => a - b);
  if (!values.length) return null;
  const below = values.filter((v) => v <= latestValue).length;
  return Math.round((100 * below) / values.length);
}

function buildComponent(raw, spec) {
  const cat = raw[spec.cnnKey];
  const history = cat.data || [];
  const latestValue = history.length ? history[history.length - 1].y : null;
  const trimmed = history.slice(-HISTORY_POINTS);

  return {
    id: spec.id,
    name: spec.name,
    value: latestValue !== null ? round(latestValue, 2) : null,
    unit: spec.unit,
    percentile: latestValue !== null ? percentileRank(history, latestValue) : null,
    score: round(cat.score, 1),
    weight: spec.weight,
    description: spec.description,
    history: trimmed.map((p) => ({
      date: toDateStr(p.x),
      value: round(p.y, 3),
    })),
  };
}

function computeMomentumVsMA(sp500Price, sp500Daily) {
  if (sp500Price === null || sp500Daily.length < 125) return null;
  const last125 = sp500Daily.slice(-125);
  const ma125 = last125.reduce((sum, p) => sum + p.value, 0) / last125.length;
  return round((sp500Price / ma125 - 1) * 100, 2);
}

exports.handler = async () => {
  try {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const daysAgo220 = nowSec - 220 * 24 * 60 * 60; // buffer past 125 trading days

    const [raw, sp500Daily] = await Promise.all([
      fetchCnn(),
      fetchSP500Range("1d", daysAgo220, nowSec),
    ]);

    const components = COMPONENTS.map((spec) => buildComponent(raw, spec));
    const composite = Math.round(
      components.reduce((sum, c) => sum + c.score * c.weight, 0) /
        components.reduce((sum, c) => sum + c.weight, 0)
    );

    const sp500Price = sp500Daily.length ? sp500Daily[sp500Daily.length - 1].value : null;
    const momentum = components.find((c) => c.id === "momentum");
    const vsMa = computeMomentumVsMA(sp500Price, sp500Daily);
    if (vsMa !== null) {
      momentum.value = vsMa;
      momentum.unit = "% vs 125-day MA";
    }

    // Optimism-vs-S&P-500 history: CNN's own composite score history (same
    // proxy rationale as the old backfill script) paired with S&P 500 closes.
    const compositeHistory = (raw.fear_and_greed_historical.data || []).slice(-HISTORY_POINTS);
    const sp500ByDate = new Map(sp500Daily.map((p) => [p.date, p.value]));
    const sp500DatesSorted = sp500Daily.map((p) => p.date).sort();

    function nearestSP500(dateStr) {
      if (sp500ByDate.has(dateStr)) return sp500ByDate.get(dateStr);
      const earlier = sp500DatesSorted.filter((d) => d <= dateStr);
      return earlier.length ? sp500ByDate.get(earlier[earlier.length - 1]) : null;
    }

    const historyByDate = new Map();
    for (const point of compositeHistory) {
      const dateStr = toDateStr(point.x);
      historyByDate.set(dateStr, {
        date: dateStr,
        optimism: Math.round(point.y),
        sp500: nearestSP500(dateStr),
      });
    }
    const history = [...historyByDate.keys()].sort().map((d) => historyByDate.get(d));

    const data = {
      timestamp: now.toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }) + " ET",
      fetched_at_utc: now.toISOString(),
      composite,
      components,
      history,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
