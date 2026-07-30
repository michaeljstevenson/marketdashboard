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

const { MANUAL_SERIES } = require("./manual-data");

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
// Weights below sum to 70 (daily/live factors) + 30 (the 3 manual factors
// defined in MANUAL_COMPONENTS, 10% each) = 100. Original ratios among
// these 5 preserved, scaled down from 100 to 70 to make room for the
// manual factors — see MANUAL_COMPONENTS for why those are capped at 10%
// each (lower frequency, human-updated data shouldn't dominate a live
// composite the way daily-refreshed factors do).
const COMPONENTS = [
  {
    id: "breadth",
    cnnKey: "stock_price_breadth",
    name: "Market Breadth",
    unit: "advance/decline volume",
    weight: 18,
    invert: false,
    description: "Breadth running above its trend reflects broad market participation.",
    details:
      "Market breadth measures how many stocks are participating in a market move, not just how the headline index is performing. It tracks the cumulative volume flowing into advancing stocks versus declining stocks — a rising line means gains are broad-based across many stocks, while a falling line can signal a rally is being carried by just a few large names, or that a decline is spreading beneath the surface.\n\nThis dashboard scores breadth by comparing today's reading to its own 50-day moving average. When breadth is running above its recent trend, more stocks are meaningfully participating in the market's direction, which tends to reflect confidence. When it's running below trend, participation is narrowing — often an early warning sign that a rally is more fragile than the index price alone suggests.",
  },
  {
    id: "credit",
    cnnKey: "junk_bond_demand",
    name: "Credit Conditions",
    unit: "index",
    weight: 18,
    invert: false,
    description: "Junk bond demand running above its trend indicates risk appetite.",
    details:
      "Credit Conditions tracks demand for high-yield (\"junk\") bonds relative to safer investment-grade debt. Junk bonds carry more default risk, so investors only chase them aggressively when they're feeling confident about the economy and corporate health; when fear rises, capital typically rotates out of junk bonds and into safer assets first — often before that caution shows up in stock prices.\n\nBecause credit investors are generally more risk-averse and tend to reprice risk earlier than equity markets, this factor is treated as one of the more forward-looking signals here (and weighted accordingly). The score compares today's junk bond demand to its own 50-day average: demand running above trend suggests risk appetite is increasing, while demand falling below trend can flag credit stress starting to build.",
  },
  {
    id: "vix",
    cnnKey: "market_volatility_vix",
    name: "Volatility",
    unit: "index",
    weight: 14,
    invert: true,
    description: "Elevated volatility relative to its recent trend reflects investor fear.",
    details:
      "The VIX (often called the market's \"fear gauge\") measures how much volatility options traders expect in the S&P 500 over the next 30 days, derived from the prices they're willing to pay for options. It doesn't measure what already happened — it measures what the market is bracing for, which makes it forward-looking rather than a reflection of past price action.\n\nRather than using the VIX's raw level (which drifts up and down with the broader volatility regime over months and years), this dashboard compares today's VIX to its own 50-day moving average. A VIX spiking well above its recent trend signals rising fear and uncertainty; a VIX sitting below its recent trend suggests calm, complacent conditions.",
  },
  {
    id: "putcall",
    cnnKey: "put_call_options",
    name: "Equity Put/Call Ratio",
    unit: "ratio",
    weight: 10,
    invert: true,
    description: "A rising put/call ratio relative to trend indicates bearish positioning.",
    details:
      "This factor tracks the ratio of put options (bets that a stock or index will fall) to call options (bets that it will rise) being traded across equities. When investors are nervous, they buy more puts to hedge or speculate on declines, pushing the ratio up; when they're confident, call buying dominates and the ratio falls.\n\nThe raw ratio is noisy day to day — a meaningful share of options volume comes from institutional hedging rather than pure directional bets — so this dashboard smooths it by comparing today's ratio to its own 50-day average. A ratio running above trend leans bearish/fearful; a ratio running below trend leans bullish.",
  },
  {
    id: "momentum",
    cnnKey: "market_momentum_sp500",
    name: "Price Momentum",
    unit: "index", // overwritten with "% vs 90-day MA" once SPY data resolves
    weight: 10,
    invert: false,
    description: "Strong price trends relative to the recent average increase investor optimism.",
    details:
      "Price Momentum compares the S&P 500's current price to its own 90-day moving average, a simple trend-following signal: when the index is trading above its recent average, the market is in an established uptrend, which tends to coincide with optimism; when it's trading below, the trend has turned down.\n\nBecause this reading is derived directly from price — the same thing sentiment is meant to help explain — it's treated as a lagging, confirming signal here rather than a leading one, and is weighted accordingly. The score itself is based on the S&P 500's own momentum reading ranked against its longer history, while the number displayed on the card uses live SPY price data for timeliness.",
  },
];

// Manually-updated factors (see manual-data.js for sourcing and the
// update procedure). Each has its own trailing-average window sized to
// how much history is actually available, since none of these started
// with 50+ data points the way the CNN-sourced factors did — the window
// (and the statistical meaningfulness of the resulting percentile) grows
// as more readings are appended over time. invert:false for all three:
// rising margin debt, inflows, and rising valuations vs. their own trend
// all read as increasing risk appetite/greed here.
const MANUAL_COMPONENTS = [
  {
    id: "margindebt",
    manualKey: "marginDebt",
    name: "Margin Debt Growth",
    weight: 10,
    invert: false,
    window: 6,
    periodLabel: "month",
    description: "Margin debt growing faster than its trend signals rising leverage and risk appetite.",
    details:
      "Margin debt is money investors borrow against their brokerage accounts to buy more securities than their cash alone would allow. It tends to expand when investors are confident and reaching for more upside, and to contract sharply when fear rises and leveraged positions get unwound or forced out (margin calls).\n\nThis dashboard scores margin debt by comparing the latest month's reading to its own trailing 6-month average. Debt running above that trend suggests leverage — and risk appetite — is building; debt falling below it suggests deleveraging. Because FINRA only publishes this monthly and blocks automated fetching, this factor is updated by hand and carries a smaller (10%) weight than the daily live factors.",
  },
  {
    id: "fundflows",
    manualKey: "fundFlows",
    name: "Equity Fund Flows",
    weight: 10,
    invert: false,
    window: 4,
    periodLabel: "week",
    description: "Equity fund inflows running above trend reflect investors putting new money to work.",
    details:
      "This factor tracks ICI's weekly estimate of net cash flowing into (or out of) U.S. long-term equity mutual funds. Sustained inflows mean investors are actively committing new money to stocks; sustained outflows mean they're pulling money out, often a sign of caution or profit-taking.\n\nThe score compares the latest week's net flow to its own trailing 4-week average. Flows running above trend (more inflow, or less outflow, than usual) lean toward optimism; flows running below trend lean toward caution. ICI's site blocks automated fetching, so this factor is updated by hand weekly and carries a smaller (10%) weight than the daily live factors.",
  },
  {
    id: "forwardpe",
    manualKey: "forwardPE",
    name: "Forward P/E",
    weight: 10,
    invert: false,
    window: 2,
    periodLabel: "reading",
    description: "A forward P/E running above trend reflects rising valuations and investor optimism about future earnings.",
    details:
      "The forward P/E ratio compares the S&P 500's price to analysts' consensus earnings estimate for the next 12 months — a measure of how much investors are willing to pay today for expected future profits. Rising valuations typically reflect optimism about growth; falling valuations often reflect caution or reduced growth expectations.\n\nThis factor compares the latest reading to its own short trailing average. There's no free live index-level source for this figure (Alpha Vantage's data only covers individual stocks, not indices), so it's updated by hand from FactSet's free weekly Earnings Insight report and carries a smaller (10%) weight than the daily live factors.",
  },
];

function buildManualComponent(spec) {
  const series = MANUAL_SERIES[spec.manualKey];
  const history = series.history.map((p, i) => ({ x: i, y: p.value })); // synthetic x, dates aren't epoch ms here
  const latestValue = history.length ? history[history.length - 1].y : null;

  const scoreSeries = computeRelativeScoreSeries(history, spec.window, spec.invert);
  const latest = scoreSeries.length ? scoreSeries[scoreSeries.length - 1] : null;

  return {
    id: spec.id,
    name: spec.name,
    value: latestValue,
    unit: series.unit,
    percentile: latestValue !== null ? percentileRank(history.map((p) => p.y), latestValue) : null,
    score: latest ? latest.score : 50,
    weight: spec.weight,
    description: spec.description,
    details: spec.details,
    history: series.history.map((p) => ({ date: p.date, value: p.value })),
    calc: latest
      ? {
          window: spec.window,
          periodLabel: spec.periodLabel,
          invert: spec.invert,
          value: round(latest.value, 3),
          ma: round(latest.ma, 3),
          ratio: round(latest.ratio, 4),
          ratioPercentile: latest.ratioPercentile,
        }
      : null,
  };
}

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
    details: spec.details,
    history: trimmed.map((p) => ({
      date: toDateStr(p.x),
      value: round(p.y, 3),
    })),
    calc: latest
      ? {
          window: SCORE_MA_WINDOW,
          periodLabel: "day",
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

    const dailyComponents = COMPONENTS.map((spec) => buildComponent(raw, spec));
    const manualComponents = MANUAL_COMPONENTS.map((spec) => buildManualComponent(spec));
    const components = [...dailyComponents, ...manualComponents];

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
    // Manual factors are excluded from this historical chart: their history
    // uses coarse month/week date strings rather than real trading-day
    // epoch timestamps, so they can't be date-aligned with the daily CNN
    // series here. They still count toward the live composite score above.
    const totalWeight = COMPONENTS.reduce((sum, c) => sum + c.weight, 0);
    const compositeByDate = new Map();
    for (const comp of dailyComponents) {
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
