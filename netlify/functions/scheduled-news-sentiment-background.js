// Scheduled Background Function (see [functions."scheduled-news-sentiment-
// background"] in netlify.toml) that sweeps Alpha Vantage's NEWS_SENTIMENT
// endpoint across the full S&P 500 (BREADTH_CONSTITUENTS), one
// `tickers=<symbol>&limit=50` call per company, for the "News Sentiment
// Momentum" page — per-stock/per-sector recent financial-news sentiment.
// Distinct from /sentiment-index.html (a single market-wide macro-sentiment
// gauge built from put/call ratios and breadth, under Behavioral/
// Positioning) — this page screens individual companies/sectors. This job
// never touches sentiment-index.html's own backend or blob store.
//
// Per-company derived metrics, from each article in that company's `feed`:
//   - Find the ticker_sentiment entry matching the QUERIED symbol (not
//     assumed to be ticker_sentiment[0] — an article about several
//     companies can list them in any order, and defensively, an article
//     can come back in the response without a ticker_sentiment entry for
//     the queried symbol at all).
//   - weightedSentiment = sum(ticker_sentiment_score * relevance_score) /
//     sum(relevance_score) across matched articles (relevance_score and
//     ticker_sentiment_score both arrive as strings — parseFloat each;
//     an article is skipped from the sum if either fails to parse).
//   - articleCount = number of matched articles — the company's recent
//     news attention/coverage, a distinct signal from the sentiment score
//     itself (is the market even talking about this name this week).
//   - Bullish/Somewhat-Bullish/Neutral/Somewhat-Bearish/Bearish counts,
//     bucketed by each matched article's own ticker_sentiment_label (AV's
//     five-bucket scale) — a secondary, more outlier-robust view alongside
//     the continuous weighted average.
// A company with fewer than MIN_ARTICLES_FOR_SENTIMENT matched articles is
// still written to the full table (tagged "insufficient coverage" by the
// page, articleCount shown as-is) but excluded from every sentiment-
// dependent leaderboard/chart/aggregate below — see that constant's own
// comment for the rationale.
//
// NEWS_SENTIMENT is a snapshot endpoint (latest ~50 articles as of the
// sweep run, no historical time-series call of its own) — same category as
// OVERVIEW behind /pe-divergence.html or INSTITUTIONAL_HOLDINGS behind
// /institutional-ownership.html — so the market-wide weekly median
// weighted-sentiment score is appended to a running history each run
// rather than fabricated as a synthetic time series.
//
// Storage discipline: each article's `topics` array and every OTHER
// ticker's ticker_sentiment entry (other companies mentioned in the same
// article) are discarded immediately after this company's own matched
// values are extracted — only the small set of derived per-company fields
// above are ever written to the blob, never a full article payload. Same
// precedent as scheduled-institutional-ownership-background.js discarding
// the full per-holder `holdings` array.
//
// Real cross-page dependency, not a coincidence: like scheduled-buyback-
// tracker-background.js and scheduled-institutional-ownership-
// background.js, this job reads scheduled-relative-strength-background's
// own latest.json (getRelativeStrengthStore) for the "does media sentiment
// predict returns" test (Tetlock 2007) — weighted sentiment score vs.
// subsequent 3-month relative price return — instead of running a second
// ~503-call price sweep. If that blob isn't populated yet, this job still
// writes sentiment/attention rows (relPrice3M: null on every company)
// instead of failing outright, and the page shows a warning rather than
// erroring — same fallback pattern.
//
// Name/sector come from Sector Beeswarm's own weekly meta.json, same
// convention as every other full-universe job on this site.
//
// Pacing: NEWS_SENTIMENT responses run notably larger than most other AV
// endpoints used on this site — confirmed directly during this page's
// build (a single JNJ call returned ~50 articles with nested topics/
// ticker_sentiment arrays, tens of KB of JSON) — so this sweep uses the
// same ~1050ms between-call pacing proven at this scale by
// scheduled-buyback-tracker-background.js / scheduled-institutional-
// ownership-background.js, plus a retry pass for anything that fails.
// Error-shape check: a live NEWS_SENTIMENT call during this page's build
// returned the standard {items, feed, ...} envelope with no distinct
// rate-limit shape observed; this job defends against a rate limit the
// same way every other full-sweep job on this site does — checking for
// the standard AV `Note`/`Information`/`error` fields below — rather than
// assuming NEWS_SENTIMENT can't ever return one.

const { getNewsSentimentStore, BLOB_KEY } = require("./news-sentiment-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LEADERBOARD_COUNT = 15;
const MAX_HISTORY_WEEKS = 104;
// A floor to keep the sentiment-dependent leaderboards/charts from being
// dominated by names the news simply hasn't covered much this week. Each
// company query returns up to 50 recent articles that already mention it,
// so real S&P 500 coverage usually clears this easily — but thinly-covered
// small- and mid-caps (or a mega-cap in an unusually quiet news week) can
// come back with only 1-2 matched articles, and a relevance-weighted
// average built off one or two articles is dominated by whichever article
// happened to run, not a meaningful "how is the market talking about this
// company" read. 5 is chosen as a low-but-real floor — enough that a
// single outlier article can't set the whole score, while still keeping
// most of the S&P 500 eligible most weeks. Companies below the floor stay
// in the full table (tagged "insufficient coverage"), just not in the
// leaderboards, sector aggregate, scatter, or regression.
const MIN_ARTICLES_FOR_SENTIMENT = 5;

const SENTIMENT_LABELS = ["Bearish", "Somewhat-Bearish", "Neutral", "Somewhat-Bullish", "Bullish"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, digits = 3) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

async function fetchNewsSentiment(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=NEWS_SENTIMENT&tickers=${symbol}&limit=50&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }

  const feed = Array.isArray(payload.feed) ? payload.feed : [];

  let sumWeighted = 0;
  let sumRelevance = 0;
  let articleCount = 0;
  const buckets = { Bearish: 0, "Somewhat-Bearish": 0, Neutral: 0, "Somewhat-Bullish": 0, Bullish: 0 };

  for (const article of feed) {
    const tickerSentiment = Array.isArray(article.ticker_sentiment) ? article.ticker_sentiment : [];
    // Defensive: don't assume ticker_sentiment[0] is this symbol — find the
    // entry that actually matches the queried ticker, and skip the article
    // entirely if none does (shouldn't normally happen given the query,
    // but the data has been observed to occasionally omit it).
    const entry = tickerSentiment.find((t) => t && t.ticker === symbol);
    if (!entry) continue;

    // Discard everything else about the article (topics, other tickers'
    // sentiment) immediately after pulling this company's own values —
    // never retained past this loop iteration, per the file header note.
    const relevance = parseFloat(entry.relevance_score);
    const score = parseFloat(entry.ticker_sentiment_score);
    if (!Number.isFinite(relevance) || !Number.isFinite(score)) continue;

    sumWeighted += score * relevance;
    sumRelevance += relevance;
    articleCount += 1;
    if (Object.prototype.hasOwnProperty.call(buckets, entry.ticker_sentiment_label)) {
      buckets[entry.ticker_sentiment_label] += 1;
    }
  }

  const weightedSentiment = articleCount > 0 && sumRelevance > 0 ? sumWeighted / sumRelevance : null;

  return { articleCount, weightedSentiment, buckets };
}

function dominantLabel(buckets) {
  let best = null, bestCount = -1;
  for (const label of SENTIMENT_LABELS) {
    if (buckets[label] > bestCount) { best = label; bestCount = buckets[label]; }
  }
  return bestCount > 0 ? best : null;
}

exports.handler = async () => {
  console.log(`scheduled-news-sentiment-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let relativeStrengthBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relativeStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-news-sentiment-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relativeStrengthBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const entry = await fetchNewsSentiment(apiKey, symbol);
        results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-news-sentiment-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute|per day|frequency/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-news-sentiment-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(1050);
      }
      todo = missed;
    }

    console.log(`scheduled-news-sentiment-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, e] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      const hasCoverage = e.articleCount >= MIN_ARTICLES_FOR_SENTIMENT;
      const relPrice3M = Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, symbol)
        ? relativeStrengthBySymbol[symbol]
        : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        articleCount: e.articleCount,
        weightedSentiment: e.weightedSentiment !== null ? round(e.weightedSentiment) : null,
        bullishCount: e.buckets.Bullish,
        somewhatBullishCount: e.buckets["Somewhat-Bullish"],
        neutralCount: e.buckets.Neutral,
        somewhatBearishCount: e.buckets["Somewhat-Bearish"],
        bearishCount: e.buckets.Bearish,
        dominantLabel: dominantLabel(e.buckets),
        hasCoverage,
        relPrice3M,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both news-sentiment data and sector metadata");

    const covered = companies.filter((c) => c.hasCoverage && c.weightedSentiment !== null);

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = covered.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          avgWeightedSentiment: round(mean(inSector.map((c) => c.weightedSentiment))),
          medianWeightedSentiment: round(median(inSector.map((c) => c.weightedSentiment))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      withCoverage: covered.length,
      totalArticlesMatched: companies.reduce((s, c) => s + (c.articleCount || 0), 0),
      withPriceData: companies.filter((c) => c.relPrice3M !== null).length,
      medianWeightedSentiment: round(median(covered.map((c) => c.weightedSentiment))),
      meanWeightedSentiment: round(mean(covered.map((c) => c.weightedSentiment))),
    };
    const bullishSkewCount = covered.filter((c) => c.weightedSentiment > 0).length;
    market.bullishSkewPct = covered.length ? round((bullishSkewCount / covered.length) * 100, 1) : null;

    const mostBullish = [...covered].sort((a, b) => b.weightedSentiment - a.weightedSentiment).slice(0, LEADERBOARD_COUNT);
    const mostBearish = [...covered].sort((a, b) => a.weightedSentiment - b.weightedSentiment).slice(0, LEADERBOARD_COUNT);
    const highestAttention = [...covered].sort((a, b) => b.articleCount - a.articleCount).slice(0, LEADERBOARD_COUNT);

    // Sentiment-vs-attention scatter: does heavier coverage skew more
    // positive/negative or is there no relationship — genuinely open, not
    // presupposed. x = article count (attention), y = weighted sentiment.
    const attentionScatterPairs = covered.map((c) => ({ x: c.articleCount, y: c.weightedSentiment, symbol: c.symbol }));

    // Tetlock (2007)-style test: does media sentiment predict subsequent
    // returns. x = weighted sentiment score, y = 3-month relative return.
    const returnRegressionPairs = covered
      .filter((c) => c.relPrice3M !== null)
      .map((c) => ({ x: c.weightedSentiment, y: c.relPrice3M, symbol: c.symbol }));

    const store = getNewsSentimentStore();
    const previous = (await store.get(BLOB_KEY, { type: "json" })) || { history: [] };
    const history = Array.isArray(previous.history) ? previous.history : [];
    const weekKey = new Date().toISOString().slice(0, 10);
    const historyPoint = { week: weekKey, medianWeightedSentiment: market.medianWeightedSentiment };
    if (!history.length || history[history.length - 1].week !== weekKey) {
      history.push(historyPoint);
    } else {
      history[history.length - 1] = historyPoint;
    }
    while (history.length > MAX_HISTORY_WEEKS) history.shift();

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasPriceData,
      minArticlesForSentiment: MIN_ARTICLES_FOR_SENTIMENT,
      market,
      sectors,
      history,
      mostBullish,
      mostBearish,
      highestAttention,
      attentionScatterPairs,
      returnRegressionPairs,
      companies,
    };

    await store.setJSON(BLOB_KEY, payload);

    console.log(
      `scheduled-news-sentiment-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `${companies.length} with sector metadata, ${covered.length} with sufficient coverage (>=${MIN_ARTICLES_FOR_SENTIMENT} articles), ` +
      `${history.length}-week history, hasPriceData=${hasPriceData}`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error("scheduled-news-sentiment-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
