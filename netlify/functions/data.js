// Live sentiment + market data for the dashboard, computed fresh (subject to
// edge caching, see Cache-Control below) on every request.
//
// Every underlying reading here comes from Alpha Vantage (real market data),
// not from CNN's Fear & Greed API — this dashboard no longer uses CNN for
// anything. Every factor's score is our own math: each factor's current
// reading relative to its own trailing moving average, ranked against that
// reading's own history.
//
//   Implied Volatility  — the real CBOE VIX level (INDEX_DATA — currently unavailable,
//                         see fetchIndexDaily's usage below: this account's Alpha
//                         Vantage plan isn't entitled to INDEX_DATA).
//   Realized Volatility — SPY's own 14-day ATR, % of price (TIME_SERIES_DAILY).
//   Price Momentum      — SPY's price vs. its own 90-day MA (TIME_SERIES_DAILY).
//   Equity Put/Call     — SPY's full-chain options put/call ratio (HISTORICAL_PUT_CALL_RATIO).
//   Credit Conditions   — HYG (high-yield) vs. LQD (investment-grade) price ratio, normalized.
//   Market Breadth      — three real advance/decline internals (A-D line, net new 52-week
//                         highs/lows, % above 200-day SMA) computed daily across the full
//                         S&P 500 constituent list by scheduled-breadth-background.js and
//                         read from Netlify Blobs here (see breadth-constituents.js).
//   Small-Cap Rel. Strength — IWM (small-cap) price ratio vs. the S&P 500, normalized.
//   Equal-Weight Participation — RSP (equal-weight S&P 500) price ratio vs. the
//                         cap-weighted index, normalized.
//   News Sentiment      — average per-article sentiment for SPY-tagged financial news
//                         (NEWS_SENTIMENT), bucketed by day.
//
// "Normalized" for Credit Conditions means its ratio series is rebased to start at 100, so the
// displayed value reads as a clean index level rather than a raw price ratio (e.g. 0.847) that's
// hard to interpret at a glance. Rebasing by a constant factor doesn't change the score math at
// all (ratio-to-own-MA is scale-invariant), so this only affects display.

const { getBreadthStore, BLOB_KEY: BREADTH_BLOB_KEY } = require("./breadth-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HISTORY_POINTS = 7560; // ~30 trading years - the underlying series (SPY, HYG/LQD, breadth) go back
// this far already (fetched with outputsize=full); 504 was an arbitrary
// display cap that made the composite chart look like it started in 2024
// when the factors behind it actually go back decades.
const SCORE_MA_WINDOW = 50; // trading days, applied to every factor with enough history for it

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
// history up to and including that date (see the expanding-window note
// below). Returns [{x, score, value, ma, ratio, ratioPercentile}], aligned
// to points[window-1..].
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

  // Expanding-window (causal) percentile: each date's score is ranked only
  // against ratios observed up to and including that date, not the full
  // dataset. Ranking against the full dataset means a regime shift years
  // later silently rewrites how extreme an earlier reading "was" every
  // time new data comes in — this chart should show what the index would
  // actually have read live on that date. sortedSoFar stays sorted via
  // binary-search insertion, so the last point's percentile still comes
  // out identical to the old full-sample version (its population is, by
  // construction, everything up to and including itself).
  const sortedSoFar = [];
  const rankedPoints = points.slice(window - 1).map((p, idx) => {
    const ratio = ratios[idx];
    let lo = 0, hi = sortedSoFar.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedSoFar[mid] <= ratio) lo = mid + 1; else hi = mid;
    }
    const below = lo + 1; // count of values <= ratio, including this one
    const ratioPercentile = round((100 * below) / (sortedSoFar.length + 1), 1);
    sortedSoFar.splice(lo, 0, ratio);
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
  const maWindow = spec.maWindow || SCORE_MA_WINDOW;

  const scoreSeries = computeRelativeScoreSeries(points, maWindow, spec.invert);
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
          window: maWindow,
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

// Reads the pre-computed breadth internals blob (written daily by
// scheduled-breadth.js) and splits it into the three {x, y} point series
// the breadth specs above each need. Called directly via getStore rather
// than an HTTP round-trip to breadth-internals.js, since both run in the
// same Netlify Functions environment.
async function fetchBreadthInternals() {
  const store = getBreadthStore();
  const payload = await store.get(BREADTH_BLOB_KEY, { type: "json" });
  if (!payload || !payload.rows || !payload.rows.length) {
    throw new Error("Breadth internals blob not yet populated — scheduled-breadth hasn't run yet");
  }

  const adLinePoints = [];
  const hiLoPoints = [];
  const pct200Points = [];
  for (const row of payload.rows) {
    const x = Date.parse(row.date);
    adLinePoints.push({ x, y: row.adLine });
    hiLoPoints.push({ x, y: row.newHighs - row.newLows });
    if (row.pctAbove200sma !== null) pct200Points.push({ x, y: row.pctAbove200sma });
  }

  return { adLinePoints, hiLoPoints, pct200Points };
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

// Same shape as fetchIndexDaily (OHLC, not just close), but via
// TIME_SERIES_DAILY on an ETF rather than INDEX_DATA on the raw index —
// this account's Alpha Vantage plan isn't entitled to INDEX_DATA ("You
// are not yet entitled to index data access"), which was silently
// dropping Momentum, Realized Volatility, the bottom chart's S&P line,
// and anything else keyed off SPX. SPY tracks the S&P 500 within basis
// points for relative-strength/ATR purposes, so it's a safe substitute
// for the entitled TIME_SERIES_DAILY endpoint already used elsewhere here.
async function fetchStockDailyOHLC(apiKey, symbol, outputsize) {
  const payload = await fetchJson(`${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=${outputsize}&apikey=${apiKey}`);

  const series = payload["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      `Alpha Vantage TIME_SERIES_DAILY missing data for ${symbol}: ` + (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 200))
    );
  }

  return Object.entries(series)
    .map(([date, day]) => ({
      x: Date.parse(date),
      open: parseFloat(day["1. open"]),
      high: parseFloat(day["2. high"]),
      low: parseFloat(day["3. low"]),
      close: parseFloat(day["4. close"]),
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
// nearest-prior date) and rebases the result to 100 at the start of the
// displayed window (HISTORY_POINTS back from the end), not the start of
// the full multi-year fetched series — see the file header for why
// "normalized" matters here. Rebasing by any constant factor doesn't
// change the score/percentile math at all (ratio-to-own-MA is scale-
// invariant), so this choice only affects what's displayed: anchoring to
// a point from decades ago can leave the current reading looking like 25
// or 30 instead of a value near 100, which defeats the point of
// normalizing it in the first place. Used for Credit Conditions (HYG/LQD).
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
  const baseIndex = Math.max(0, raw.length - HISTORY_POINTS);
  const base = raw[baseIndex].y;
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
const PUTCALL_SCORE_WINDOW = 15;
const PUTCALL_TRADING_DAYS = 30; // enough for a 15-day MA plus a ~15-sample percentile (was 18/10 — too noisy)

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
  maWindow: 20, // volatility mean-reverts fast — a 50-day window blunted genuine spikes
  source: { name: "Alpha Vantage — S&P 500 (SPY)", url: "https://www.alphavantage.co/" },
  description: "A rising 14-day Average True Range relative to trend signals widening realized price swings.",
  details:
    "Realized volatility measures how much the S&P 500 has actually been moving, in contrast to Implied Volatility (the VIX), which measures what options traders expect it to move. This factor uses the 14-day Average True Range (ATR) — the average of each day's true trading range (accounting for gaps) over the last 14 trading days — expressed as a percentage of the index's price so it stays comparable across different price levels and eras.\n\nThe score compares today's ATR% to its own 20-day average (shorter than the 50-day window used for slower factors, since volatility regimes mean-revert quickly), ranked against its full history back to 1997. ATR running above trend means the index has genuinely been swinging more than usual — realized fear rather than merely anticipated fear. Because realized and implied volatility usually move together but can diverge (implied often runs above realized as a risk premium), watching both side by side reveals when the market's expectations and its actual behavior are out of sync.",
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
// + implied vol 7 + put/call 10 + momentum 10 + realized vol 7) + 30
// (Small-Cap Relative Strength, Equal-Weight Participation, and News
// Sentiment — defined further down — 10% each) = 100.
// Market Breadth: three real internals — cumulative advance/decline line,
// net new 52-week highs vs. lows, and % of constituents above their own
// 200-day SMA — computed daily across the full S&P 500 constituent list by
// scheduled-breadth.js and stored in Netlify Blobs (see
// breadth-constituents.js and scheduled-breadth.js). This replaced an
// earlier RSP/SPY price-ratio proxy now that real advance/decline data is
// available; the combined 18% weight (6% each) matches what that single
// proxy factor carried before, so the composite's overall weighting shape
// is unchanged — see the comment above for how all weights sum to 100.
const BREADTH_ADLINE_SPEC = {
  id: "breadthadline",
  name: "Advance/Decline Line",
  unit: "cumulative net advances",
  weight: 6,
  invert: false,
  source: { name: "Alpha Vantage — S&P 500 constituents", url: "https://www.alphavantage.co/" },
  description: "A rising advance/decline line relative to trend reflects broad-based participation in the market's direction.",
  details:
    "The advance/decline (A-D) line is a running cumulative total of (stocks that closed up today) minus (stocks that closed down today), across the S&P 500. It's one of the oldest breadth measures: if the line keeps climbing alongside the index, gains are broad-based; if the index rises while the A-D line stalls or falls, a shrinking number of stocks are carrying the market higher — a classic warning sign of a fragile, narrow rally.\n\nThe score compares today's cumulative level to its own 50-day moving average, ranked against its full history since this factor started tracking.",
};

const BREADTH_HILO_SPEC = {
  id: "breadthhilo",
  name: "New Highs vs. Lows",
  unit: "net new 52-wk highs",
  weight: 6,
  invert: false,
  source: { name: "Alpha Vantage — S&P 500 constituents", url: "https://www.alphavantage.co/" },
  description: "More stocks making fresh 52-week highs than lows, relative to trend, reflects broad market strength.",
  details:
    "This factor tracks the net count of stocks in the sample making new 52-week highs minus those making new 52-week lows, each trading day. A market where far more names are hitting new highs than new lows is healthy and broadly participating; a market where new lows start outnumbering new highs — even if the headline index is still near its own highs — often signals internal deterioration before it shows up in the index level.\n\nThe score compares today's net reading to its own 50-day moving average, ranked against its full history since this factor started tracking.",
};

const BREADTH_PCT200_SPEC = {
  id: "breadthpct200",
  name: "% Above 200-day SMA",
  unit: "% of sample",
  weight: 6,
  invert: false,
  source: { name: "Alpha Vantage — S&P 500 constituents", url: "https://www.alphavantage.co/" },
  description: "A larger share of stocks trading above their own 200-day average relative to trend reflects broad participation in the uptrend.",
  details:
    "This factor tracks the percentage of S&P 500 constituents trading above their own 200-day simple moving average — a standard long-term trend gauge applied stock-by-stock rather than to the index as a whole. A high and rising reading means most individual stocks are in their own long-term uptrends; a falling reading means fewer stocks are, even if a handful of mega-caps keep the headline index elevated.\n\nThe score compares today's reading to its own 50-day moving average, ranked against its full history since this factor started tracking.",
};

const CREDIT_SPEC = {
  id: "credit",
  name: "Credit Conditions",
  unit: "index (normalized)",
  weight: 18,
  invert: false,
  maWindow: 100, // credit repricing is slower/stickier than equity vol — a 50-day window flagged noise as signal
  source: { name: "Alpha Vantage — HYG vs. LQD", url: "https://www.alphavantage.co/" },
  description: "Rising high-yield demand relative to investment-grade debt indicates risk appetite.",
  details:
    "Credit Conditions tracks demand for high-yield (\"junk\") bonds relative to safer investment-grade debt, using the price ratio of HYG (a high-yield corporate bond fund) to LQD (an investment-grade corporate bond fund). Junk bonds carry more default risk, so investors only chase them aggressively when they're feeling confident about the economy and corporate health; when fear rises, capital typically rotates out of junk bonds and into safer assets first — often before that caution shows up in stock prices.\n\nThe ratio is rebased to start at 100 so it reads as a clean index rather than a small decimal. Because credit investors are generally more risk-averse and tend to reprice risk earlier than equity markets, this factor is treated as one of the more forward-looking signals here (and weighted accordingly). The score compares today's reading to its own 100-day average — wider than the 50-day window used for faster-moving factors, since credit spreads drift rather than whipsaw: the ratio running above trend suggests risk appetite is increasing, while it running below trend can flag credit stress starting to build.",
};

const VIX_SPEC = {
  id: "vix",
  name: "Implied Volatility",
  unit: "index",
  weight: 7,
  invert: true,
  maWindow: 20, // volatility mean-reverts fast — a 50-day window blunted genuine spikes
  source: { name: "Alpha Vantage — CBOE Volatility Index (VIX)", url: "https://www.alphavantage.co/" },
  description: "Elevated implied volatility relative to its recent trend reflects investor fear.",
  details:
    "The VIX (often called the market's \"fear gauge\") measures how much volatility options traders expect in the S&P 500 over the next 30 days, derived from the prices they're willing to pay for options. It doesn't measure what already happened — it measures what the market is bracing for, which is why it's called implied (rather than realized) volatility, and why it's forward-looking rather than a reflection of past price action. See the Realized Volatility factor for the backward-looking counterpart to this one.\n\nRather than using the VIX's raw level (which drifts up and down with the broader volatility regime over months and years), this dashboard compares today's VIX to its own 20-day moving average (shorter than the 50-day window used for slower factors, since volatility regimes mean-revert quickly), ranked against its full history. A VIX spiking well above its recent trend signals rising fear and uncertainty; a VIX sitting below its recent trend suggests calm, complacent conditions.",
};

const MOMENTUM_DISPLAY_WINDOW = 90; // trading days, for the displayed "% vs MA" figure only

const MOMENTUM_SPEC = {
  id: "momentum",
  name: "Price Momentum",
  unit: `% vs ${MOMENTUM_DISPLAY_WINDOW}-day MA`,
  weight: 10,
  invert: false,
  source: { name: "Alpha Vantage — S&P 500 (SPY)", url: "https://www.alphavantage.co/" },
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

// The three factors below replaced what used to be hand-updated monthly/
// weekly readings (margin debt, fund flows, forward P/E) that required
// manually copying numbers from FINRA/ICI/FactSet — a maintenance burden
// that meant they silently went stale whenever nobody got around to it.
// These are fetched live on every request like everything else here.

// Small-Cap Relative Strength: IWM (small-cap) vs. the S&P 500, the same
// "risk appetite" signal margin debt was trying to proxy — investors
// reach for smaller, higher-beta names when confident and rotate back to
// large-caps/safety when fearful. Uses spxDaily (already fetched for
// Momentum/Realized Vol) as the denominator rather than fetching SPY
// separately: SPX and SPY track within basis points of each other in
// relative-strength terms, and this saves an extra sequential AV call.
const SMALLCAP_SPEC = {
  id: "smallcap",
  name: "Small-Cap Relative Strength",
  unit: "index (normalized)",
  weight: 10,
  invert: false,
  source: { name: "Alpha Vantage — IWM vs. S&P 500", url: "https://www.alphavantage.co/" },
  description: "Small-caps outperforming the S&P 500 relative to trend reflects rising risk appetite.",
  details:
    "This factor tracks the price ratio of IWM (a small-cap Russell 2000 fund) to the S&P 500 — small-caps carry more volatility and less balance-sheet cushion than large-caps, so investors chase them more aggressively when confident and rotate back to safer large-caps first when fear rises. It's a live, automated stand-in for what margin debt (leverage/risk appetite) used to proxy on this dashboard.\n\nThe ratio is rebased to start at 100 so it reads as a clean index. The score compares today's reading to its own 50-day average, ranked against its full history: the ratio running above trend suggests risk appetite for smaller, riskier names is increasing; running below trend suggests a flight to large-cap safety.",
};

// Equal-Weight Participation: RSP (equal-weight S&P 500) vs. the
// cap-weighted index — a real-time breadth/complacency signal, replacing
// what forward P/E (a valuation proxy with no free automated index-level
// source) used to carry. When the equal-weight index keeps pace with or
// outpaces the cap-weighted one, gains are broad-based across the index
// rather than concentrated in a handful of mega-caps.
const EQUALWEIGHT_SPEC = {
  id: "equalweight",
  name: "Equal-Weight Participation",
  unit: "index (normalized)",
  weight: 10,
  invert: false,
  source: { name: "Alpha Vantage — RSP vs. S&P 500", url: "https://www.alphavantage.co/" },
  description: "The equal-weight S&P 500 keeping pace with the cap-weighted index relative to trend reflects broad-based participation.",
  details:
    "This factor tracks the price ratio of RSP (an equal-weight S&P 500 fund, where every constituent counts the same regardless of market cap) to the standard cap-weighted index. When the equal-weight version keeps up with or outpaces the cap-weighted index, gains are spread across the full roster of companies; when the cap-weighted index pulls ahead, a shrinking group of mega-caps is doing the heavy lifting — a narrower, more fragile advance.\n\nThe ratio is rebased to start at 100. The score compares today's reading to its own 50-day average, ranked against its full history: the ratio running above trend suggests participation is broadening (optimism shared widely); running below trend suggests it's narrowing.",
};

// News Sentiment: Alpha Vantage's News & Sentiment feed for SPY-tagged
// financial coverage, averaged per day — a live, automated replacement for
// forward P/E's other half of the "market psychology" gap. Like Equity
// Put/Call, the feed only returns a bounded recent window (not a bulk
// decades-long history), so this factor is scored over a shorter trailing
// window and excluded from the composite history chart, but still counts
// fully toward the live composite score.
const NEWS_SENTIMENT_SCORE_WINDOW = 10;
const NEWS_SENTIMENT_LOOKBACK_DAYS = 60;

const NEWSSENTIMENT_SPEC = {
  id: "newssentiment",
  name: "News Sentiment",
  unit: "avg. article sentiment",
  weight: 10,
  invert: false,
  source: { name: "Alpha Vantage — News & Sentiment (SPY)", url: "https://www.alphavantage.co/" },
  description: "Financial news coverage skewing more positive than its recent trend reflects rising investor optimism.",
  details:
    "This factor aggregates Alpha Vantage's News & Sentiment feed for SPY-tagged financial news articles, averaging each day's per-article sentiment score (roughly -1 very bearish to +1 very bullish) — a live, automated read on how the financial press is framing the market. It replaces what was previously a hand-updated forward P/E factor.\n\nThe score compares each day's average article sentiment to its own trailing 10-day average, ranked against the ~60 days of coverage this factor has usable history for. Because the News & Sentiment API returns a bounded recent feed rather than a bulk decades-long history, this factor — like Equity Put/Call — isn't included in the composite history chart below, but still counts fully toward the live composite score.",
};

function buildNewsSentimentPoints(feed) {
  const byDate = new Map();
  for (const article of feed) {
    const raw = article.time_published || "";
    if (raw.length < 8) continue;
    const dateStr = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const spyEntry = (article.ticker_sentiment || []).find((t) => t.ticker === "SPY");
    const score = parseFloat(spyEntry ? spyEntry.ticker_sentiment_score : article.overall_sentiment_score);
    if (Number.isNaN(score)) continue;
    const bucket = byDate.get(dateStr) || { sum: 0, count: 0 };
    bucket.sum += score;
    bucket.count += 1;
    byDate.set(dateStr, bucket);
  }
  return [...byDate.keys()]
    .sort()
    .map((d) => ({ x: Date.parse(d + "T00:00:00Z"), y: byDate.get(d).sum / byDate.get(d).count }));
}

async function fetchNewsSentiment(apiKey, tickers, daysBack) {
  const from = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const timeFrom = from.toISOString().slice(0, 10).replace(/-/g, "") + "T0000";
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=NEWS_SENTIMENT&tickers=${tickers}&time_from=${timeFrom}&sort=EARLIEST&limit=1000&apikey=${apiKey}`
  );
  const feed = payload.feed;
  if (!feed || !feed.length) {
    throw new Error(
      "Alpha Vantage NEWS_SENTIMENT returned no articles: " + (payload.Note || payload.Information || payload.error || JSON.stringify(payload).slice(0, 200))
    );
  }
  return feed;
}

function buildNewsSentimentComponent(feed) {
  const points = buildNewsSentimentPoints(feed);
  const latestValue = points.length ? points[points.length - 1].y : null;

  const scoreSeries = computeRelativeScoreSeries(points, NEWS_SENTIMENT_SCORE_WINDOW, NEWSSENTIMENT_SPEC.invert);
  const latest = scoreSeries.length ? scoreSeries[scoreSeries.length - 1] : null;

  return {
    id: NEWSSENTIMENT_SPEC.id,
    name: NEWSSENTIMENT_SPEC.name,
    value: latestValue !== null ? round(latestValue, 3) : null,
    unit: NEWSSENTIMENT_SPEC.unit,
    percentile: latestValue !== null ? percentileRank(points.map((p) => p.y), latestValue) : null,
    score: latest ? latest.score : 50,
    weight: NEWSSENTIMENT_SPEC.weight,
    source: NEWSSENTIMENT_SPEC.source,
    description: NEWSSENTIMENT_SPEC.description,
    details: NEWSSENTIMENT_SPEC.details,
    history: points.map((p) => ({ date: toDateStr(p.x), value: round(p.y, 4) })),
    calc: latest
      ? {
          window: NEWS_SENTIMENT_SCORE_WINDOW,
          periodLabel: "day",
          invert: NEWSSENTIMENT_SPEC.invert,
          value: round(latest.value, 4),
          ma: round(latest.ma, 4),
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

    // Each upstream fetch is wrapped so one failing source (e.g. an
    // Alpha Vantage entitlement change on INDEX_DATA) degrades only the
    // factors that depend on it, rather than 502ing the whole response —
    // most factors here (credit, breadth internals, put/call, the 3
    // manual factors) have nothing to do with SPX/VIX and should still
    // render. Warnings are collected and surfaced to the frontend instead
    // of thrown, unless every single factor ends up unavailable.
    const warnings = [];
    async function safe(label, fn) {
      try {
        return await fn();
      } catch (err) {
        warnings.push(`${label}: ${err.message}`);
        return null;
      }
    }

    // Sequential with a gap, not Promise.all: Alpha Vantage trips a
    // burst-rate detector ("no more than 5 requests per second") when
    // multiple requests land concurrently OR too close together even
    // when awaited one at a time - fast-resolving calls can still land
    // under 200ms apart otherwise. Same issue hit in ticker.js and
    // volatility.js, but those only had 2-3 calls to space out.
    const spxDaily = await safe("Price Momentum / Realized Volatility (S&P 500 via SPY)", () => fetchStockDailyOHLC(apiKey, "SPY", "full"));
    await sleep(300);
    const vixDaily = await safe("Implied Volatility (VIX)", () => fetchIndexDaily(apiKey, "VIX"));
    await sleep(300);
    // "full" rather than "compact": the earlier compact (~100-day) choice
    // was about request latency, not payload safety - the real fix for
    // burst-rate errors was the explicit spacing above, so full history
    // is safe here too, and unlocks a proper multi-year chart for these
    // two factors instead of bottlenecking the composite history below.
    const hygDaily = await safe("Credit Conditions (HYG)", () => fetchStockDaily(apiKey, "HYG", "full"));
    await sleep(300);
    const lqdDaily = await safe("Credit Conditions (LQD)", () => fetchStockDaily(apiKey, "LQD", "full"));
    await sleep(300);
    const iwmDaily = await safe("Small-Cap Relative Strength (IWM)", () => fetchStockDaily(apiKey, "IWM", "full"));
    await sleep(300);
    const rspDaily = await safe("Equal-Weight Participation (RSP)", () => fetchStockDaily(apiKey, "RSP", "full"));
    await sleep(300);
    const newsFeed = await safe("News Sentiment (SPY)", () => fetchNewsSentiment(apiKey, "SPY", NEWS_SENTIMENT_LOOKBACK_DAYS));

    const putCallPoints = spxDaily
      ? await safe("Equity Put/Call Ratio", () => fetchPutCallWindow(apiKey, "SPY", spxDaily.map((p) => toDateStr(p.x))))
      : null;
    if (!spxDaily) warnings.push("Equity Put/Call Ratio: skipped, depends on SPX trading dates which failed to load");

    const breadthInternals = await safe("Market Breadth", () => fetchBreadthInternals());

    const chartComponents = [];
    if (breadthInternals) {
      chartComponents.push(buildSeriesComponent(breadthInternals.adLinePoints, BREADTH_ADLINE_SPEC));
      chartComponents.push(buildSeriesComponent(breadthInternals.hiLoPoints, BREADTH_HILO_SPEC));
      chartComponents.push(buildSeriesComponent(breadthInternals.pct200Points, BREADTH_PCT200_SPEC));
    }
    if (hygDaily && lqdDaily) {
      chartComponents.push(buildSeriesComponent(computeNormalizedRatioSeries(hygDaily, lqdDaily), CREDIT_SPEC));
    }
    if (vixDaily) {
      chartComponents.push(buildSeriesComponent(vixDaily.map((p) => ({ x: p.x, y: p.close })), VIX_SPEC));
    }
    if (spxDaily) {
      chartComponents.push(buildMomentumComponent(spxDaily));
      chartComponents.push(buildRealizedVolComponent(spxDaily));
      const spxCloses = spxDaily.map((p) => ({ x: p.x, y: p.close }));
      if (iwmDaily) chartComponents.push(buildSeriesComponent(computeNormalizedRatioSeries(iwmDaily, spxCloses), SMALLCAP_SPEC));
      if (rspDaily) chartComponents.push(buildSeriesComponent(computeNormalizedRatioSeries(rspDaily, spxCloses), EQUALWEIGHT_SPEC));
    }
    const dailyComponents = chartComponents; // alias kept for the history-merge loop below
    const putCallComponent = putCallPoints ? buildPutCallComponent(putCallPoints) : null;
    const newsSentimentComponent = newsFeed ? buildNewsSentimentComponent(newsFeed) : null;

    // Ordered by weight, descending, so the cards render heaviest-first.
    // Missing factors (upstream fetch failed) are simply absent, not
    // null placeholders — the frontend only ever sees factors that
    // actually loaded.
    const componentsById = new Map(
      [...chartComponents, ...(putCallComponent ? [putCallComponent] : []), ...(newsSentimentComponent ? [newsSentimentComponent] : [])].map((c) => [c.id, c])
    );
    const components = [
      "credit", "breadthadline", "breadthhilo", "breadthpct200", "putcall", "momentum",
      "vix", "realizedvol", "smallcap", "equalweight", "newssentiment",
    ]
      .map((id) => componentsById.get(id))
      .filter(Boolean);

    if (!components.length) {
      throw new Error("All factors failed to load" + (warnings.length ? ": " + warnings.join("; ") : ""));
    }

    const composite = Math.round(
      components.reduce((sum, c) => sum + c.score * c.weight, 0) /
        components.reduce((sum, c) => sum + c.weight, 0)
    );

    // Composite history: our own weighted average of each factor's
    // self-computed score series, date-aligned, paired with S&P 500
    // closes. Equity Put/Call and News Sentiment are excluded from this
    // historical chart — their fetchable history is too short to
    // date-align with the decades-deep series below (see PUTCALL_SPEC /
    // NEWSSENTIMENT_SPEC) — but both still count fully toward the live
    // composite score above, just not this chart.
    const CHART_SPECS_ALL = [
      BREADTH_ADLINE_SPEC, BREADTH_HILO_SPEC, BREADTH_PCT200_SPEC,
      CREDIT_SPEC, VIX_SPEC, MOMENTUM_SPEC, REALIZED_VOL_SPEC,
      SMALLCAP_SPEC, EQUALWEIGHT_SPEC,
    ];
    const loadedChartIds = new Set(dailyComponents.map((c) => c.id));
    const CHART_SPECS = CHART_SPECS_ALL.filter((spec) => loadedChartIds.has(spec.id));
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

    const spxCloseByDate = spxDaily ? new Map(spxDaily.map((p) => [toDateStr(p.x), p.close])) : new Map();
    const spxDatesSorted = spxDaily ? spxDaily.map((p) => toDateStr(p.x)).sort() : [];
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
      warnings, // non-fatal: factors that failed to load and were excluded from the composite above
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
