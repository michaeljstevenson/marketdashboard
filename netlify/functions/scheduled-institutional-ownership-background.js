// Scheduled Background Function (see
// [functions."scheduled-institutional-ownership-background"] in
// netlify.toml) that sweeps Alpha Vantage's INSTITUTIONAL_HOLDINGS across
// the full S&P 500 for the Institutional Ownership Trends page — a
// professional-money-flow companion to Insider Buying/Selling (Form 4,
// officers/directors/10%+ owners) using a distinct data source and a
// distinct population: 13F institutional filers (mutual funds, pensions,
// asset managers).
//
// INSTITUTIONAL_HOLDINGS' per-holder `holdings` array can run to
// thousands of rows for a mega-cap (6,489 for AAPL alone, ~459K tokens
// full payload) — this job never requests it. Every top-level aggregate
// field this page needs (total institutional holders/shares, ownership %,
// and the increased/decreased/unchanged holder and share counts, each
// already computed by Alpha Vantage against each holder's own prior 13F
// filing) is present on the default (preview) response, so the actual
// per-call payload stays small regardless of a name's holder count.
//
// Two numbers come out of that per stock, deliberately built the same
// breadth/magnitude split as scheduled-revisions-background.js:
//   - Holder Breadth: (holders increased − holders decreased) / total
//     holders, range −1..+1 — how many institutions moved, and which way.
//   - Share Flow: (shares increased − shares decreased) / total
//     institutional shares held, as a % — how much of the institutional
//     share base actually moved, which can look very different from
//     breadth when one or two giant holders dominate the flow.
//
// Sector and company name come from the beeswarm store's meta.json, same
// reuse pattern as every other full-universe job on this site.
//
// Cross-page dependency for the page's one real statistical test: reads
// relative-strength's own latest.json (getRelativeStrengthStore) for
// trailing 3-month price performance vs. SPY, testing whether the stocks
// institutions have been net buying are the same ones that have already
// outperformed — a contemporaneous/lagged relationship, not a forward-
// return persistence claim (13F filings themselves lag real time by up to
// 45 days, so "breadth right now" already reflects decisions made weeks
// earlier). If that job hasn't run yet this still writes ownership-only
// rows (relPrice3M: null) rather than failing, same graceful-fallback
// pattern as scheduled-earnings-growth-divergence-background.js.
//
// One-time snapshot as of 2026-09-16 — no recurring cron schedule (see
// netlify.toml and this repo's "Stop auto-refresh on tonight's new
// Equities pages" commit from earlier the same day): new full-universe
// Equities background jobs on this site are meant to read as "the
// research as it stood on this date," not a continuously-refreshed feed.
// Re-run manually (Netlify dashboard "Run now") for a fresh snapshot.
//
// ~503 sequential INSTITUTIONAL_HOLDINGS calls, 1050ms apart with a retry
// pass — same pacing proven at this scale by
// scheduled-beeswarm-meta-background.js.

const { getInstitutionalOwnershipStore, LATEST_KEY, HISTORY_KEY } = require("./institutional-ownership-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_HISTORY_POINTS = 260; // ~5 years, if this is ever run weekly again
const MIN_HOLDERS_FOR_LEADERBOARD = 15; // thin coverage makes breadth/flow noisy

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
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

async function fetchInstitutionalHoldings(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=INSTITUTIONAL_HOLDINGS&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = await res.json();
  if (p.Note || p.Information || p.error) throw new Error(p.Note || p.Information || JSON.stringify(p.error));

  const totalHolders = num(p.total_institutional_holders);
  const totalShares = num(p.total_institutional_shares);
  const holdersInc = num(p.holders_with_increased_holdings) || 0;
  const holdersDec = num(p.holders_with_decreased_holdings) || 0;
  const holdersUnch = num(p.holders_with_unchanged_holdings) || 0;
  const sharesInc = num(p.shares_with_increased_holdings) || 0;
  const sharesDec = num(p.shares_with_decreased_holdings) || 0;
  const ownershipPct = num(p.total_institutional_ownership_percentage);

  if (!totalHolders) return null; // no 13F coverage on file for this name

  const holderTotal = holdersInc + holdersDec + holdersUnch;

  return {
    totalHolders,
    totalShares,
    ownershipPct,
    holdersInc,
    holdersDec,
    holdersUnch,
    holderBreadth: holderTotal > 0 ? (holdersInc - holdersDec) / holderTotal : null,
    shareFlowPct: totalShares ? ((sharesInc - sharesDec) / totalShares) * 100 : null,
  };
}

exports.handler = async () => {
  console.log(`scheduled-institutional-ownership-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let relPriceBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relPriceBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-institutional-ownership-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relPriceBySymbol).length > 0;

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

    const companies = [];
    for (const [symbol, h] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const relPrice3M = Object.prototype.hasOwnProperty.call(relPriceBySymbol, symbol)
        ? relPriceBySymbol[symbol]
        : null;
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        totalHolders: h.totalHolders,
        ownershipPct: round(h.ownershipPct, 1),
        holdersInc: h.holdersInc,
        holdersDec: h.holdersDec,
        holderBreadth: round(h.holderBreadth),
        shareFlowPct: round(h.shareFlowPct, 2),
        relPrice3M,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both holdings data and sector metadata");

    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      return {
        sector,
        companyCount: inSector.length,
        medianOwnershipPct: round(median(inSector.map((c) => c.ownershipPct)), 1),
        medianHolderBreadth: round(median(inSector.map((c) => c.holderBreadth))),
        medianShareFlowPct: round(median(inSector.map((c) => c.shareFlowPct)), 2),
        holdersIncTotal: inSector.reduce((s, c) => s + (c.holdersInc || 0), 0),
        holdersDecTotal: inSector.reduce((s, c) => s + (c.holdersDec || 0), 0),
      };
    }).filter(Boolean);

    const eligible = companies.filter((c) => c.totalHolders >= MIN_HOLDERS_FOR_LEADERBOARD && c.holderBreadth !== null);
    const mostBought = [...eligible].sort((a, b) => b.holderBreadth - a.holderBreadth).slice(0, 15);
    const mostSold = [...eligible].sort((a, b) => a.holderBreadth - b.holderBreadth).slice(0, 15);
    const highestOwnership = [...companies]
      .filter((c) => c.ownershipPct !== null)
      .sort((a, b) => b.ownershipPct - a.ownershipPct)
      .slice(0, 15);
    const lowestOwnership = [...companies]
      .filter((c) => c.ownershipPct !== null)
      .sort((a, b) => a.ownershipPct - b.ownershipPct)
      .slice(0, 15);

    const withBoth = companies.filter((c) => c.holderBreadth !== null && c.relPrice3M !== null);
    const scatterPairs = withBoth.map((c) => ({ x: c.holderBreadth, y: c.relPrice3M, symbol: c.symbol }));

    const market = {
      companyCount: companies.length,
      withPriceData: withBoth.length,
      medianOwnershipPct: round(median(companies.map((c) => c.ownershipPct)), 1),
      medianHolderBreadth: round(median(companies.map((c) => c.holderBreadth))),
      medianShareFlowPct: round(median(companies.map((c) => c.shareFlowPct)), 2),
      holdersIncTotal: companies.reduce((s, c) => s + (c.holdersInc || 0), 0),
      holdersDecTotal: companies.reduce((s, c) => s + (c.holdersDec || 0), 0),
    };

    const generatedAt = new Date().toISOString();

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasPriceData,
      market,
      sectors,
      mostBought,
      mostSold,
      highestOwnership,
      lowestOwnership,
      scatterPairs,
      companies,
    };

    const store = getInstitutionalOwnershipStore();
    await store.setJSON(LATEST_KEY, latest);

    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];
    const todayDate = generatedAt.slice(0, 10);
    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push({
      date: todayDate,
      medianOwnershipPct: market.medianOwnershipPct,
      medianHolderBreadth: market.medianHolderBreadth,
    });
    const trimmed = filtered.slice(-MAX_HISTORY_POINTS);
    await store.setJSON(HISTORY_KEY, { points: trimmed });

    console.log(
      `scheduled-institutional-ownership-background: done, ${companies.length} companies across ${sectors.length} sectors, ` +
      `${withBoth.length} with price data, hasPriceData=${hasPriceData}`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-institutional-ownership-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
