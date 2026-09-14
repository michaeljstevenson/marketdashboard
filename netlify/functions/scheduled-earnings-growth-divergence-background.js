// Scheduled Background Function (see
// [functions."scheduled-earnings-growth-divergence-background"] in
// netlify.toml) that sweeps Alpha Vantage's EARNINGS across the full S&P
// 500 (BREADTH_CONSTITUENTS) for trailing year-over-year quarterly EPS
// growth, joins it against this same night's Relative Strength
// Leaders/Laggards blob for 3-month price performance vs. SPY, and scores
// the divergence between the two — the "Earnings Growth vs. Price
// Performance Divergence" page.
//
// Real cross-page dependency, not a coincidence: this job reads
// relative-strength's own latest.json (getRelativeStrengthStore) for the
// price-performance half of the comparison rather than running a second
// ~503-call price sweep of its own. That job must have run at least once
// for this page to show price-performance data — scheduled well after it
// (see netlify.toml) to make that likely on the same Saturday morning,
// but if it hasn't run yet this job still writes EPS-growth-only rows
// (relPrice3M: null) rather than failing outright, and the page shows a
// warning rather than erroring.
//
// Name/sector come from Sector Beeswarm's own weekly meta.json, same
// convention as every other full-universe job on this site — the
// EARNINGS endpoint itself returns no company metadata at all.
//
// ~503 sequential EARNINGS calls, 1050ms apart with a retry pass — same
// pacing proven at this scale by scheduled-beeswarm-meta-background.js.

const { getEarningsGrowthStore, LATEST_KEY } = require("./earnings-growth-divergence-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LEADERBOARD_COUNT = 15;

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

async function fetchEarnings(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=EARNINGS&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = await res.json();
  if (p.Note || p.Information || p.error) throw new Error(p.Note || p.Information || JSON.stringify(p.error));
  const q = Array.isArray(p.quarterlyEarnings) ? p.quarterlyEarnings : [];
  if (q.length < 5) return null; // not enough history for a YoY comparison

  const latest = q[0];
  const yearAgo = q[4];
  const latestEps = parseFloat(latest.reportedEPS);
  const yearAgoEps = parseFloat(yearAgo.reportedEPS);
  if (!Number.isFinite(latestEps) || !Number.isFinite(yearAgoEps) || yearAgoEps <= 0) {
    // A loss (or zero) a year ago makes a % growth figure not meaningful —
    // excluded rather than shown as a distorted (or infinite) percentage.
    return { fiscalDateEnding: latest.fiscalDateEnding, epsGrowthYoY: null };
  }
  return {
    fiscalDateEnding: latest.fiscalDateEnding,
    epsGrowthYoY: ((latestEps - yearAgoEps) / Math.abs(yearAgoEps)) * 100,
  };
}

exports.handler = async () => {
  console.log(`scheduled-earnings-growth-divergence-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
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
      console.error("scheduled-earnings-growth-divergence-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relativeStrengthBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const e = await fetchEarnings(apiKey, symbol);
        if (e) results.set(symbol, e);
        return true;
      } catch (err) {
        console.error(`scheduled-earnings-growth-divergence-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-earnings-growth-divergence-background: retry pass for ${todo.length} ticker(s)`);
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
    for (const [symbol, e] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const relPrice3M = Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, symbol)
        ? relativeStrengthBySymbol[symbol]
        : null;
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalDateEnding: e.fiscalDateEnding,
        epsGrowthYoY: round(e.epsGrowthYoY),
        relPrice3M,
      });
    }

    // Ranks (1 = best) computed independently for each metric, over
    // whichever companies have a valid value for it.
    const epsRanked = [...companies].filter((c) => c.epsGrowthYoY !== null).sort((a, b) => b.epsGrowthYoY - a.epsGrowthYoY);
    const epsRankOf = new Map(epsRanked.map((c, i) => [c.symbol, i + 1]));
    const priceRanked = [...companies].filter((c) => c.relPrice3M !== null).sort((a, b) => b.relPrice3M - a.relPrice3M);
    const priceRankOf = new Map(priceRanked.map((c, i) => [c.symbol, i + 1]));

    for (const c of companies) {
      c.epsRank = epsRankOf.get(c.symbol) ?? null;
      c.priceRank = priceRankOf.get(c.symbol) ?? null;
      // Positive divergenceScore: price ranks better than earnings growth
      // does (price ahead of fundamentals). Negative: earnings growth
      // outranks price (growth not yet rewarded). Only meaningful when
      // both ranks exist, over the same shared universe size.
      c.divergenceScore = (c.epsRank !== null && c.priceRank !== null)
        ? c.epsRank - c.priceRank
        : null;
    }

    const withBoth = companies.filter((c) => c.divergenceScore !== null);
    const priceAheadOfGrowth = [...withBoth].sort((a, b) => b.divergenceScore - a.divergenceScore).slice(0, LEADERBOARD_COUNT);
    const growthAheadOfPrice = [...withBoth].sort((a, b) => a.divergenceScore - b.divergenceScore).slice(0, LEADERBOARD_COUNT);

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianEpsGrowth: round(median(inSector.map((c) => c.epsGrowthYoY))),
          medianRelPrice3M: round(median(inSector.map((c) => c.relPrice3M))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      withEpsGrowth: epsRanked.length,
      withPriceData: priceRanked.length,
      medianEpsGrowth: round(median(companies.map((c) => c.epsGrowthYoY))),
      medianRelPrice3M: round(median(companies.map((c) => c.relPrice3M))),
    };

    const scatterPairs = withBoth.map((c) => ({ x: c.epsGrowthYoY, y: c.relPrice3M, symbol: c.symbol }));

    const store = getEarningsGrowthStore();
    const latest = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasPriceData,
      market,
      sectors,
      priceAheadOfGrowth,
      growthAheadOfPrice,
      scatterPairs,
      companies,
    };

    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-earnings-growth-divergence-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `${withBoth.length} with both metrics, hasPriceData=${hasPriceData}`
    );

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("scheduled-earnings-growth-divergence-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
