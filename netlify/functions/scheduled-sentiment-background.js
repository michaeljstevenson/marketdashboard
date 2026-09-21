// Scheduled function (see [functions."scheduled-sentiment-background"] in
// netlify.toml) that computes the U.S. Market Sentiment Index once daily and
// writes the result to Netlify Blobs for data.js to serve. The scoring
// method (methodology v2) lives in sentiment-engine.js; this file fetches the
// inputs and writes the blob.
//
// Inputs: Yahoo Finance daily bars for the S&P 500 (^GSPC), ^VIX, ^VIX3M, ^SKEW,
// the Russell 2000 (^RUT), VUSTX, HYG/LQD (with VWEHX/VWESX before 2007) and RSP, plus the breadth internals blob (scheduled-breadth-background.js).
// Put/Call (AV-derived blob) and News Sentiment (Alpha Vantage) have only weeks
// of history, so they are published as supplementary indicators next to the
// composite but are not scored into it — that keeps the live reading and the
// history chart on identical math, so today's composite is always the last
// point of the history series.

const { getBreadthStore, BLOB_KEY: BREADTH_BLOB_KEY } = require("./breadth-blob-store");
const { getPutCallStore, BLOB_KEY: PUTCALL_BLOB_KEY } = require("./putcall-blob-store");
const { getSentimentStore, BLOB_KEY: SENTIMENT_BLOB_KEY } = require("./sentiment-blob-store");
const { recordAvCall } = require("./av-call-counter");
const { fetchDailyBars, sleep: yahooSleep } = require("./yahoo-client");
const { buildIndex } = require("./sentiment-engine");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

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

// Equity Put/Call Ratio: fetched and scored once daily by
// scheduled-putcall-background.js (see that file for why — Alpha
// Vantage has no bulk historical endpoint for this, so live per-page-
// load fetching was both slow and flaky under rate-limiting). Read from
// Netlify Blobs here. Because its usable history (~90 trading days) is
// still much shorter than the other factors', it's published as a
// supplementary indicator and is not scored into the composite.
const PUTCALL_SCORE_WINDOW = 30;

async function fetchPutCallFromBlob() {
  const store = getPutCallStore();
  const payload = await store.get(PUTCALL_BLOB_KEY, { type: "json" });
  if (!payload || !payload.points || !payload.points.length) {
    throw new Error("Put/call blob not yet populated — scheduled-putcall-background hasn't run yet");
  }
  return payload.points.map((p) => ({ x: Date.parse(p.date), y: p.value }));
}

const PUTCALL_SPEC = {
  id: "putcall",
  name: "Equity Put/Call Ratio",
  unit: "ratio",
  weight: 0,
  invert: true,
  source: { name: "Alpha Vantage — SPY Options Put/Call Ratio", url: "https://www.alphavantage.co/" },
  description: "A rising put/call ratio relative to trend indicates bearish positioning.",
  details:
    "This factor tracks the full-options-chain ratio of put contracts (bets that SPY will fall) to call contracts (bets that it will rise). When investors are nervous, they buy more puts to hedge or speculate on declines, pushing the ratio up; when they're confident, call buying dominates and the ratio falls.\n\nAlpha Vantage only exposes this ratio one trading day at a time (no bulk historical endpoint), so this factor is fetched and scored once daily by a background job rather than live, against a shorter 30-day trailing average than the 50-day window used elsewhere — and is a supplementary indicator: with only about 90 trading days of history it can't be standardized or backtested like the scored factors, so it is displayed alongside the composite but is not part of it.",
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

// News Sentiment: Alpha Vantage's News & Sentiment feed for SPY-tagged
// financial coverage, averaged per day. Like Equity Put/Call, the feed
// only returns a bounded recent window (not a bulk decades-long
// history), so this factor is scored over a shorter trailing window and
// published as a supplementary indicator, not scored into the composite.
const NEWS_SENTIMENT_SCORE_WINDOW = 10;
const NEWS_SENTIMENT_LOOKBACK_DAYS = 60;

const NEWSSENTIMENT_SPEC = {
  id: "newssentiment",
  name: "News Sentiment",
  unit: "avg. article sentiment",
  weight: 0,
  invert: false,
  source: { name: "Alpha Vantage — News & Sentiment (SPY)", url: "https://www.alphavantage.co/" },
  description: "Financial news coverage skewing more positive than its recent trend reflects rising investor optimism.",
  details:
    "This factor aggregates Alpha Vantage's News & Sentiment feed for SPY-tagged financial news articles, averaging each day's per-article sentiment score (roughly -1 very bearish to +1 very bullish) — an automated read on how the financial press is framing the market.\n\nThe score compares each day's average article sentiment to its own trailing 10-day average, ranked against the ~60 days of coverage this factor has usable history for. Because the News & Sentiment API returns a bounded recent feed rather than a bulk decades-long history, this is a supplementary indicator: displayed alongside the composite but not part of it.",
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


async function fetchBreadthRows() {
  const payload = await getBreadthStore().get(BREADTH_BLOB_KEY, { type: "json" });
  if (!payload || !payload.rows || !payload.rows.length) {
    throw new Error("Breadth internals blob not yet populated — scheduled-breadth hasn't run yet");
  }
  return { rows: payload.rows, constituentCount: payload.constituentCount };
}

function supplementary(component, note) {
  return { ...component, weight: 0, supplementary: true, note, contribution: 0 };
}

exports.handler = async () => {
  console.log("scheduled-sentiment-background: starting");
  try {
    const now = new Date();
    const warnings = [];
    async function safe(label, fn) {
      try {
        return await fn();
      } catch (err) {
        warnings.push(`${label}: ${err.message}`);
        return null;
      }
    }

    // Yahoo 429s intermittently; yahoo-client retries with backoff, and the
    // gap keeps eleven full-history pulls from tripping it in the first place.
    const bars = {};
    for (const sym of ["^GSPC", "^VIX", "^VIX3M", "^SKEW", "^RUT", "VUSTX", "HYG", "LQD", "VWEHX", "VWESX", "RSP"]) {
      bars[sym] = await safe(`Yahoo ${sym}`, () => fetchDailyBars(sym));
      await yahooSleep(300);
    }
    if (!bars["^GSPC"]) throw new Error("S&P 500 history unavailable — cannot build the trading calendar: " + warnings.join("; "));

    const breadth = await safe("Market Breadth", fetchBreadthRows);

    const index = buildIndex({
      spx: bars["^GSPC"],
      vix: bars["^VIX"],
      vix3m: bars["^VIX3M"],
      skew: bars["^SKEW"],
      hyg: bars.HYG,
      lqd: bars.LQD,
      rut: bars["^RUT"],
      ust: bars.VUSTX,
      vwehx: bars.VWEHX,
      vwesx: bars.VWESX,
      rsp: bars.RSP,
      breadth: breadth ? breadth.rows : null,
      constituentCount: breadth ? breadth.constituentCount : null,
    });
    if (index.composite === null || !index.components.length) {
      throw new Error("Index could not be computed" + (warnings.length ? ": " + warnings.join("; ") : ""));
    }
    for (const id of index.missing) warnings.push(`Factor unavailable: ${id}`);

    const putCallPoints = await safe("Equity Put/Call Ratio", () => fetchPutCallFromBlob());
    let newsFeed = null;
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (apiKey) newsFeed = await safe("News Sentiment (SPY)", () => fetchNewsSentiment(apiKey, "SPY", NEWS_SENTIMENT_LOOKBACK_DAYS));
    const extras = [];
    if (putCallPoints) {
      extras.push(supplementary(buildPutCallComponent(putCallPoints), "Supplementary: about 90 trading days of history, so it is shown but not scored into the composite."));
    }
    if (newsFeed) {
      extras.push(supplementary(buildNewsSentimentComponent(newsFeed), "Supplementary: about 30 days of history, so it is shown but not scored into the composite."));
    }

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
      asOfDate: index.asOfDate,
      composite: index.composite,
      compositeExact: index.compositeExact,
      coverage: index.coverage,
      methodology: index.methodology,
      components: [...index.components, ...extras],
      history: index.history,
      warnings,
    };

    await getSentimentStore().setJSON(SENTIMENT_BLOB_KEY, data);
    console.log(`scheduled-sentiment-background: wrote composite=${index.compositeExact} (${index.asOfDate}), ${index.components.length} scored + ${extras.length} supplementary components, ${index.history.length} history points`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, composite: index.composite, components: index.components.length }) };
  } catch (err) {
    console.error(`scheduled-sentiment-background: failed: ${err.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
