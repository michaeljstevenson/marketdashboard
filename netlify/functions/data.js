// Live sentiment + market data for the dashboard, computed fresh (subject to
// edge caching, see Cache-Control below) on every request.
//
// S&P 500 price data comes from Alpha Vantage's SPY ETF series, not a true
// index feed: Yahoo Finance (which has the real index) blocks Netlify's IP
// range, and Alpha Vantage's free tier only covers traded securities, not
// raw index levels (that needs a paid plan). SPY tracks the S&P 500 index
// almost exactly (~1:10 scale), so it's used as the practical substitute.

const CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HISTORY_POINTS = 180; // ~6 months, kept compact for the browser

const COMPONENTS = [
  {
    id: "vix",
    cnnKey: "market_volatility_vix",
    name: "Volatility",
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
    unit: "index", // overwritten with "% vs 90-day MA" once SPY data resolves
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

async function fetchSpyDaily(apiKey, outputsize) {
  const url = `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY&symbol=SPY&outputsize=${outputsize}&apikey=${apiKey}`;
  const payload = await fetchJson(url, { "User-Agent": USER_AGENT });

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

// 90 rather than the conventional 125 trading days: Alpha Vantage's free
// tier caps daily history at 100 points, which isn't quite enough for a
// true 125-day window.
const MA_WINDOW = 90;

function computeMomentumVsMA(spyPrice, spyDaily) {
  if (spyPrice === null || spyDaily.length < MA_WINDOW) return null;
  const window = spyDaily.slice(-MA_WINDOW);
  const ma = window.reduce((sum, p) => sum + p.value, 0) / window.length;
  return round((spyPrice / ma - 1) * 100, 2);
}

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const now = new Date();

    const [raw, spyDaily] = await Promise.all([fetchCnn(), fetchSpyDaily(apiKey, "compact")]);

    const components = COMPONENTS.map((spec) => buildComponent(raw, spec));
    const composite = Math.round(
      components.reduce((sum, c) => sum + c.score * c.weight, 0) /
        components.reduce((sum, c) => sum + c.weight, 0)
    );

    const spyPrice = spyDaily.length ? spyDaily[spyDaily.length - 1].value : null;
    const momentum = components.find((c) => c.id === "momentum");
    const vsMa = computeMomentumVsMA(spyPrice, spyDaily);
    if (vsMa !== null) {
      momentum.value = vsMa;
      momentum.unit = `% vs ${MA_WINDOW}-day MA`;
    }

    // Optimism-vs-SPY history: CNN's own composite score history (same proxy
    // rationale as the old backfill script) paired with SPY closes.
    const compositeHistory = (raw.fear_and_greed_historical.data || []).slice(-HISTORY_POINTS);
    const spyByDate = new Map(spyDaily.map((p) => [p.date, p.value]));
    const spyDatesSorted = spyDaily.map((p) => p.date).sort();

    function nearestSpy(dateStr) {
      if (spyByDate.has(dateStr)) return spyByDate.get(dateStr);
      const earlier = spyDatesSorted.filter((d) => d <= dateStr);
      return earlier.length ? spyByDate.get(earlier[earlier.length - 1]) : null;
    }

    const historyByDate = new Map();
    for (const point of compositeHistory) {
      const dateStr = toDateStr(point.x);
      historyByDate.set(dateStr, {
        date: dateStr,
        optimism: Math.round(point.y),
        spy: nearestSpy(dateStr),
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
        // Cached at the edge to stay well within Alpha Vantage's 25 req/day
        // free-tier limit — a refresh within this window serves the cached
        // response rather than triggering a new upstream call.
        "Cache-Control": "public, max-age=7200",
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
