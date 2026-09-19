// Scheduled Background Function (see
// [functions."scheduled-analyst-price-target-background"] in
// netlify.toml) that sweeps Alpha Vantage's COMPANY_OVERVIEW across the
// full S&P 500 for sell-side analyst price targets and buy/hold/sell
// consensus — the "Analyst Price Target Upside" page. A different lens
// from this site's other analyst-facing pages: Earnings Revisions and
// Analyst Estimate Dispersion are both about EPS *estimates* (and how
// much they're moving or how much analysts disagree on them); this page
// is about the *price target* itself and the buy/sell recommendation
// distribution, a separate field Wall Street research reports on
// independently of the EPS numbers behind it.
//
// COMPANY_OVERVIEW carries AnalystTargetPrice and the five-bucket rating
// counts (AnalystRatingStrongBuy/Buy/Hold/Sell/StrongSell) directly, no
// second endpoint needed. It does NOT carry a current trading price, so
// this job reads that from relative-strength's own latest.json
// (getRelativeStrengthStore, `price` field — that job's own last daily
// close) rather than paying for a second full-universe price sweep; if
// that blob isn't populated yet this still writes rating-only rows
// (price/upsidePct: null) rather than failing, same graceful-fallback
// pattern as scheduled-earnings-growth-divergence-background.js and
// scheduled-institutional-ownership-background.js. The same blob also
// supplies rel3M (trailing 3-month relative return) for this page's one
// real statistical test.
//
// Sector and company name come from each stock's own COMPANY_OVERVIEW
// response (normalizeSector, the same GICS-normalization helper Sector
// Beeswarm's own metadata job uses) rather than a join against that
// job's blob — this job already pays for the full OVERVIEW sweep, same
// convention as scheduled-equity-risk-premium-background.js and
// scheduled-pe-divergence-background.js.
//
// One-time snapshot as of 2026-09-16 — no recurring cron schedule (see
// netlify.toml and this repo's "Stop auto-refresh on tonight's new
// Equities pages" commit): new full-universe Equities background jobs on
// this site are meant to read as "the research as it stood on this
// date," not a continuously-refreshed feed. Re-run manually (Netlify
// dashboard "Run now") for a fresh snapshot.
//
// ~503 sequential COMPANY_OVERVIEW calls, 1050ms apart with a retry pass
// — same pacing proven at this scale by
// scheduled-beeswarm-meta-background.js.

const { getPriceTargetStore, LATEST_KEY, HISTORY_KEY } = require("./analyst-price-target-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_HISTORY_POINTS = 260; // ~5 years, if this is ever run weekly again
const MIN_ANALYSTS_FOR_LEADERBOARD = 3; // thin coverage makes upside/consensus noisy

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
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
    `${ALPHA_VANTAGE_URL}?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = await res.json();
  if (p.Note || p.Information || p.error) throw new Error(p.Note || p.Information || JSON.stringify(p.error));
  if (!p.Symbol) return null; // empty {} for an unrecognized/delisted symbol

  const targetPrice = num(p.AnalystTargetPrice);
  const strongBuy = num(p.AnalystRatingStrongBuy) || 0;
  const buy = num(p.AnalystRatingBuy) || 0;
  const hold = num(p.AnalystRatingHold) || 0;
  const sell = num(p.AnalystRatingSell) || 0;
  const strongSell = num(p.AnalystRatingStrongSell) || 0;
  const analystTotal = strongBuy + buy + hold + sell + strongSell;

  return {
    sector: normalizeSector(symbol, p.Sector),
    name: p.Name || symbol,
    targetPrice,
    analystTotal,
    buyRatio: analystTotal > 0 ? ((strongBuy + buy) / analystTotal) * 100 : null,
    consensusScore: analystTotal > 0
      ? (strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell * 1) / analystTotal
      : null,
  };
}

exports.handler = async () => {
  console.log(`scheduled-analyst-price-target-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    let priceBySymbol = {};
    let relPriceBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) {
          priceBySymbol[c.symbol] = c.price;
          relPriceBySymbol[c.symbol] = c.rel3M;
        }
      }
    } catch (err) {
      console.error("scheduled-analyst-price-target-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(priceBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const entry = await fetchOverview(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-analyst-price-target-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-analyst-price-target-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-analyst-price-target-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);

    const companies = [];
    for (const [symbol, o] of results.entries()) {
      if (!o.sector || o.targetPrice === null) continue;
      const price = Object.prototype.hasOwnProperty.call(priceBySymbol, symbol) ? priceBySymbol[symbol] : null;
      const relPrice3M = Object.prototype.hasOwnProperty.call(relPriceBySymbol, symbol) ? relPriceBySymbol[symbol] : null;
      const upsidePct = price ? round(((o.targetPrice - price) / price) * 100) : null;
      companies.push({
        symbol,
        name: o.name,
        sector: o.sector,
        targetPrice: round(o.targetPrice),
        price: round(price),
        upsidePct,
        analystTotal: o.analystTotal,
        buyRatio: round(o.buyRatio, 1),
        consensusScore: round(o.consensusScore),
        relPrice3M,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both a target price and sector");

    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      return {
        sector,
        companyCount: inSector.length,
        medianUpsidePct: round(median(inSector.map((c) => c.upsidePct))),
        medianBuyRatio: round(median(inSector.map((c) => c.buyRatio)), 1),
        medianConsensusScore: round(median(inSector.map((c) => c.consensusScore))),
      };
    }).filter(Boolean);

    const eligible = companies.filter((c) => c.analystTotal >= MIN_ANALYSTS_FOR_LEADERBOARD && c.upsidePct !== null);
    const highestUpside = [...eligible].sort((a, b) => b.upsidePct - a.upsidePct).slice(0, 15);
    const lowestUpside = [...eligible].sort((a, b) => a.upsidePct - b.upsidePct).slice(0, 15);
    const eligibleConsensus = companies.filter((c) => c.analystTotal >= MIN_ANALYSTS_FOR_LEADERBOARD && c.buyRatio !== null);
    const mostBullish = [...eligibleConsensus].sort((a, b) => b.buyRatio - a.buyRatio).slice(0, 15);
    const mostBearish = [...eligibleConsensus].sort((a, b) => a.buyRatio - b.buyRatio).slice(0, 15);

    const withBoth = companies.filter((c) => c.upsidePct !== null && c.relPrice3M !== null);
    const scatterPairs = withBoth.map((c) => ({ x: c.upsidePct, y: c.relPrice3M, symbol: c.symbol }));

    const market = {
      companyCount: companies.length,
      withPriceData: withBoth.length,
      medianUpsidePct: round(median(companies.map((c) => c.upsidePct))),
      medianBuyRatio: round(median(companies.map((c) => c.buyRatio)), 1),
      medianConsensusScore: round(median(companies.map((c) => c.consensusScore))),
      totalAnalystsCovering: companies.reduce((s, c) => s + (c.analystTotal || 0), 0),
    };

    const generatedAt = new Date().toISOString();

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasPriceData,
      market,
      sectors,
      highestUpside,
      lowestUpside,
      mostBullish,
      mostBearish,
      scatterPairs,
      companies,
    };

    const store = getPriceTargetStore();
    await store.setJSON(LATEST_KEY, latest);

    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];
    const todayDate = generatedAt.slice(0, 10);
    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push({
      date: todayDate,
      medianUpsidePct: market.medianUpsidePct,
      medianBuyRatio: market.medianBuyRatio,
    });
    const trimmed = filtered.slice(-MAX_HISTORY_POINTS);
    await store.setJSON(HISTORY_KEY, { points: trimmed });

    console.log(
      `scheduled-analyst-price-target-background: done, ${companies.length} companies across ${sectors.length} sectors, ` +
      `${withBoth.length} with price data, hasPriceData=${hasPriceData}`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-analyst-price-target-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
