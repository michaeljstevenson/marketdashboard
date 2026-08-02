// Live sentiment + market data for the dashboard, computed fresh (subject to
// edge caching, see Cache-Control below) on every request.
//
// Every underlying reading here comes from Alpha Vantage (real market data),
// not from CNN's Fear & Greed API — this dashboard no longer uses CNN for
// anything. Every factor's score is our own math: each factor's current
// reading relative to its own trailing moving average, ranked against that
// reading's own history.
//
//   Implied Volatility  — the real CBOE VIX level (INDEX_DATA).
//   Realized Volatility — the S&P 500's own 14-day ATR, % of price (INDEX_DATA).
//   Price Momentum      — the real S&P 500 (SPX) price vs. its own 90-day MA (INDEX_DATA).
//   Equity Put/Call     — SPY's full-chain options put/call ratio (HISTORICAL_PUT_CALL_RATIO).
//   Credit Conditions   — HYG (high-yield) vs. LQD (investment-grade) price ratio, normalized.
//   Market Breadth      — RSP (equal-weight S&P 500) vs. SPY (cap-weight) price ratio, normalized.
//                         No direct advance/decline data exists on Alpha Vantage; this ratio is
//                         a standard real-world participation proxy — rising means gains are
//                         broadening beyond mega-caps, falling means narrowing leadership — but
//                         it's a genuine methodology substitution, not a like-for-like swap.
//
// "Normalized" for Credit Conditions and Market Breadth means each ratio series is rebased to
// start at 100, so the displayed value reads as a clean index level rather than a raw price
// ratio (e.g. 0.847) that's hard to interpret at a glance. Rebasing by a constant factor doesn't
// change the score math at all (ratio-to-own-MA is scale-invariant), so this only affects display.

const { MANUAL_SERIES } = require("./manual-data");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HISTORY_POINTS = 180; // ~6 months, kept compact for the browser
const SCORE_MA_WINDOW = 50; // trading days, applied to every factor with enough history for it

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function toDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentileRank(values, latestValue) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const below = sorted.filter((v) => v <= latestValue).length;
  return Math.round((100 * below) / sorted.length);
}

// Computes a self-derived 0-100 score for every date in `points` that has
// enough trailing history for a moving average: today's (or that day's)
// reading relative to its own trailing MA, ranked against that reading's
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

// Builds a full component response from an already-computed {x, y} series
// (y is whatever raw reading the factor tracks — a price, a level, a
// ratio). Shared by every daily factor below except Equity Put/Call,
// which has its own short-window builder due to how sparse its source
// data is to fetch (see buildPutCallComponent).
function buildSeriesComponent(points, spec) {
  const latestValue = points.length ? points[points.length - 1].y : null;
  const trimmed = points.slice(-HISTORY_POINTS);

  const scoreSeries = computeRelativeScoreSeries(points, SCORE_MA_WINDOW, spec.invert);
  const latest = scoreSeries.length ? scoreSeries[scoreSeries.length - 1] : null;

  return {
    id: spec.id,
    name: spec.name,
    value: latestValue !== null ? round(latestValue, 2) : null,
    unit: spec.unit,
    percentile: latestValue !== null ? percentileRank(points.map((p) => p.y), latestValue) : null,
    score: latest ? latest.score : 50,
    weight: spec.weight,
    source: spec.source,
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

async function fetchIndexDaily(apiKey, symbol) {
  const payload = await fetchJson(`${ALPHA_VANTAGE_URL}?function=INDEX_DATA&symbol=${symbol}&interval=daily&apikey=${apiKey}`);

  const data = payload.data;
  if (!data || !data.length) {
    throw new Error(
      `Alpha Vantage INDEX_DATA missing data for ${symbol}: ` + (payload.Note || payload.Information || payload.error || JSON.stringify(payload).slice(0, 200))
    );
  }

  return data
    .map((d) => ({
      x: Date.parse(d.date),
      open: parseFloat(d.open),
      high: parseFloat(d.high),
      low: parseFloat(d.low),
      close: parseFloat(d.close),
    }))
    .sort((a, b) => a.x - b.x);
}

async function fetchStockDaily(apiKey, symbol, outputsize) {
  const payload = await fetchJson(`${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=${outputsize}&apikey=${apiKey}`);

  const series = payload["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      `Alpha Vantage TIME_SERIES_DAILY missing data for ${symbol}: ` + (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 200))
    );
  }

  return Object.entries(series)
    .map(([date, day]) => ({ x: Date.parse(date), y: round(parseFloat(day["4. close"]), 4) }))
    .sort((a, b) => a.x - b.x);
}

// Divides two same-shaped {x, y} series (numerator by date / denominator by
// nearest-prior date) and rebases the result to start at 100 — see the
// file header for why. Used for both Market Breadth (RSP/SPY) and Credit
// Conditions (HYG/LQD).
function computeNormalizedRatioSeries(numerator, denominator) {
  const denomByDate = new Map(denominator.map((p) => [toDateStr(p.x), p.y]));
  const denomDatesSorted = denominator.map((p) => toDateStr(p.x)).sort();

  function nearestDenom(dateStr) {
    if (denomByDate.has(dateStr)) return denomByDate.get(dateStr);
    const earlier = denomDatesSorted.filter((d) => d <= dateStr);
    return earlier.length ? denomByDate.get(earlier[earlier.length - 1]) : null;
  }

  const raw = numerator
    .map((p) => {
      const denomValue = nearestDenom(toDateStr(p.x));
      return denomValue !== null ? { x: p.x, y: p.y / denomValue } : null;
    })
    .filter(Boolean);

  if (!raw.length) return [];
  const base = raw[0].y;
  return raw.map((p) => ({ x: p.x, y: (p.y / base) * 100 }));
}

// Equity Put/Call Ratio: Alpha Vantage has no bulk historical time-series
// endpoint for this — HISTORICAL_PUT_CALL_RATIO only returns one date's
// reading per call, via a `date` parameter. Building a long history would
// mean hundreds of sequential calls, too slow for a single request. This
// fetches a short trailing window (a few weeks) instead, batched to avoid
// tripping Alpha Vantage's burst-rate limiter (same issue hit in ticker.js
// and volatility.js), scored over a shorter 10-day window accordingly.
// Because its usable history is so much shorter than the other factors',
// it's excluded from the composite history chart (like the manual factors)
// but still counts fully toward the live composite score.
const PUTCALL_SCORE_WINDOW = 10;
const PUTCALL_TRADING_DAYS = 18; // enough for a 10-day MA plus a small percentile sample

async function fetchPutCallWindow(apiKey, symbol, tradingDates) {
  const dates = tradingDates.slice(-PUTCALL_TRADING_DAYS);
  const points = [];
  for (let i = 0; i < dates.length; i += 5) {
    const batch = dates.slice(i, i + 5).map(async (dateStr) => {
      const payload = await fetchJson(`${ALPHA_VANTAGE_URL}?function=HISTORICAL_PUT_CALL_RATIO&symbol=${symbol}&date=${dateStr}&apikey=${apiKey}`);
      const value = parseFloat(payload.put_call_ratio_full_chain);
      if (Number.isNaN(value)) return null;
      return { x: Date.parse(dateStr), y: value };
    });
    points.push(...(await Promise.all(batch)));
    if (i + 5 < dates.length) await sleep(800);
  }
  return points.filter(Boolean).sort((a, b) => a.x - b.x);
}

const PUTCALL_SPEC = {
  id: "putcall",
  name: "Equity Put/Call Ratio",
  unit: "ratio",
  weight: 10,
  invert: true,
  source: { name: "Alpha Vantage — SPY Options Put/Call Ratio", url: "https://www.alphavantage.co/" },
  description: "A rising put/call ratio relative to trend indicates bearish positioning.",
  details:
    "This factor tracks the full-options-chain ratio of put contracts (bets that SPY will fall) to call contracts (bets that it will rise). When investors are nervous, they buy more puts to hedge or speculate on declines, pushing the ratio up; when they're confident, call buying dominates and the ratio falls.\n\nAlpha Vantage only exposes this ratio one trading day at a time (no bulk historical endpoint), so this factor is scored against a shorter 10-day trailing average rather than the 50-day window used elsewhere, and — unlike every other daily factor — isn't included in the composite history chart below, since its usable history is too short to date-align with the others. It still counts fully toward the live composite score.",
};

function buildPutCallComponent(points) {
  const latestValue = points.length ? points[points.length - 1].y : null;

  const scoreSeries = computeRelativeScoreSeries(points, PUTCALL_SCORE_WINDOW, PUTCALL_SPEC.invert);
  const latest = scoreSeries.length ? scoreSeries[scoreSeries.length - 1] : null;

  return {
    id: PUTCALL_SPEC.id,
    name: PUTCALL_SPEC.name,
    value: latestValue !== null ? round(latestValue, 2) : null,
    unit: PUTCALL_SPEC.unit,
    percentile: latestValue !== null ? percentileRank(points.map((p) => p.y), latestValue) : null,
    score: latest ? latest.score : 50,
    weight: PUTCALL_SPEC.weight,
    source: PUTCALL_SPEC.source,
    description: PUTCALL_SPEC.description,
    details: PUTCALL_SPEC.details,
    history: points.map((p) => ({ date: toDateStr(p.x), value: round(p.y, 3) })),
    calc: latest
      ? {
          window: PUTCALL_SCORE_WINDOW,
          periodLabel: "day",
          invert: PUTCALL_SPEC.invert,
          value: round(latest.value, 3),
          ma: round(latest.ma, 3),
          ratio: round(latest.ratio, 4),
          ratioPercentile: latest.ratioPercentile,
        }
      : null,
  };
}

// Realized Volatility: the backward-looking counterpart to Implied
// Volatility (VIX). Tracks the S&P 500's own 14-day Average True Range
// (ATR), expressed as a % of price so it's comparable across price regimes
// (raw dollar ATR would show a spurious uptrend simply because the index
// is ~9x higher than in 1997, regardless of actual volatility).
const REALIZED_VOL_SPEC = {
  id: "realizedvol",
  name: "Realized Volatility",
  unit: "% of price (ATR-14)",
  weight: 7,
  invert: true,
  atrWindow: 14,
  source: { name: "Alpha Vantage — S&P 500 Index (SPX)", url: "https://www.alphavantage.co/" },
  description: "A rising 14-day Average True Range relative to trend signals widening realized price swings.",
  details:
    "Realized volatility measures how much the S&P 500 has actually been moving, in contrast to Implied Volatility (the VIX), which measures what options traders expect it to move. This factor uses the 14-day Average True Range (ATR) — the average of each day's true trading range (accounting for gaps) over the last 14 trading days — expressed as a percentage of the index's price so it stays comparable across different price levels and eras.\n\nThe score compares today's ATR% to its own 50-day average, ranked against its full history back to 1997. ATR running above trend means the index has genuinely been swinging more than usual — realized fear rather than merely anticipated fear. Because realized and implied volatility usually move together but can diverge (implied often runs above realized as a risk premium), watching both side by side reveals when the market's expectations and its actual behavior are out of sync.",
};

function computeAtrPercentSeries(bars, window) {
  const trueRanges = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  });

  const points = [];
  for (let i = window - 1; i < bars.length; i++) {
    const slice = trueRanges.slice(i - window + 1, i + 1);
    const atr = slice.reduce((sum, v) => sum + v, 0) / window;
    points.push({ x: bars[i].x, y: (atr / bars[i].close) * 100 });
  }
  return points;
}

function buildRealizedVolComponent(spxDaily) {
  const atrPoints = computeAtrPercentSeries(spxDaily, REALIZED_VOL_SPEC.atrWindow);
  return buildSeriesComponent(atrPoints, REALIZED_VOL_SPEC);
}

// invert: true means "reading above its own MA" = fear (lower score) —
// e.g. Implied Volatility spiking above trend is bearish. false means
// "reading above its own MA" = greed (higher score) — e.g. breadth,
// credit risk appetite, and price momentum running hot above trend is
// bullish. Weights are tilted rather than equal: Credit and Breadth are
// structural/leading signals (credit markets tend to react before equity
// sentiment fully turns; breadth reveals whether participation is broad
// or narrow underneath the headline index). Put/Call and Momentum are
// weighted down — put/call is noisier day-to-day (partly institutional
// hedging, not pure sentiment), and momentum is lagging by nature
// (derived from the same price action sentiment is meant to explain).
// Implied and Realized Volatility are weighted evenly at 7% each — two
// views (forward-looking options pricing vs. backward-looking actual
// price swings) on the same underlying phenomenon, deliberately balanced
// rather than favoring either. Weights sum to 70 (breadth 18 + credit 18
// + implied vol 7 + put/call 10 + momentum 10 + realized vol 7) + 30 (the
// 3 manual factors defined in MANUAL_COMPONENTS, 10% each) = 100 — see
// MANUAL_COMPONENTS for why those are capped at 10% each.
const BREADTH_SPEC = {
  id: "breadth",
  name: "Market Breadth",
  unit: "index (normalized)",
  weight: 18,
  invert: false,
  source: { name: "Alpha Vantage — RSP vs. SPY", url: "https://www.alphavantage.co/" },
  description: "Broader participation (equal-weight outperforming cap-weight) relative to trend reflects healthier market breadth.",
  details:
    "Market breadth measures how many stocks are participating in a market move, not just how the headline index is performing. There's no direct advance/decline feed available here, so this factor uses the ratio of RSP (an equal-weight S&P 500 fund, where every constituent counts the same) to SPY (the standard cap-weighted fund, dominated by the largest names) as a real-world participation proxy: when the ratio rises, the average stock is keeping pace with or beating the mega-cap-heavy index, meaning gains are broad-based; when it falls, a handful of giant companies are carrying the index while the average stock lags.\n\nThe ratio is rebased to start at 100 so it reads as a clean index rather than a small decimal. The score compares today's reading to its own 50-day moving average: breadth running above trend suggests broadening, healthier participation; breadth running below trend suggests narrowing leadership — often an early warning that a rally is more fragile than the index price alone suggests.",
};

const CREDIT_SPEC = {
  id: "credit",
  name: "Credit Conditions",
  unit: "index (normalized)",
  weight: 18,
  invert: false,
  source: { name: "Alpha Vantage — HYG vs. LQD", url: "https://www.alphavantage.co/" },
  description: "Rising high-yield demand relative to investment-grade debt indicates risk appetite.",
  details:
    "Credit Conditions tracks demand for high-yield (\"junk\") bonds relative to safer investment-grade debt, using the price ratio of HYG (a high-yield corporate bond fund) to LQD (an investment-grade corporate bond fund). Junk bonds carry more default risk, so investors only chase them aggressively when they're feeling confident about the economy and corporate health; when fear rises, capital typically rotates out of junk bonds and into safer assets first — often before that caution shows up in stock prices.\n\nThe ratio is rebased to start at 100 so it reads as a clean index rather than a small decimal. Because credit investors are generally more risk-averse and tend to reprice risk earlier than equity markets, this factor is treated as one of the more forward-looking signals here (and weighted accordingly). The score compares today's reading to its own 50-day average: the ratio running above trend suggests risk appetite is increasing, while it running below trend can flag credit stress starting to build.",
};

const VIX_SPEC = {
  id: "vix",
  name: "Implied Volatility",
  unit: "index",
  weight: 7,
  invert: true,
  source: { name: "Alpha Vantage — CBOE Volatility Index (VIX)", url: "https://www.alphavantage.co/" },
  description: "Elevated implied volatility relative to its recent trend reflects investor fear.",
  details:
    "The VIX (often called the market's \"fear gauge\") measures how much volatility options traders expect in the S&P 500 over the next 30 days, derived from the prices they're willing to pay for options. It doesn't measure what already happened — it measures what the market is bracing for, which is why it's called implied (rather than realized) volatility, and why it's forward-looking rather than a reflection of past price action. See the Realized Volatility factor for the backward-looking counterpart to this one.\n\nRather than using the VIX's raw level (which drifts up and down with the broader volatility regime over months and years), this dashboard compares today's VIX to its own 50-day moving average, ranked against its full history. A VIX spiking well above its recent trend signals rising fear and uncertainty; a VIX sitting below its recent trend suggests calm, complacent conditions.",
};

const MOMENTUM_DISPLAY_WINDOW = 90; // trading days, for the displayed "% vs MA" figure only

const MOMENTUM_SPEC = {
  id: "momentum",
  name: "Price Momentum",
  unit: `% vs ${MOMENTUM_DISPLAY_WINDOW}-day MA`,
  weight: 10,
  invert: false,
  source: { name: "Alpha Vantage — S&P 500 Index (SPX)", url: "https://www.alphavantage.co/" },
  description: "Strong price trends relative to the recent average increase investor optimism.",
  details:
    "Price Momentum compares the real S&P 500 index level to its own 90-day moving average, a simple trend-following signal: when the index is trading above its recent average, the market is in an established uptrend, which tends to coincide with optimism; when it's trading below, the trend has turned down.\n\nBecause this reading is derived directly from price — the same thing sentiment is meant to help explain — it's treated as a lagging, confirming signal here rather than a leading one, and is weighted accordingly. The score compares today's price to its own 50-day average, ranked against the index's full history back to 1997; the number displayed on the card uses a 90-day moving average instead, a more conventional momentum window for the figure investors actually look at.",
};

function buildMomentumComponent(spxDaily) {
  const closes = spxDaily.map((bar) => ({ x: bar.x, y: bar.close }));
  const component = buildSeriesComponent(closes, MOMENTUM_SPEC);

  if (closes.length >= MOMENTUM_DISPLAY_WINDOW) {
    const window = closes.slice(-MOMENTUM_DISPLAY_WINDOW);
    const ma = window.reduce((sum, p) => sum + p.y, 0) / window.length;
    const latestClose = closes[closes.length - 1].y;
    component.value = round((latestClose / ma - 1) * 100, 2);
  }

  return component;
}

// Manually-updated factors (see manual-data.js for sourcing and the
// update procedure). Each has its own trailing-average window sized to
// how much history is actually available, since none of these started
// with 50+ data points the way the live daily factors did — the window
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
    source: { name: "FINRA Margin Statistics", url: "https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics" },
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
    source: { name: "ICI Estimated Long-Term Mutual Fund Flows", url: "https://www.ici.org/research/stats/flows" },
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
    source: { name: "FactSet Earnings Insight", url: "https://insight.factset.com/topic/earnings" },
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
    source: spec.source,
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

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const now = new Date();

    // Sequential, not Promise.all: Alpha Vantage trips a burst-rate
    // detector when multiple requests land concurrently, even on this
    // premium key (same issue hit in ticker.js and volatility.js).
    const spxDaily = await fetchIndexDaily(apiKey, "SPX");
    const vixDaily = await fetchIndexDaily(apiKey, "VIX");
    // "compact" (~100 trading days) rather than "full" for these four -
    // still plenty for a 50-day MA and a real percentile sample, and
    // keeps total request latency down given how many sequential Alpha
    // Vantage calls this function already makes per run.
    const spyDaily = await fetchStockDaily(apiKey, "SPY", "compact");
    const rspDaily = await fetchStockDaily(apiKey, "RSP", "compact");
    const hygDaily = await fetchStockDaily(apiKey, "HYG", "compact");
    const lqdDaily = await fetchStockDaily(apiKey, "LQD", "compact");

    const spxTradingDates = spxDaily.map((p) => toDateStr(p.x));
    const putCallPoints = await fetchPutCallWindow(apiKey, "SPY", spxTradingDates);

    const breadthPoints = computeNormalizedRatioSeries(rspDaily, spyDaily);
    const creditPoints = computeNormalizedRatioSeries(hygDaily, lqdDaily);
    const vixPoints = vixDaily.map((p) => ({ x: p.x, y: p.close }));

    const chartComponents = [
      buildSeriesComponent(breadthPoints, BREADTH_SPEC),
      buildSeriesComponent(creditPoints, CREDIT_SPEC),
      buildSeriesComponent(vixPoints, VIX_SPEC),
      buildMomentumComponent(spxDaily),
      buildRealizedVolComponent(spxDaily),
    ];
    const dailyComponents = chartComponents; // alias kept for the history-merge loop below
    const putCallComponent = buildPutCallComponent(putCallPoints);
    const manualComponents = MANUAL_COMPONENTS.map((spec) => buildManualComponent(spec));

    // Ordered by weight, descending, so the cards render heaviest-first.
    const componentsById = new Map([...chartComponents, putCallComponent, ...manualComponents].map((c) => [c.id, c]));
    const components = [
      "breadth", "credit", "putcall", "momentum",
      "vix", "realizedvol",
      "margindebt", "fundflows", "forwardpe",
    ].map((id) => componentsById.get(id));

    const composite = Math.round(
      components.reduce((sum, c) => sum + c.score * c.weight, 0) /
        components.reduce((sum, c) => sum + c.weight, 0)
    );

    // Composite history: our own weighted average of each factor's
    // self-computed score series, date-aligned, paired with S&P 500
    // closes. Manual factors and Equity Put/Call are excluded from this
    // historical chart: manual factors use coarse month/week date strings
    // rather than real trading-day epoch timestamps, and put/call's
    // fetchable history is too short (see PUTCALL_SPEC) — both still
    // count toward the live composite score above, just not this chart.
    const CHART_SPECS = [BREADTH_SPEC, CREDIT_SPEC, VIX_SPEC, MOMENTUM_SPEC, REALIZED_VOL_SPEC];
    const totalWeight = CHART_SPECS.reduce((sum, c) => sum + c.weight, 0);
    const compositeByDate = new Map();
    for (const comp of dailyComponents) {
      const weight = CHART_SPECS.find((c) => c.id === comp.id).weight;
      for (const point of comp.scoreSeries) {
        const dateStr = toDateStr(point.x);
        const entry = compositeByDate.get(dateStr) || { weightedSum: 0, weightSeen: 0 };
        entry.weightedSum += point.score * weight;
        entry.weightSeen += weight;
        compositeByDate.set(dateStr, entry);
      }
    }

    const spxCloseByDate = new Map(spxDaily.map((p) => [toDateStr(p.x), p.close]));
    const spxDatesSorted = spxDaily.map((p) => toDateStr(p.x)).sort();
    function nearestSpx(dateStr) {
      if (spxCloseByDate.has(dateStr)) return spxCloseByDate.get(dateStr);
      const earlier = spxDatesSorted.filter((d) => d <= dateStr);
      return earlier.length ? spxCloseByDate.get(earlier[earlier.length - 1]) : null;
    }

    const history = [...compositeByDate.keys()]
      .sort()
      .filter((d) => compositeByDate.get(d).weightSeen === totalWeight) // only dates all chart-eligible factors covered
      .slice(-HISTORY_POINTS)
      .map((d) => {
        const entry = compositeByDate.get(d);
        return {
          date: d,
          optimism: Math.round(entry.weightedSum / entry.weightSeen),
          spy: nearestSpx(d), // real S&P 500 level now, field name kept for frontend compatibility
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
        // Cached at the edge for 2 hours — this data doesn't need to be
        // fresher than that, and it keeps upstream call volume low.
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
