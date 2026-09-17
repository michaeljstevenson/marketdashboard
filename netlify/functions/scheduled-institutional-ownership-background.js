// Scheduled Background Function (see [functions."scheduled-institutional-
// ownership-background"] in netlify.toml) for the /institutional-
// ownership.html page.
//
// Sweeps Alpha Vantage's INSTITUTIONAL_HOLDINGS endpoint across the full
// S&P 500 (~503 calls) and keeps ONLY the top-level SUMMARY fields each
// response carries:
//   total_institutional_holders, total_institutional_shares,
//   total_institutional_ownership_percentage,
//   holders_with_increased_holdings, shares_with_increased_holdings,
//   holders_with_decreased_holdings, shares_with_decreased_holdings,
//   holders_with_unchanged_holdings, shares_with_unchanged_holdings
// The response also carries a `holdings` array — the actual per-institution
// holder list (Vanguard/BlackRock/etc., with shares_held/shares_changed/
// change_type/last_reported) — which for a mega-cap can run into the
// thousands of entries. That array is deliberately never read, stored, or
// processed here: this page is about aggregate institutional positioning
// across the S&P 500, not individual-holder tracking, and parsing/storing
// thousands of holder rows per company across a ~503-company sweep would
// bloat both the response handling and the blob for no benefit to what
// this page shows.
//
// Core construct computed here — "net accumulation breadth", a per-company
// score:
//   netAccumulationBreadth = (holders_with_increased_holdings -
//     holders_with_decreased_holdings) / total_institutional_holders * 100
// A breadth measure, same structural idea as Earnings Revisions' "Net
// Revision Ratio" — positive means more institutions added than trimmed
// this reporting period, negative means more trimmed than added. Kept
// deliberately distinct from total_institutional_ownership_percentage (a
// level, not a flow): a stock can carry very high institutional ownership
// that's flat or even net-distributing, and vice versa for a newer/smaller
// name — the page presents both and explains the difference.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than
// paying for a second ~503-call OVERVIEW sweep just for labels, same
// pattern as scheduled-insider-transactions-background.js and most other
// recent full-universe pages on this site.
//
// Real cross-page dependency for the statistical component: reads
// Relative Strength Leaders/Laggards' own latest.json (getRelativeStrength
// Store) for the forward/contemporaneous 3-month relative-return figure
// used to test whether net accumulation breadth predicts subsequent
// relative price performance, rather than running a second ~503-call price
// sweep of its own — the exact idiom scheduled-earnings-growth-divergence-
// background.js already established against the same blob. If that blob
// isn't populated yet, this job still writes a full snapshot with
// relPrice3M: null everywhere (relativeStrengthAvailable: false in the
// payload) rather than failing, and the page shows a warning banner
// instead of erroring — same graceful-fallback shape as that page and as
// scheduled-fcf-yield-background.js's own P/E Divergence dependency.
//
// A company is skipped entirely if total_institutional_holders is
// missing/zero (can't compute a breadth ratio against a zero denominator)
// or if Sector Beeswarm has no sector metadata for it. See
// MAX_OWNERSHIP_PCT below for the separate, narrower ownership-percentage
// sanity bound (which excludes just that one field, not the whole row).
//
// ~503 sequential calls, 1050ms apart with a retry pass — same pacing
// proven at this exact scale by scheduled-insider-transactions-
// background.js / scheduled-pe-divergence-background.js.
//
// One-time snapshot (no `schedule` in netlify.toml) — see this function's
// own netlify.toml comment block for the current site-wide convention and
// a sensible Saturday slot for the record.

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
const MAX_HISTORY_WEEKS = 104;

// Sanity bound on total_institutional_ownership_percentage, not a clamp: a
// reading above this excludes just the ownership-% figure for that company
// (shown as — everywhere, still counted toward every other stat), not the
// whole row — the company's net accumulation breadth is computed from a
// separate set of fields (holders_with_*) and stays valid even when the
// ownership-% field itself is bad. True institutional ownership of a stock
// cannot exceed 100% of shares outstanding; a reading past it is a data-
// vendor double-count via share-class/ETF-look-through quirks (a known
// issue with aggregated 13F-derived ownership figures), not a real
// positioning signal — same "exclude the one implausible field, keep the
// rest of the row" approach as scheduled-fcf-yield-background.js's
// MAX_ABS_FCF_YIELD_PCT, just scoped to a single field here instead of the
// whole row.
const MAX_OWNERSHIP_PCT = 100;

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
// Alpha Vantage returns the literal string "None" (not null/omitted) for a
// missing numeric field on the fundamentals endpoints — same gotcha
// guarded against in scheduled-margin-leverage-background.js. All of the
// total_institutional_*/holders_with_*/shares_with_* fields on this
// endpoint come back as numeric strings, parsed the same defensive way.
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
// total_institutional_ownership_percentage comes back as a string with a
// trailing "%" (e.g. "77%"), not a bare number.
function numPct(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(String(v).replace("%", ""));
  return Number.isFinite(n) ? n : null;
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
  // Only the top-level summary fields are ever read off `payload` below —
  // `payload.holdings` (the per-institution list) is never touched, per
  // the file header.
  return payload;
}

exports.handler = async () => {
  console.log(`scheduled-institutional-ownership-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmMeta = await getBeeswarmStore().get(META_KEY, { type: "json" }).catch(() => null);
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};

    let relPrice3MBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relPrice3MBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-institutional-ownership-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const relativeStrengthAvailable = Object.keys(relPrice3MBySymbol).length > 0;
    if (!relativeStrengthAvailable) {
      console.log("scheduled-institutional-ownership-background: relative-strength blob not populated yet — writing ownership/breadth only, forward-return pairs omitted");
    }

    const results = new Map();
    async function fetchInto(symbol) {
      try {
        const payload = await fetchInstitutionalHoldings(apiKey, symbol);
        results.set(symbol, payload);
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
    for (const [symbol, p] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      const totalHolders = num(p.total_institutional_holders);
      if (!totalHolders || totalHolders <= 0) continue; // can't divide by zero

      const holdersIncreased = num(p.holders_with_increased_holdings) ?? 0;
      const holdersDecreased = num(p.holders_with_decreased_holdings) ?? 0;
      const holdersUnchanged = num(p.holders_with_unchanged_holdings) ?? 0;

      let ownershipPct = numPct(p.total_institutional_ownership_percentage);
      if (ownershipPct !== null && (ownershipPct < 0 || ownershipPct > MAX_OWNERSHIP_PCT)) ownershipPct = null;

      const netAccumulationBreadth = ((holdersIncreased - holdersDecreased) / totalHolders) * 100;
      if (!Number.isFinite(netAccumulationBreadth)) continue;

      const relPrice3M = Object.prototype.hasOwnProperty.call(relPrice3MBySymbol, symbol)
        ? relPrice3MBySymbol[symbol]
        : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        totalHolders: Math.round(totalHolders),
        ownershipPct: round(ownershipPct, 1),
        netAccumulationBreadth: round(netAccumulationBreadth),
        holdersIncreased: Math.round(holdersIncreased),
        holdersDecreased: Math.round(holdersDecreased),
        holdersUnchanged: Math.round(holdersUnchanged),
        relPrice3M,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable institutional-holdings summary data and sector metadata");

    const withOwnership = companies.filter((c) => c.ownershipPct !== null);
    const withPriceData = companies.filter((c) => c.relPrice3M !== null);

    const market = {
      companyCount: companies.length,
      ownershipPctCoverage: withOwnership.length,
      medianOwnershipPct: round(median(withOwnership.map((c) => c.ownershipPct)), 1),
      medianNetAccumulationBreadth: round(median(companies.map((c) => c.netAccumulationBreadth))),
    };

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        const inSectorWithOwnership = inSector.filter((c) => c.ownershipPct !== null);
        return {
          sector,
          companyCount: inSector.length,
          medianOwnershipPct: round(median(inSectorWithOwnership.map((c) => c.ownershipPct)), 1),
          medianNetAccumulationBreadth: round(median(inSector.map((c) => c.netAccumulationBreadth))),
        };
      })
      .filter(Boolean);

    // Snapshot-only endpoint (no time series for the market-wide figure),
    // so the market-median net accumulation breadth is appended to a
    // running weekly history each run — same accumulating pattern as
    // scheduled-pe-divergence-background.js / scheduled-fcf-yield-
    // background.js.
    const store = getInstitutionalOwnershipStore();
    const previous = (await store.get(BLOB_KEY, { type: "json" })) || { history: [] };
    const history = Array.isArray(previous.history) ? previous.history : [];
    const weekKey = new Date().toISOString().slice(0, 10);
    const weekEntry = {
      week: weekKey,
      medianNetAccumulationBreadth: market.medianNetAccumulationBreadth,
      companyCount: market.companyCount,
    };
    if (!history.length || history[history.length - 1].week !== weekKey) {
      history.push(weekEntry);
    } else {
      history[history.length - 1] = weekEntry;
    }
    while (history.length > MAX_HISTORY_WEEKS) history.shift();

    // One point per company: net accumulation breadth (x, this run's
    // positioning) vs. Relative Strength Leaders/Laggards' 3-month
    // relative return (y, a separate snapshot, not a lagged rank of this
    // same metric) — the "this week's positioning vs. a separate forward/
    // contemporaneous return snapshot" framing that page already uses,
    // deliberately not a mechanically-overlapping-window construction. See
    // scheduled-relative-strength-background.js's own comments for why it
    // compares against a snapshot rather than a lagged rank in the first
    // place (two overlapping 63-trading-day windows one week apart would
    // correlate almost mechanically regardless of any real signal).
    const scatterPairs = withPriceData.map((c) => ({
      symbol: c.symbol,
      sector: c.sector,
      x: c.netAccumulationBreadth,
      y: c.relPrice3M,
    }));

    const highestOwnership = [...withOwnership].sort((a, b) => b.ownershipPct - a.ownershipPct).slice(0, NOTABLE_COUNT);
    const lowestOwnership = [...withOwnership].sort((a, b) => a.ownershipPct - b.ownershipPct).slice(0, NOTABLE_COUNT);
    const biggestPositiveBreadth = [...companies].sort((a, b) => b.netAccumulationBreadth - a.netAccumulationBreadth).slice(0, NOTABLE_COUNT);
    const biggestNegativeBreadth = [...companies].sort((a, b) => a.netAccumulationBreadth - b.netAccumulationBreadth).slice(0, NOTABLE_COUNT);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      relativeStrengthAvailable,
      market,
      sectors,
      history,
      scatterPairs,
      leaders: { highestOwnership, lowestOwnership, biggestPositiveBreadth, biggestNegativeBreadth },
      companies,
    };

    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-institutional-ownership-background: wrote ${companies.length} companies (${withOwnership.length} with ownership%, ${withPriceData.length} with relative-strength) across ${sectors.length} sectors, ${history.length}-week history`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-institutional-ownership-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
