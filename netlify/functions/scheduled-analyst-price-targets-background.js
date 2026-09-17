// Scheduled Background Function (see [functions."scheduled-analyst-price-
// targets-background"] in netlify.toml — currently a one-time snapshot, no
// recurring schedule, per the 2026-09-16 site-wide convention described
// there) that sweeps Alpha Vantage's COMPANY_OVERVIEW across the full S&P
// 500 (BREADTH_CONSTITUENTS) and computes, per stock: a weighted analyst
// consensus rating score from the AnalystRatingStrongBuy/Buy/Hold/Sell/
// StrongSell counts, and the price-target-implied upside from
// AnalystTargetPrice — the "Analyst Ratings & Price Targets" page.
//
// This is a distinct question from /analyst-estimate-dispersion.html (how
// much analysts disagree about a stock's *EPS estimate*) — this page is
// about *buy/sell recommendations and price targets*, a different pair of
// fields Alpha Vantage's OVERVIEW payload happens to carry.
//
// No GLOBAL_QUOTE / TIME_SERIES sweep for a "current price" to compare the
// target against: OVERVIEW's own 50DayMovingAverage field is used as the
// current-price proxy instead, trading a small amount of staleness (up to
// ~50 trading days smoothed) for avoiding a second ~503-call sweep. The
// page's methodology section says so explicitly.
//
// Reads name/sector directly off each stock's own OVERVIEW response
// (normalizeSector, the same GICS-normalization helper
// scheduled-beeswarm-meta-background.js uses) rather than joining against
// that job's meta.json blob — this job already pays for the full OVERVIEW
// sweep, so pulling Name/Sector from the same response avoids a second
// cross-job dependency for no extra Alpha Vantage cost (same reasoning as
// scheduled-equity-risk-premium-background.js).
//
// Also opportunistically reads relative-strength's own latest.json
// (getRelativeStrengthStore) for each stock's trailing 3-month return vs.
// SPY, purely to test whether analyst optimism tracks recent price trend —
// no extra sweep, and a graceful "not available this run" fallback (same
// pattern as scheduled-earnings-growth-divergence-background.js) if that
// blob is empty or stale.
//
// Also carries three more fields straight off the same OVERVIEW response —
// PercentInstitutions, PercentInsiders, MarketCapitalization — that this
// page's own charts don't use but /institutional-ownership.html does, so
// that page needs no OVERVIEW sweep of its own (same "the job that already
// pays for the full sweep reads whatever fields off it a same-night sibling
// page needs" reuse as scheduled-shareholder-yield-background.js reading
// scheduled-share-count-background.js's output, just one hop earlier).
//
// ~503 sequential calls, 1050ms apart with a retry pass — same pacing
// proven at this exact scale by scheduled-beeswarm-meta-background.js's own
// OVERVIEW sweep.

const { getAnalystPriceTargetsStore, LATEST_KEY } = require("./analyst-price-targets-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LEADERBOARD_COUNT = 15;
const MIN_ANALYSTS = 5; // same "min covering analysts" threshold as analyst-estimate-dispersion

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, digits = 2) {
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

async function fetchOverview(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=COMPANY_OVERVIEW&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = await res.json();
  if (p.Note || p.Information || p.error) throw new Error(p.Note || p.Information || JSON.stringify(p.error));
  if (!p.Symbol) return null; // empty body — no data for this symbol
  return {
    name: p.Name || symbol,
    sector: normalizeSector(symbol, p.Sector),
    targetPrice: parseFloat(p.AnalystTargetPrice),
    priceProxy: parseFloat(p["50DayMovingAverage"]),
    strongBuy: parseInt(p.AnalystRatingStrongBuy, 10),
    buy: parseInt(p.AnalystRatingBuy, 10),
    hold: parseInt(p.AnalystRatingHold, 10),
    sell: parseInt(p.AnalystRatingSell, 10),
    strongSell: parseInt(p.AnalystRatingStrongSell, 10),
    percentInstitutions: parseFloat(p.PercentInstitutions),
    percentInsiders: parseFloat(p.PercentInsiders),
    marketCap: parseFloat(p.MarketCapitalization),
  };
}

exports.handler = async () => {
  console.log(`scheduled-analyst-price-targets-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    let relativeStrengthBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relativeStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-analyst-price-targets-background: could not read relative-strength blob, continuing without it:", err.message);
    }
    const hasRelativeStrength = Object.keys(relativeStrengthBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const ov = await fetchOverview(apiKey, symbol);
        if (ov) results.set(symbol, ov);
        return true;
      } catch (err) {
        console.error(`scheduled-analyst-price-targets-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-analyst-price-targets-background: retry pass for ${todo.length} ticker(s)`);
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

    const companies = [];
    for (const [symbol, ov] of results.entries()) {
      if (!ov.sector) continue;

      const ratingCounts = [ov.strongBuy, ov.buy, ov.hold, ov.sell, ov.strongSell];
      const hasAllCounts = ratingCounts.every((n) => Number.isFinite(n));
      const totalAnalysts = hasAllCounts ? ratingCounts.reduce((a, b) => a + b, 0) : 0;
      const hasCoverage = hasAllCounts && totalAnalysts >= MIN_ANALYSTS;

      // 1 = Strong Buy ... 5 = Strong Sell (the standard sell-side
      // convention, e.g. Zacks Rank) — lower is more bullish.
      const consensusScore = hasCoverage
        ? (1 * ov.strongBuy + 2 * ov.buy + 3 * ov.hold + 4 * ov.sell + 5 * ov.strongSell) / totalAnalysts
        : null;

      const validTarget = Number.isFinite(ov.targetPrice) && ov.targetPrice > 0;
      const validProxy = Number.isFinite(ov.priceProxy) && ov.priceProxy > 0;
      const impliedUpside = (validTarget && validProxy)
        ? (ov.targetPrice / ov.priceProxy - 1) * 100
        : null;

      const validInstitutions = Number.isFinite(ov.percentInstitutions);
      const validInsiders = Number.isFinite(ov.percentInsiders);
      const validMarketCap = Number.isFinite(ov.marketCap) && ov.marketCap > 0;

      // Keep a row if it has ANY usable signal — analyst, or ownership —
      // since /institutional-ownership.html reads this same array for
      // fields this page's own charts don't otherwise need.
      if (consensusScore === null && impliedUpside === null && !validInstitutions && !validInsiders) continue;

      companies.push({
        symbol,
        name: ov.name,
        sector: ov.sector,
        totalAnalysts: hasAllCounts ? totalAnalysts : null,
        strongBuy: hasAllCounts ? ov.strongBuy : null,
        buy: hasAllCounts ? ov.buy : null,
        hold: hasAllCounts ? ov.hold : null,
        sell: hasAllCounts ? ov.sell : null,
        strongSell: hasAllCounts ? ov.strongSell : null,
        consensusScore: round(consensusScore),
        targetPrice: validTarget ? round(ov.targetPrice) : null,
        priceProxy: validProxy ? round(ov.priceProxy) : null,
        impliedUpside: round(impliedUpside),
        rel3M: Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, symbol)
          ? relativeStrengthBySymbol[symbol]
          : null,
        percentInstitutions: validInstitutions ? round(ov.percentInstitutions) : null,
        percentInsiders: validInsiders ? round(ov.percentInsiders) : null,
        marketCap: validMarketCap ? ov.marketCap : null,
      });
    }

    const covered = companies.filter((c) => c.consensusScore !== null);
    const upsideRanked = companies.filter((c) => c.impliedUpside !== null).sort((a, b) => b.impliedUpside - a.impliedUpside);

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        const scored = inSector.filter((c) => c.consensusScore !== null);
        const upside = inSector.filter((c) => c.impliedUpside !== null);
        if (!scored.length && !upside.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianConsensusScore: round(median(scored.map((c) => c.consensusScore))),
          medianImpliedUpside: round(median(upside.map((c) => c.impliedUpside))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      coveredCount: covered.length,
      medianConsensusScore: round(median(covered.map((c) => c.consensusScore))),
      medianImpliedUpside: round(median(upsideRanked.map((c) => c.impliedUpside))),
    };

    const mostBullish = [...covered].sort((a, b) => a.consensusScore - b.consensusScore).slice(0, LEADERBOARD_COUNT);
    const leastBullish = [...covered].sort((a, b) => b.consensusScore - a.consensusScore).slice(0, LEADERBOARD_COUNT);
    const highestUpside = upsideRanked.slice(0, LEADERBOARD_COUNT);
    const lowestUpside = upsideRanked.slice(-LEADERBOARD_COUNT).reverse();

    // Consensus-score-vs-implied-upside pairs: two independently-reported
    // analyst signals from the same OVERVIEW payload — do they actually
    // agree with each other? (Lower consensus score = more bullish, so a
    // real relationship should be negative: more bullish ratings pairing
    // with higher price-target upside.)
    const consensusUpsidePairs = companies
      .filter((c) => c.consensusScore !== null && c.impliedUpside !== null)
      .map((c) => ({ x: c.consensusScore, y: c.impliedUpside, symbol: c.symbol }));

    // Implied-upside-vs-trailing-3-month-relative-return pairs: do analysts
    // set higher price targets on names that have already run (trend-
    // following) or on laggards (contrarian/value)? Only populated when
    // relative-strength's own blob has data this run.
    const upsideMomentumPairs = hasRelativeStrength
      ? companies
        .filter((c) => c.impliedUpside !== null && c.rel3M !== null)
        .map((c) => ({ x: c.rel3M, y: c.impliedUpside, symbol: c.symbol }))
      : [];

    const store = getAnalystPriceTargetsStore();
    const generatedAt = new Date().toISOString();

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      minAnalysts: MIN_ANALYSTS,
      hasRelativeStrength,
      market,
      sectors,
      mostBullish,
      leastBullish,
      highestUpside,
      lowestUpside,
      consensusUpsidePairs,
      upsideMomentumPairs,
      companies: companies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        totalAnalysts: c.totalAnalysts,
        strongBuy: c.strongBuy,
        buy: c.buy,
        hold: c.hold,
        sell: c.sell,
        strongSell: c.strongSell,
        consensusScore: c.consensusScore,
        targetPrice: c.targetPrice,
        priceProxy: c.priceProxy,
        impliedUpside: c.impliedUpside,
        percentInstitutions: c.percentInstitutions,
        percentInsiders: c.percentInsiders,
        marketCap: c.marketCap,
      })),
    };

    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-analyst-price-targets-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `${covered.length} with >=${MIN_ANALYSTS} analysts, ${upsideRanked.length} with a usable implied upside, ` +
      `relative-strength data: ${hasRelativeStrength}`
    );

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("scheduled-analyst-price-targets-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
