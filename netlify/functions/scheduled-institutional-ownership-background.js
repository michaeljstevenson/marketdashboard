// Scheduled Background Function (see [functions."scheduled-institutional-
// ownership-background"] in netlify.toml) for the /institutional-
// ownership.html page — a fresh, off-list idea (per ROUTINE_BRIEF.md's
// explicit permission to propose beyond the listed backlog): no existing
// page on this site covers institutional (13F) ownership or flow.
//
// Sweeps Alpha Vantage's INSTITUTIONAL_HOLDINGS endpoint across the full
// S&P 500 (~503 calls). That endpoint also returns a per-holder `holdings`
// array (thousands of rows for a mega-cap like AAPL — confirmed directly
// against that symbol, ~6,489 individual holder rows) which this job
// deliberately never touches: only the top-level AGGREGATE fields are
// extracted (total_institutional_holders/shares, holders/shares with
// increased/decreased/unchanged holdings, and the ownership percentage) —
// pulling the full per-holder detail into the blob store would bloat it
// enormously for no benefit to this page's sector/market-level analysis.
//
// Two derived per-company metrics:
//   - holderBreadthPct: % of holders who *changed* position (excludes the
//     unchanged bucket) that were adding — a headcount signal.
//   - netShareFlowPct: (shares increased - shares decreased) / total
//     institutional shares, as a % — a magnitude/dollar-weighted signal.
// Both matter and both are surfaced on the page rather than collapsing to
// one number.
//
// Reuses Sector Beeswarm's own weekly meta.json for company name/sector —
// same convention as every other full-universe job on this site — rather
// than paying for a second metadata sweep.
//
// Also reads Relative Strength Leaders/Laggards' own latest.json
// (getRelativeStrengthStore) for each stock's trailing 3-month return
// relative to SPY, for a real cross-sectional test: do institutions pile
// into recent winners (momentum-chasing) or recent laggards (contrarian)?
// This is a real, deliberate dependency (same pattern already used by
// scheduled-earnings-growth-divergence-background.js), not a new price
// sweep — with a graceful EPS-growth-style fallback (hasPriceData: false,
// an on-page warning banner) if that blob isn't populated yet. Only a
// *contemporaneous* single-snapshot test is run — 13F data moves too
// slowly week to week for a forward-looking persistence test to be
// meaningful yet, matching the precedent set by Margin & Leverage's and
// Equity Risk Premium's own single-snapshot cross-sectional tests.
//
// Since INSTITUTIONAL_HOLDINGS is a current-state snapshot (not a time
// series), the market-wide weekly medians are appended to a running
// history each run — same "accumulates real history over successive
// runs" pattern used by scheduled-revisions-background.js,
// scheduled-dispersion-background.js and scheduled-pe-divergence-
// background.js.
//
// Weekly, real recurring schedule (see netlify.toml) — unlike the 14
// background functions frozen to one-time snapshots by commit 704645f
// ("the research as it stood on this date"), this job is meant to build
// an actual multi-week flow trend, so it keeps firing on its own.

const { getInstitutionalOwnershipStore, BLOB_KEY } = require("./institutional-ownership-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3; // don't publish a sector median built off fewer than this many companies
const MIN_HOLDER_COVERAGE = 5; // leaderboard-quality filter, same convention as Analyst Estimate Dispersion's "min. 5 covering analysts"
const MAX_HISTORY_WEEKS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on several fundamentals-adjacent endpoints — same gotcha
// guarded against elsewhere in this codebase (e.g. scheduled-margin-
// leverage-background.js's num()).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// "77%" -> 77. Guards against a stray already-fractional value ("0.77")
// slipping through by treating anything <= 1 without a "%" sign as
// fractional — Alpha Vantage's own docs describe this field as a
// percentage string, but this is cheap insurance against a format change.
function parsePercent(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const str = String(v).trim();
  const hasPercentSign = str.includes("%");
  const n = parseFloat(str.replace("%", ""));
  if (!Number.isFinite(n)) return null;
  if (!hasPercentSign && Math.abs(n) <= 1) return n * 100;
  return n;
}

async function fetchInstitutionalHoldings(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=INSTITUTIONAL_HOLDINGS&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  // Deliberately destructure only the top-level aggregate fields — the
  // payload's `holdings` array (per-holder detail) is never read or
  // stored, see the header comment above for why.
  const totalHolders = num(payload.total_institutional_holders);
  const totalShares = num(payload.total_institutional_shares);
  const holdersInc = num(payload.holders_with_increased_holdings);
  const sharesInc = num(payload.shares_with_increased_holdings);
  const holdersDec = num(payload.holders_with_decreased_holdings);
  const sharesDec = num(payload.shares_with_decreased_holdings);
  const holdersUnch = num(payload.holders_with_unchanged_holdings);
  const sharesUnch = num(payload.shares_with_unchanged_holdings);
  const ownershipPct = parsePercent(payload.total_institutional_ownership_percentage);

  if (totalHolders === null && totalShares === null) return null; // nothing usable came back for this symbol

  return {
    totalHolders, totalShares,
    holdersInc, sharesInc,
    holdersDec, sharesDec,
    holdersUnch, sharesUnch,
    ownershipPct,
  };
}

exports.handler = async () => {
  console.log(`scheduled-institutional-ownership-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let relBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-institutional-ownership-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relBySymbol).length > 0;

    const results = new Map();
    async function fetchInto(symbol) {
      try {
        const entry = await fetchInstitutionalHoldings(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-institutional-ownership-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-institutional-ownership-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-institutional-ownership-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, e] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      const holderBreadthPct = (e.holdersInc !== null && e.holdersDec !== null && (e.holdersInc + e.holdersDec) > 0)
        ? round((e.holdersInc / (e.holdersInc + e.holdersDec)) * 100)
        : null;
      const netShareFlowPct = (e.sharesInc !== null && e.sharesDec !== null && e.totalShares !== null && e.totalShares > 0)
        ? round(((e.sharesInc - e.sharesDec) / e.totalShares) * 100)
        : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        ownershipPct: e.ownershipPct !== null ? round(e.ownershipPct) : null,
        totalHolders: e.totalHolders,
        holdersIncreased: e.holdersInc,
        holdersDecreased: e.holdersDec,
        holdersUnchanged: e.holdersUnch,
        netShareFlowPct,
        holderBreadthPct,
        relPrice3M: Object.prototype.hasOwnProperty.call(relBySymbol, symbol) ? relBySymbol[symbol] : null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with sector metadata");

    // ---- Sector-level snapshot medians ----
    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        const ownership = inSector.map((c) => c.ownershipPct).filter((x) => x !== null);
        const flow = inSector.map((c) => c.netShareFlowPct).filter((x) => x !== null);
        if (ownership.length < MIN_SECTOR_N && flow.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianOwnershipPct: ownership.length >= MIN_SECTOR_N ? round(median(ownership)) : null,
          medianNetShareFlowPct: flow.length >= MIN_SECTOR_N ? round(median(flow)) : null,
        };
      })
      .filter(Boolean);

    // ---- Market-level snapshot stats ----
    const ownershipVals = companies.map((c) => c.ownershipPct).filter((x) => x !== null);
    const flowVals = companies.map((c) => c.netShareFlowPct).filter((x) => x !== null);
    const breadthVals = companies.map((c) => c.holderBreadthPct).filter((x) => x !== null);

    const market = {
      companyCount: companies.length,
      medianOwnershipPct: round(median(ownershipVals)),
      medianNetShareFlowPct: round(median(flowVals)),
      medianHolderBreadthPct: round(median(breadthVals)),
    };

    // ---- Accumulating weekly history (market medians only) ----
    const store = getInstitutionalOwnershipStore();
    const previous = (await store.get(BLOB_KEY, { type: "json" })) || { history: [] };
    const history = Array.isArray(previous.history) ? previous.history : [];
    const weekKey = new Date().toISOString().slice(0, 10);
    const historyEntry = { week: weekKey, medianOwnershipPct: market.medianOwnershipPct, medianNetShareFlowPct: market.medianNetShareFlowPct };
    if (!history.length || history[history.length - 1].week !== weekKey) {
      history.push(historyEntry);
    } else {
      history[history.length - 1] = historyEntry;
    }
    while (history.length > MAX_HISTORY_WEEKS) history.shift();

    // ---- Leaderboards ----
    const withCoverage = companies.filter((c) => c.totalHolders !== null && c.totalHolders >= MIN_HOLDER_COVERAGE);
    const accumulation = [...withCoverage].filter((c) => c.netShareFlowPct !== null)
      .sort((a, b) => b.netShareFlowPct - a.netShareFlowPct).slice(0, NOTABLE_COUNT);
    const distribution = [...withCoverage].filter((c) => c.netShareFlowPct !== null)
      .sort((a, b) => a.netShareFlowPct - b.netShareFlowPct).slice(0, NOTABLE_COUNT);
    const highestOwnership = [...withCoverage].filter((c) => c.ownershipPct !== null)
      .sort((a, b) => b.ownershipPct - a.ownershipPct).slice(0, NOTABLE_COUNT);
    const lowestOwnership = [...withCoverage].filter((c) => c.ownershipPct !== null)
      .sort((a, b) => a.ownershipPct - b.ownershipPct).slice(0, NOTABLE_COUNT);

    // ---- Contemporaneous flow-vs-momentum scatter pairs ----
    const scatterPairs = companies
      .filter((c) => c.netShareFlowPct !== null && c.relPrice3M !== null)
      .map((c) => ({ x: c.relPrice3M, y: c.netShareFlowPct, symbol: c.symbol }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      companyCount: companies.length,
      hasPriceData,
      market,
      sectors,
      history,
      scatterPairs,
      leaders: { accumulation, distribution, highestOwnership, lowestOwnership },
      companies,
    };

    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-institutional-ownership-background: wrote ${companies.length} companies across ${sectors.length} sectors, ${history.length}-week history, hasPriceData=${hasPriceData}`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-institutional-ownership-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
