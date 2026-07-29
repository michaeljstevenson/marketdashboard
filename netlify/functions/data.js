// Live sentiment + market data for the dashboard, computed fresh (subject to
// edge caching, see Cache-Control below) on every request.
//
// Every factor score below is computed by us — none of CNN's own per-factor
// or composite scores are used. Only the raw underlying values (VIX level,
// put/call ratio, breadth reading, junk bond demand reading, S&P momentum
// reading) come from CNN's Fear & Greed API; everything derived from them
// (scores, percentiles, the composite, and its history) is our own math:
// each factor's current reading relative to its own 50-day moving average,
// ranked against that ratio's own history.
//
// S&P 500 price data (Price Momentum's displayed value) comes from Alpha
// Vantage's SPY ETF series, not a true index feed: Yahoo Finance (which has
// the real index) blocks Netlify's IP range, and Alpha Vantage's free tier
// only covers traded securities, not raw index levels (needs a paid plan).
// SPY tracks the S&P 500 index almost exactly (~1:10 scale).

const CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HISTORY_POINTS = 180; // ~6 months, kept compact for the browser
const SCORE_MA_WINDOW = 50; // trading days, applied consistently across all 5 factors

// invert: true means "reading above its own MA" = fear (lower score) —
// e.g. VIX and put/call spiking above trend is bearish. false means
// "reading above its own MA" = greed (higher score) — e.g. breadth, junk
// bond demand, and price momentum running hot above trend is bullish.
// Directions verified empirically against CNN's own current fear/greed
// ratings for each factor (value-vs-MA sign vs. CNN's rating sign).
// Weights are tilted rather than equal: Credit and Breadth are structural/
// leading signals (credit markets tend to react before equity sentiment
// fully turns; breadth reveals whether participation is broad or narrow
// underneath the headline index). Volatility is forward-looking by
// construction (derived from options-implied future volatility). Put/Call
// and Momentum are weighted down — put/call is noisier day-to-day (partly
// institutional hedging, not pure sentiment), and momentum is lagging by
// nature (derived from the same price action sentiment is meant to explain).
const COMPONENTS = [
  {
    id: "breadth",
    cnnKey: "stock_price_breadth",
    name: "Market Breadth",
    unit: "advance/decline volume",
    weight: 25,
    invert: false,
    description: "Breadth running above its trend reflects broad market participation.",
  },
  {
    id: "credit",
    cnnKey: "junk_bond_demand",
    name: "Credit Conditions",
    unit: "index",
    weight: 25,
    invert: false,
    description: "Junk bond demand running above its trend indicates risk appetite.",
  },
  {
    id: "vix",
    cnnKey: "market_volatility_vix",
    name: "Volatility",
    unit: "index",
    weight: 20,
    invert: true,
    description: "Elevated volatility relative to its recent trend reflects investor fear.",
  },
  {
    id: "putcall",
    cnnKey: "put_call_options",
    name: "Equity Put/Call Ratio",
    unit: "ratio",
    weight: 15,
    invert: true,
    description: "A rising put/call ratio relative to trend indicates bearish positioning.",
  },
  {
    id: "momentum",
    cnnKey: "market_momentum_sp500",
    name: "Price Momentum",
    unit: "index", // overwritten with "% vs 90-day MA" once SPY data resolves
    weight: 15,
    invert: false,
    description: "Strong price trends relative to the recent average increase investor optimism.",
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

function percentileRank(values, latestValue) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const below = sorted.filter((v) => v <= latestValue).length;
  return Math.round((100 * below) / sorted.length);
}

// Computes a self-derived 0-100 score for every date in `points` that has
// enough trailing history for a moving average: today's (or that day's)
// reading relative to its own trailing MA, ranked against that ratio's
// entire history. Returns [{x, score, value, ma, ratio, ratioPercentile}],
// aligned to points[window-1..]. Uses a single full-sample ranking (not an
// expanding/point-in-time window), so historical scores here are internally
// consistent but not exactly what would have been shown live on that date.
function computeRelativeScoreSeries(points, window, invert) {
  const values = points.map((p) => p.y);
  if (values.length < window) return [];

  const mas = [];
  const ratios = [];
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1);
    const ma = slice.reduce((sum, v) => sum + v, 0) / window;
    mas.push(ma);
    ratios.push(values[i] / ma);
  }

  const sortedRatios = [...ratios].sort((a, b) => a - b);
  const rankedPoints = points.slice(window - 1).map((p, idx) => {
    const ratio = ratios[idx];
    const below = sortedRatios.filter((x) => x <= ratio).length;
    const ratioPercentile = round((100 * below) / sortedRatios.length, 1);
    return {
      x: p.x,
      value: p.y,
      ma: mas[idx],
      ratio,
      ratioPercentile,
      score: round(invert ? 100 - ratioPercentile : ratioPercentile, 1),
    };
  });

  return rankedPoints;
}

function buildComponent(raw, spec) {
  const cat = raw[spec.cnnKey];
  const history = cat.data || [];
  const latestValue = history.length ? history[history.length - 1].y : null;
  const trimmed = history.slice(-HISTORY_POINTS);

  const scoreSeries = computeRelativeScoreSeries(history, SCORE_MA_WINDOW, spec.invert);
  const latest = scoreSeries.length ? scoreSeries[scoreSeries.length - 1] : null;

  return {
    id: spec.id,
    name: spec.name,
    value: latestValue !== null ? round(latestValue, 2) : null,
    unit: spec.unit,
    percentile: latestValue !== null ? percentileRank(history.map((p) => p.y), latestValue) : null,
    score: latest ? latest.score : 50,
    weight: spec.weight,
    description: spec.description,
    history: trimmed.map((p) => ({
      date: toDateStr(p.x),
      value: round(p.y, 3),
    })),
    calc: latest
      ? {
          window: SCORE_MA_WINDOW,
          invert: spec.invert,
          value: round(latest.value, 3),
          ma: round(latest.ma, 3),
          ratio: round(latest.ratio, 4),
          ratioPercentile: latest.ratioPercentile,
        }
      : null,
    scoreSeries, // used to build the composite history below; stripped before response
  };
}

// 90 rather than the conventional 125 trading days: Alpha Vantage's free
// tier caps daily history at 100 points, which isn't quite enough for a
// true 125-day window. This only affects Price Momentum's *displayed*
// value/unit (live SPY data); its score uses CNN's deeper index-level
// history via computeRelativeScoreSeries above, same as the other factors.
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

    const spyPrice = spyDaily.length ? spyDaily[spyDaily.length - 1].value : null;
    const momentum = components.find((c) => c.id === "momentum");
    const vsMa = computeMomentumVsMA(spyPrice, spyDaily);
    if (vsMa !== null) {
      momentum.value = vsMa;
      momentum.unit = `% vs ${MA_WINDOW}-day MA`;
    }

    const composite = Math.round(
      components.reduce((sum, c) => sum + c.score * c.weight, 0) /
        components.reduce((sum, c) => sum + c.weight, 0)
    );

    // Composite history: our own weighted average of each factor's
    // self-computed score series, date-aligned, paired with SPY closes.
    // (Replaces the earlier version, which used CNN's own blended score
    // across CNN's 7 factors as a proxy — no longer needed now that we can
    // compute a real historical composite from our own per-factor scores.)
    const totalWeight = COMPONENTS.reduce((sum, c) => sum + c.weight, 0);
    const compositeByDate = new Map();
    for (const comp of components) {
      const weight = COMPONENTS.find((c) => c.id === comp.id).weight;
      for (const point of comp.scoreSeries) {
        const dateStr = toDateStr(point.x);
        const entry = compositeByDate.get(dateStr) || { weightedSum: 0, weightSeen: 0 };
        entry.weightedSum += point.score * weight;
        entry.weightSeen += weight;
        compositeByDate.set(dateStr, entry);
      }
    }

    const spyByDate = new Map(spyDaily.map((p) => [p.date, p.value]));
    const spyDatesSorted = spyDaily.map((p) => p.date).sort();
    function nearestSpy(dateStr) {
      if (spyByDate.has(dateStr)) return spyByDate.get(dateStr);
      const earlier = spyDatesSorted.filter((d) => d <= dateStr);
      return earlier.length ? spyByDate.get(earlier[earlier.length - 1]) : null;
    }

    const history = [...compositeByDate.keys()]
      .sort()
      .filter((d) => compositeByDate.get(d).weightSeen === totalWeight) // only dates all 5 factors covered
      .slice(-HISTORY_POINTS)
      .map((d) => {
        const entry = compositeByDate.get(d);
        return {
          date: d,
          optimism: Math.round(entry.weightedSum / entry.weightSeen),
          spy: nearestSpy(d),
        };
      });

    for (const comp of components) delete comp.scoreSeries; // internal-only

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
