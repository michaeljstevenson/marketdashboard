// Scheduled Background Function (see [functions."scheduled-insider-
// ownership-background"] in netlify.toml) for the /insider-ownership.html
// page — a fresh, off-list idea (per ROUTINE_BRIEF.md's explicit
// permission to propose beyond the listed backlog). A different lens from
// this site's other ownership pages: Insider Buying/Selling tracks Form 4
// *transactions* (the flow of insiders buying or selling shares over the
// last 90 days) and Institutional Ownership & 13F Flow tracks
// *institutional* holdings and their quarter-to-quarter flow. Neither
// answers a simpler, more static question: how much of the company do
// its own officers, directors, and 10%+ owners collectively *own*, right
// now, as a stake? That's PercentInsiders on COMPANY_OVERVIEW, and no
// existing job on this site reads it.
//
// Also pulls PercentInstitutions from the same response — not to
// duplicate Institutional Ownership & 13F Flow's own, more granular
// INSTITUTIONAL_HOLDINGS-based sweep, but as the second half of a single
// real question this page asks: across the S&P 500, does a bigger insider
// stake come with a smaller institutional stake, or are the two
// independent? A simple two-field scatter neither existing page can
// answer, since neither reads both fields from the same endpoint.
//
// Sector and company name come from each stock's own COMPANY_OVERVIEW
// response (normalizeSector, the same GICS-normalization helper Sector
// Beeswarm's own metadata job uses) rather than a join against that job's
// blob — this job already pays for the full OVERVIEW sweep, same
// convention as scheduled-analyst-price-target-background.js and
// scheduled-equity-risk-premium-background.js.
//
// Also reads Relative Strength Leaders/Laggards' own latest.json
// (getRelativeStrengthStore) for each stock's trailing 3-month return
// relative to SPY, for the page's second test: does a bigger insider
// stake (the "skin in the game" alignment-of-interest hypothesis) show up
// in better or worse relative price performance right now? Graceful
// fallback (hasRel3M: false, an on-page warning banner) if that blob
// isn't populated yet — same pattern as
// scheduled-earnings-growth-divergence-background.js and
// scheduled-rd-intensity-background.js.
//
// One-time snapshot — no recurring cron schedule, matching every new
// full-universe Equities job added since 2026-09-16. Insider ownership
// stakes move slowly (they change with proxy filings and 13D/G amendments,
// not daily trading), so a frequent re-pull wouldn't add much even if this
// job were scheduled. Re-run manually (Netlify dashboard "Run now") for a
// fresh snapshot.
//
// Reads company overviews from the shared av-collected store (see av-collector-store.js), so it makes no Alpha Vantage calls of its own.

const { getInsiderOwnershipStore, LATEST_KEY } = require("./insider-ownership-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { collectedFor } = require("./av-collector-store");


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
  const p = (await collectedFor("overview", symbol)) || {};
  if (!p.Symbol) return null; // empty {} for an unrecognized/delisted symbol

  return {
    sector: normalizeSector(symbol, p.Sector),
    name: p.Name || symbol,
    // Alpha Vantage returns these as a plain percentage number (e.g. "1.648"
    // means 1.648%), not a 0-1 fraction — used as-is, no *100.
    insiderPct: num(p.PercentInsiders),
    institutionalPct: num(p.PercentInstitutions),
  };
}

exports.handler = async () => {
  console.log(`scheduled-insider-ownership-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
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
      console.error("scheduled-insider-ownership-background: could not read relative-strength blob, continuing without it:", err.message);
    }
    const hasRel3M = Object.keys(relBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const entry = await fetchOverview(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-insider-ownership-background: ${symbol} failed: ${err.message}`);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-insider-ownership-background: retry pass for ${todo.length} ticker(s)`);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
      }
      todo = missed;
    }

    console.log(`scheduled-insider-ownership-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);

    const companies = [];
    for (const [symbol, o] of results.entries()) {
      if (!o.sector || o.insiderPct === null) continue;
      const relPrice3M = Object.prototype.hasOwnProperty.call(relBySymbol, symbol) ? relBySymbol[symbol] : null;
      companies.push({
        symbol,
        name: o.name,
        sector: o.sector,
        insiderPct: round(o.insiderPct),
        institutionalPct: round(o.institutionalPct),
        relPrice3M: relPrice3M === null || relPrice3M === undefined ? null : round(relPrice3M),
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both an insider ownership figure and a sector");

    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      return {
        sector,
        companyCount: inSector.length,
        medianInsiderPct: round(median(inSector.map((c) => c.insiderPct))),
        medianInstitutionalPct: round(median(inSector.map((c) => c.institutionalPct))),
      };
    }).filter(Boolean);

    const highestInsider = [...companies].sort((a, b) => b.insiderPct - a.insiderPct).slice(0, LEADERBOARD_SIZE);
    const lowestInsider = [...companies]
      .filter((c) => c.insiderPct !== null)
      .sort((a, b) => a.insiderPct - b.insiderPct)
      .slice(0, LEADERBOARD_SIZE);

    const insiderVsInstitutionalPairs = companies
      .filter((c) => c.insiderPct !== null && c.institutionalPct !== null)
      .map((c) => ({ x: c.insiderPct, y: c.institutionalPct, symbol: c.symbol }));

    const insiderVsRel3MPairs = companies
      .filter((c) => c.insiderPct !== null && c.relPrice3M !== null)
      .map((c) => ({ x: c.insiderPct, y: c.relPrice3M, symbol: c.symbol }));

    const market = {
      companyCount: companies.length,
      medianInsiderPct: round(median(companies.map((c) => c.insiderPct))),
      medianInstitutionalPct: round(median(companies.map((c) => c.institutionalPct))),
    };

    const generatedAt = new Date().toISOString();

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasRel3M,
      market,
      sectors,
      highestInsider,
      lowestInsider,
      insiderVsInstitutionalPairs,
      insiderVsRel3MPairs,
      companies,
    };

    const store = getInsiderOwnershipStore();
    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-insider-ownership-background: done, ${companies.length} companies across ${sectors.length} sectors, hasRel3M=${hasRel3M}`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-insider-ownership-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
