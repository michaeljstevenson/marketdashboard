// Scheduled Background Function (see [functions."scheduled-institutional-
// ownership-background"] in netlify.toml) that sweeps Alpha Vantage's
// INSTITUTIONAL_HOLDINGS endpoint across the full S&P 500
// (BREADTH_CONSTITUENTS) for 13F-style institutional ownership and
// buying/selling pressure — the "Institutional Ownership & Flow Tracker"
// page.
//
// INSTITUTIONAL_HOLDINGS returns a per-holder `holdings` array that can run
// into the thousands of entries (and 1MB+ of JSON) for a widely-held
// mega-cap — this page only needs the TOP-LEVEL AGGREGATE fields
// (total_institutional_holders, total_institutional_shares,
// holders/shares_with_{increased,decreased,unchanged}_holdings,
// total_institutional_ownership_percentage), which are parsed out of each
// response and the `holdings` array is discarded immediately rather than
// retained in the blob — storing it across ~503 companies would bloat
// Netlify Blobs storage enormously for no analytical benefit this page
// needs.
//
// Per-company derived metrics:
//   - institutionalOwnershipPct: total_institutional_ownership_percentage,
//     parsed (strip "%", parseFloat).
//   - netFlowPct: (shares_with_increased_holdings -
//     shares_with_decreased_holdings) / total_institutional_shares, as a %
//     — the page's core "accumulation vs. distribution" signal: positive
//     means more institutional buying pressure than selling pressure this
//     reporting period, negative the reverse.
//   - netHolderChange: holders_with_increased_holdings -
//     holders_with_decreased_holdings — a simpler, holder-count-based
//     companion signal that can diverge from the share-weighted one above
//     (e.g. many small holders trimming vs. one large holder adding).
// A company is excluded entirely (not fabricated) if
// total_institutional_shares is 0/missing/unparseable (can't compute the
// flow % denominator) or if the top-level aggregate fields are literally
// absent from the response.
//
// INSTITUTIONAL_HOLDINGS is a current-state snapshot with no history
// endpoint (same category as OVERVIEW, behind /pe-divergence.html, or
// EARNINGS_ESTIMATES, behind /analyst-estimate-dispersion.html) — so the
// market-wide weekly median ownership % and median net flow % are appended
// to a running history each run, exact same accumulating-history pattern
// as scheduled-pe-divergence-background.js.
//
// Real cross-page dependency, not a coincidence: like scheduled-buyback-
// tracker-background.js and scheduled-earnings-growth-divergence-
// background.js, this job reads scheduled-relative-strength-background's
// own latest.json (getRelativeStrengthStore) for the "smart money" test —
// does net institutional flow % predict subsequent 3-month relative price
// performance — instead of running a second ~503-call price sweep. If that
// blob isn't populated yet, this job still writes ownership/flow rows
// (relPrice3M: null on every company) instead of failing outright, and the
// page shows a warning rather than erroring — same fallback pattern.
//
// Name/sector come from Sector Beeswarm's own weekly meta.json, same
// convention as every other full-universe job on this site.
//
// ~503 sequential INSTITUTIONAL_HOLDINGS calls, 1050ms apart with a retry
// pass — same pacing proven at this scale by scheduled-buyback-tracker-
// background.js / scheduled-beeswarm-meta-background.js.

const { getInstitutionalOwnershipStore, BLOB_KEY } = require("./institutional-ownership-blob-store");
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
// A reasonable floor to keep the ownership/flow leaderboards from being
// dominated by thinly-covered names — a stock with only a handful of
// reporting institutional holders can show a wildly noisy net-flow % or
// ownership % off one or two 13F filers moving, which isn't a meaningful
// "biggest accumulation/distribution in the S&P 500" signal. Every S&P 500
// constituent is a multi-billion-dollar company, so real 13F coverage
// should comfortably clear this in the overwhelming majority of cases;
// names that don't are excluded from the leaderboards only, not from the
// full table.
const MIN_HOLDERS_FOR_LEADERBOARD = 50;

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

function parsePct(raw) {
  if (raw === null || raw === undefined) return null;
  const v = parseFloat(String(raw).replace("%", "").trim());
  return Number.isFinite(v) ? v : null;
}
function parseNum(raw) {
  if (raw === null || raw === undefined) return null;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : null;
}
function parseInt10(raw) {
  if (raw === null || raw === undefined) return null;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : null;
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

  // Top-level aggregate fields literally absent — not a usable response for
  // this symbol at all (e.g. no 13F coverage / unrecognized symbol).
  if (payload.total_institutional_holders === undefined || payload.total_institutional_holders === null) {
    return null;
  }

  const totalHolders = parseInt10(payload.total_institutional_holders);
  const totalShares = parseNum(payload.total_institutional_shares);
  const holdersIncreased = parseInt10(payload.holders_with_increased_holdings);
  const sharesIncreased = parseNum(payload.shares_with_increased_holdings);
  const holdersDecreased = parseInt10(payload.holders_with_decreased_holdings);
  const sharesDecreased = parseNum(payload.shares_with_decreased_holdings);
  const holdersUnchanged = parseInt10(payload.holders_with_unchanged_holdings);
  const ownershipPct = parsePct(payload.total_institutional_ownership_percentage);

  // Deliberately NOT retaining payload.holdings here — discarded as soon as
  // the aggregate fields above are pulled out of it, per this file's header
  // comment.

  return {
    totalHolders,
    totalShares,
    holdersIncreased,
    sharesIncreased,
    holdersDecreased,
    sharesDecreased,
    holdersUnchanged,
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

    let relativeStrengthBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relativeStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-institutional-ownership-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relativeStrengthBySymbol).length > 0;

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

      // Exclusion: total_institutional_shares 0/missing/unparseable — can't
      // compute the flow % denominator, and this metric is the page's core
      // signal, so the company is skipped entirely rather than shown with a
      // fabricated or half-missing row.
      if (e.totalShares === null || e.totalShares <= 0) continue;

      const netFlowPct = (e.sharesIncreased !== null && e.sharesDecreased !== null)
        ? round(((e.sharesIncreased - e.sharesDecreased) / e.totalShares) * 100)
        : null;
      const netHolderChange = (e.holdersIncreased !== null && e.holdersDecreased !== null)
        ? (e.holdersIncreased - e.holdersDecreased)
        : null;

      const relPrice3M = Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, symbol)
        ? relativeStrengthBySymbol[symbol]
        : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        totalHolders: e.totalHolders,
        ownershipPct: e.ownershipPct !== null ? round(e.ownershipPct) : null,
        netFlowPct,
        netHolderChange,
        holdersIncreased: e.holdersIncreased,
        holdersDecreased: e.holdersDecreased,
        holdersUnchanged: e.holdersUnchanged,
        relPrice3M,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both institutional-holdings data and sector metadata");

    const withOwnership = companies.filter((c) => c.ownershipPct !== null);
    const withFlow = companies.filter((c) => c.netFlowPct !== null);
    const eligibleForLeaderboard = companies.filter((c) => c.totalHolders !== null && c.totalHolders >= MIN_HOLDERS_FOR_LEADERBOARD);

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        const sectorOwnership = inSector.filter((c) => c.ownershipPct !== null);
        const sectorFlow = inSector.filter((c) => c.netFlowPct !== null);
        return {
          sector,
          companyCount: inSector.length,
          avgOwnershipPct: round(mean(sectorOwnership.map((c) => c.ownershipPct))),
          medianOwnershipPct: round(median(sectorOwnership.map((c) => c.ownershipPct))),
          avgNetFlowPct: round(mean(sectorFlow.map((c) => c.netFlowPct))),
          medianNetFlowPct: round(median(sectorFlow.map((c) => c.netFlowPct))),
        };
      })
      .filter(Boolean);

    // Net institutional flow % distribution — fixed bins centered on zero;
    // this ratio is share-count-weighted across the whole float, so even a
    // fairly active reporting period usually produces single-digit-to-low-
    // teens percentages, not the wide spread a per-holder metric would.
    const FLOW_BIN_EDGES = [-Infinity, -8, -6, -4, -2, 0, 2, 4, 6, 8, Infinity];
    const flowBins = [];
    for (let i = 0; i < FLOW_BIN_EDGES.length - 1; i++) {
      const lo = FLOW_BIN_EDGES[i], hi = FLOW_BIN_EDGES[i + 1];
      const label = lo === -Infinity ? `< ${hi}%` : hi === Infinity ? `${lo}%+` : `${lo} to ${hi}%`;
      flowBins.push({ label, lo, hi, count: 0 });
    }
    for (const c of withFlow) {
      const bin = flowBins.find((b) => c.netFlowPct >= b.lo && c.netFlowPct < b.hi) || flowBins[flowBins.length - 1];
      bin.count += 1;
    }

    const market = {
      companyCount: companies.length,
      withOwnership: withOwnership.length,
      withFlow: withFlow.length,
      withPriceData: companies.filter((c) => c.relPrice3M !== null).length,
      medianOwnershipPct: round(median(withOwnership.map((c) => c.ownershipPct))),
      meanOwnershipPct: round(mean(withOwnership.map((c) => c.ownershipPct))),
      medianNetFlowPct: round(median(withFlow.map((c) => c.netFlowPct))),
      meanNetFlowPct: round(mean(withFlow.map((c) => c.netFlowPct))),
    };

    const highestOwnership = [...eligibleForLeaderboard]
      .filter((c) => c.ownershipPct !== null)
      .sort((a, b) => b.ownershipPct - a.ownershipPct)
      .slice(0, LEADERBOARD_COUNT);
    const lowestOwnership = [...eligibleForLeaderboard]
      .filter((c) => c.ownershipPct !== null)
      .sort((a, b) => a.ownershipPct - b.ownershipPct)
      .slice(0, LEADERBOARD_COUNT);
    const biggestAccumulation = [...eligibleForLeaderboard]
      .filter((c) => c.netFlowPct !== null)
      .sort((a, b) => b.netFlowPct - a.netFlowPct)
      .slice(0, LEADERBOARD_COUNT);
    const biggestDistribution = [...eligibleForLeaderboard]
      .filter((c) => c.netFlowPct !== null)
      .sort((a, b) => a.netFlowPct - b.netFlowPct)
      .slice(0, LEADERBOARD_COUNT);

    const scatterPairs = withFlow
      .filter((c) => c.relPrice3M !== null)
      .map((c) => ({ x: c.netFlowPct, y: c.relPrice3M, symbol: c.symbol }));

    const store = getInstitutionalOwnershipStore();
    const previous = (await store.get(BLOB_KEY, { type: "json" })) || { history: [] };
    const history = Array.isArray(previous.history) ? previous.history : [];
    const weekKey = new Date().toISOString().slice(0, 10);
    const historyPoint = { week: weekKey, medianOwnershipPct: market.medianOwnershipPct, medianNetFlowPct: market.medianNetFlowPct };
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
      minHoldersForLeaderboard: MIN_HOLDERS_FOR_LEADERBOARD,
      market,
      sectors,
      flowDistribution: flowBins.map((b) => ({ label: b.label, count: b.count })),
      history,
      highestOwnership,
      lowestOwnership,
      biggestAccumulation,
      biggestDistribution,
      scatterPairs,
      companies,
    };

    await store.setJSON(BLOB_KEY, payload);

    console.log(
      `scheduled-institutional-ownership-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `${companies.length} with sector metadata, ${withOwnership.length} with ownership%, ${withFlow.length} with flow%, ` +
      `${history.length}-week history, hasPriceData=${hasPriceData}`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error("scheduled-institutional-ownership-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
