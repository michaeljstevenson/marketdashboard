// Scheduled Background Function (see [functions."scheduled-golden-cross-
// background"] in netlify.toml) for the /golden-cross.html page — a
// fresh, off-list idea (per ROUTINE_BRIEF.md's explicit permission to
// propose beyond the listed backlog). No existing page on this site
// covers trend-following moving-average structure: Relative Strength
// Leaders/Laggards ranks momentum against SPY, and RSI-style oscillators
// live in a separate (as of this run, still-open) PR — neither is the
// classic institutional "golden cross / death cross" convention of
// comparing a stock's own 50-day and 200-day moving averages to each
// other.
//
// COMPANY_OVERVIEW carries 50DayMovingAverage and 200DayMovingAverage
// directly — confirmed unused anywhere else on this site by grepping
// every existing function before starting this job. Trend Strength is
// (50DMA / 200DMA - 1) * 100: positive means a golden cross (50-day above
// 200-day, the classic bullish trend signal), negative means a death
// cross. This is a continuous version of the binary golden/death-cross
// label, since "how far above/below" matters as much as which side of
// zero a stock is on.
//
// Sector and company name come from each stock's own COMPANY_OVERVIEW
// response (normalizeSector, the same GICS-normalization helper Sector
// Beeswarm's own metadata job uses) rather than a join against that job's
// blob — this job already pays for the full OVERVIEW sweep, same
// convention as scheduled-analyst-price-target-background.js and
// scheduled-insider-ownership-background.js.
//
// Also reads Relative Strength Leaders/Laggards' own latest.json
// (getRelativeStrengthStore) for each stock's trailing 3-month return
// relative to SPY, for the page's one real test: does a stronger trend
// (bigger 50/200 gap) coincide with better relative price performance
// right now? Graceful fallback (hasRel3M: false, an on-page warning
// banner) if that blob isn't populated yet — same pattern as
// scheduled-insider-ownership-background.js.
//
// One-time snapshot — no recurring cron schedule, matching every new
// full-universe Equities job added since 2026-09-16. A moving-average
// crossover state doesn't change fast enough to need daily refresh even
// if this were scheduled; re-run manually (Netlify dashboard "Run now")
// for a fresh snapshot.
//
// ~503 sequential COMPANY_OVERVIEW calls, 1050ms apart with a retry pass
// — same pacing proven at this scale by
// scheduled-beeswarm-meta-background.js.

const { getGoldenCrossStore, LATEST_KEY } = require("./golden-cross-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LEADERBOARD_SIZE = 15;

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

  return {
    sector: normalizeSector(symbol, p.Sector),
    name: p.Name || symbol,
    dma50: num(p["50DayMovingAverage"]),
    dma200: num(p["200DayMovingAverage"]),
  };
}

exports.handler = async () => {
  console.log(`scheduled-golden-cross-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    let relBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-golden-cross-background: could not read relative-strength blob, continuing without it:", err.message);
    }
    const hasRel3M = Object.keys(relBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const entry = await fetchOverview(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-golden-cross-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-golden-cross-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-golden-cross-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);

    const companies = [];
    for (const [symbol, o] of results.entries()) {
      if (!o.sector || o.dma50 === null || o.dma200 === null || o.dma200 === 0) continue;
      const relPrice3M = Object.prototype.hasOwnProperty.call(relBySymbol, symbol) ? relBySymbol[symbol] : null;
      const trendStrength = round(((o.dma50 / o.dma200) - 1) * 100);
      companies.push({
        symbol,
        name: o.name,
        sector: o.sector,
        dma50: round(o.dma50),
        dma200: round(o.dma200),
        trendStrength,
        goldenCross: trendStrength > 0,
        relPrice3M: relPrice3M === null || relPrice3M === undefined ? null : round(relPrice3M),
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both moving averages and a sector");

    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      const goldenCount = inSector.filter((c) => c.goldenCross).length;
      return {
        sector,
        companyCount: inSector.length,
        medianTrendStrength: round(median(inSector.map((c) => c.trendStrength))),
        goldenCrossPct: round((goldenCount / inSector.length) * 100, 1),
      };
    }).filter(Boolean);

    const strongestGolden = [...companies].sort((a, b) => b.trendStrength - a.trendStrength).slice(0, LEADERBOARD_SIZE);
    const strongestDeath = [...companies].sort((a, b) => a.trendStrength - b.trendStrength).slice(0, LEADERBOARD_SIZE);

    const trendVsRel3MPairs = companies
      .filter((c) => c.trendStrength !== null && c.relPrice3M !== null)
      .map((c) => ({ x: c.trendStrength, y: c.relPrice3M, symbol: c.symbol }));

    const goldenCount = companies.filter((c) => c.goldenCross).length;
    const market = {
      companyCount: companies.length,
      goldenCrossCount: goldenCount,
      deathCrossCount: companies.length - goldenCount,
      goldenCrossPct: round((goldenCount / companies.length) * 100, 1),
      medianTrendStrength: round(median(companies.map((c) => c.trendStrength))),
    };

    const generatedAt = new Date().toISOString();

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasRel3M,
      market,
      sectors,
      strongestGolden,
      strongestDeath,
      trendVsRel3MPairs,
      companies,
    };

    const store = getGoldenCrossStore();
    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-golden-cross-background: done, ${companies.length} companies across ${sectors.length} sectors, ` +
      `${goldenCount} golden / ${companies.length - goldenCount} death, hasRel3M=${hasRel3M}`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-golden-cross-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
