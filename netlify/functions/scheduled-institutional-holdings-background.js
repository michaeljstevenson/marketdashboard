// Scheduled Background Function (see [functions."scheduled-institutional-
// holdings-background"] in netlify.toml) for the Institutional Ownership &
// Smart-Money Flow page. Off-list idea (per this brief's explicit
// permission to propose beyond the backlog) — no existing page on this
// site touches 13F/institutional-ownership data at all.
//
// Sweeps Alpha Vantage's INSTITUTIONAL_HOLDINGS across the full S&P 500.
// Per company, this returns: total institutional ownership %, counts of
// holders who increased/decreased/held-unchanged their position since the
// last reported period, and a (large, often thousands-of-rows) list of
// individual institutional holders with shares held/changed. Only small
// aggregate fields plus the top few holders by size are kept per company —
// the full holdings list is discarded immediately after extracting the
// top-3 concentration figure, so this job's memory footprint stays
// bounded to one company's raw response at a time, not an accumulating
//503-company list of large arrays.
//
// Two derived metrics per company:
//   - accumulationBreadth = (holders that increased - holders that
//     decreased) / total holders — a net "smart money" flow signal for
//     this reporting period, bounded to [-1, 1].
//   - top3Concentration = (shares held by the 3 largest institutional
//     holders) / total institutional shares — how concentrated ownership
//     is among a handful of mega-holders (Vanguard/BlackRock/State Street
//     dominate most large caps; a genuinely different #1 holder, or a
//     concentration far from the norm, is itself informative).
//
// The one real statistical test (institutional ownership % vs. beta — do
// institutions gravitate to lower-beta, more stable names?) reads beta
// straight off scheduled-equity-risk-premium-background.js's own latest.json
// blob rather than paying for a second COMPANY_OVERVIEW sweep — the same
// cross-page-blob-reuse pattern Shareholder Yield and Earnings Growth
// Divergence already use elsewhere in this codebase. Falls back to an
// ownership-only page (no scatter/regression) if that blob isn't
// populated yet, same graceful-fallback convention as those two pages.
//
// CAVEAT for whoever reviews this after merge: this sandbox's egress
// policy blocks every domain except Alpha Vantage and the npm registry, so
// the exact field names below (holder_name, shares_held,
// total_institutional_ownership_percentage, etc.) come from Alpha
// Vantage's own MCP server tool output during design, not a live raw-HTTP
// verification of https://www.alphavantage.co/query?function=
// INSTITUTIONAL_HOLDINGS from this environment. The MCP server is Alpha
// Vantage's own, so the field names are very likely a direct passthrough
// of the real API — but this is worth a quick log check on the first real
// production run, the same caveat given for the FINRA integration in
// scheduled-short-sale-volume-background.js.
//
// ~503 sequential calls, 1050ms apart with a retry pass — same pacing
// proven at this scale by scheduled-beeswarm-meta-background.js.

const { getInstitutionalHoldingsStore, LATEST_KEY } = require("./institutional-holdings-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getErpStore, LATEST_KEY: ERP_LATEST_KEY } = require("./equity-risk-premium-blob-store");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LEADERBOARD_COUNT = 15;
const MIN_HOLDERS_FOR_BREADTH = 10; // below this, a breadth ratio is too noisy to report

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 4) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
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
function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[%,]/g, ""));
  return Number.isFinite(n) ? n : null;
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
  if (!p || (!p.symbol && !p.total_institutional_holders)) return null; // empty/unrecognized body

  const totalHolders = toNumber(p.total_institutional_holders);
  const increased = toNumber(p.holders_with_increased_holdings);
  const decreased = toNumber(p.holders_with_decreased_holdings);
  const ownershipPct = toNumber(p.total_institutional_ownership_percentage);
  const totalShares = toNumber(p.total_institutional_shares);

  let top3Concentration = null;
  let topHolderName = null;
  if (Array.isArray(p.holdings) && p.holdings.length && totalShares) {
    const sorted = [...p.holdings]
      .map((h) => ({ name: h.holder_name, shares: toNumber(h.shares_held) }))
      .filter((h) => h.shares !== null)
      .sort((a, b) => b.shares - a.shares);
    const top3Shares = sorted.slice(0, 3).reduce((s, h) => s + h.shares, 0);
    top3Concentration = totalShares > 0 ? top3Shares / totalShares : null;
    topHolderName = sorted[0]?.name || null;
  }

  const breadth =
    Number.isFinite(totalHolders) && totalHolders >= MIN_HOLDERS_FOR_BREADTH && Number.isFinite(increased) && Number.isFinite(decreased)
      ? (increased - decreased) / totalHolders
      : null;

  return {
    totalHolders,
    increased,
    decreased,
    ownershipPct,
    top3Concentration,
    topHolderName,
    accumulationBreadth: breadth,
  };
}

exports.handler = async () => {
  console.log("scheduled-institutional-holdings-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = await beeswarmStore.get(META_KEY, { type: "json" });
    if (!meta || !meta.tickers) throw new Error("beeswarm meta.json not populated — scheduled-beeswarm-meta-background hasn't run yet");

    const symbols = Object.keys(meta.tickers).filter((s) => meta.tickers[s] && meta.tickers[s].sector);
    console.log(`scheduled-institutional-holdings-background: fetching INSTITUTIONAL_HOLDINGS for ${symbols.length} tickers`);

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const data = await fetchInstitutionalHoldings(apiKey, symbol);
        if (data) results.set(symbol, data);
        return true;
      } catch (err) {
        console.error(`scheduled-institutional-holdings-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...symbols];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-institutional-holdings-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got && !results.has(symbol)) missed.push(symbol);
        await sleep(1050);
      }
      todo = missed;
    }
    console.log(`scheduled-institutional-holdings-background: fetched ${results.size}/${symbols.length} tickers`);

    // Optional beta join — reads Equity Risk Premium's own weekly sweep
    // instead of paying for a second COMPANY_OVERVIEW pull.
    let betaBySymbol = new Map();
    try {
      const erpStore = getErpStore();
      const erpLatest = await erpStore.get(ERP_LATEST_KEY, { type: "json" });
      if (erpLatest && Array.isArray(erpLatest.companies)) {
        for (const c of erpLatest.companies) {
          if (c.beta !== null && c.beta !== undefined) betaBySymbol.set(c.symbol, c.beta);
        }
      }
    } catch (err) {
      console.error("scheduled-institutional-holdings-background: equity-risk-premium blob unavailable, skipping beta join:", err.message);
    }
    console.log(`scheduled-institutional-holdings-background: joined beta for ${betaBySymbol.size} tickers`);

    const companies = [];
    for (const [symbol, d] of results.entries()) {
      const m = meta.tickers[symbol];
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        ownershipPct: round(d.ownershipPct, 2),
        accumulationBreadth: round(d.accumulationBreadth, 4),
        top3Concentration: round(d.top3Concentration, 4),
        topHolderName: d.topHolderName,
        totalHolders: Number.isFinite(d.totalHolders) ? d.totalHolders : null,
        beta: betaBySymbol.has(symbol) ? betaBySymbol.get(symbol) : null,
      });
    }

    const ranked = companies.filter((c) => c.ownershipPct !== null).sort((a, b) => b.ownershipPct - a.ownershipPct);
    ranked.forEach((c, i) => { c.rank = i + 1; });
    const unranked = companies.filter((c) => c.ownershipPct === null);
    unranked.forEach((c) => { c.rank = null; });
    const allCompanies = [...ranked, ...unranked];

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = ranked.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianOwnershipPct: round(median(inSector.map((c) => c.ownershipPct)), 2),
          medianAccumulationBreadth: round(median(inSector.map((c) => c.accumulationBreadth)), 4),
          medianTop3Concentration: round(median(inSector.map((c) => c.top3Concentration)), 4),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: ranked.length,
      medianOwnershipPct: round(median(ranked.map((c) => c.ownershipPct)), 2),
      medianAccumulationBreadth: round(median(ranked.map((c) => c.accumulationBreadth)), 4),
      medianTop3Concentration: round(median(ranked.map((c) => c.top3Concentration)), 4),
    };

    const highestOwnership = ranked.slice(0, LEADERBOARD_COUNT);
    const lowestOwnership = ranked.slice(-LEADERBOARD_COUNT).reverse();
    const mostAccumulated = [...ranked]
      .filter((c) => c.accumulationBreadth !== null)
      .sort((a, b) => b.accumulationBreadth - a.accumulationBreadth)
      .slice(0, LEADERBOARD_COUNT);
    const mostDistributed = [...ranked]
      .filter((c) => c.accumulationBreadth !== null)
      .sort((a, b) => a.accumulationBreadth - b.accumulationBreadth)
      .slice(0, LEADERBOARD_COUNT);
    const mostConcentrated = [...ranked]
      .filter((c) => c.top3Concentration !== null)
      .sort((a, b) => b.top3Concentration - a.top3Concentration)
      .slice(0, LEADERBOARD_COUNT);

    // Ownership-vs-beta pairs: single-snapshot cross-section, no cold-start
    // wait needed, matching Equity Risk Premium's own beta-scatter design.
    const betaPairs = ranked
      .filter((c) => c.beta !== null && c.ownershipPct !== null)
      .map((c) => ({ x: c.beta, y: c.ownershipPct, symbol: c.symbol }));

    const latest = {
      generated_at_utc: new Date().toISOString(),
      universeSize: symbols.length,
      loadedCount: results.size,
      betaJoinedCount: betaPairs.length,
      market,
      sectors,
      highestOwnership,
      lowestOwnership,
      mostAccumulated,
      mostDistributed,
      mostConcentrated,
      betaPairs,
      companies: allCompanies,
    };

    await getInstitutionalHoldingsStore().setJSON(LATEST_KEY, latest);
    console.log(
      `scheduled-institutional-holdings-background: done — ${results.size}/${symbols.length} tickers, ` +
      `${betaPairs.length} beta pairs, median ownership=${market.medianOwnershipPct}%`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, tickers: results.size }) };
  } catch (err) {
    console.error(`scheduled-institutional-holdings-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
