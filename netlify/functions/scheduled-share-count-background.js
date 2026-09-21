// Scheduled Background Function (see [functions."scheduled-share-count-
// background"] in netlify.toml) that sweeps Alpha Vantage's BALANCE_SHEET
// endpoint (quarterly commonStockSharesOutstanding, going back years) across
// the full S&P 500, for the share-count-trends.html page.
//
// A declining share count over time (buybacks outrunning any dilution from
// stock-based compensation) vs. a rising one (net dilution) is read off
// quarter-over-quarter share counts at 1/3/5-year lookbacks — no separate
// buyback-dollar data needed, since the share count itself is the net
// effect of every buyback, issuance, and option exercise combined.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than
// paying for a second ~503-call OVERVIEW sweep just for labels — same
// pattern as scheduled-revisions-background.js and
// scheduled-insider-transactions-background.js.
//
// Weekly, not daily: share counts only change when a company actually
// reports a new 10-Q/10-K, so a daily re-sweep would refetch the same
// ~503 unchanged numbers 6 days out of 7.
//
// ~503 sequential calls, 1050ms apart with a retry pass — same pacing
// proven at this exact scale by scheduled-beeswarm-meta-background.js's
// OVERVIEW sweep.

const { getShareCountStore, BLOB_KEY } = require("./share-count-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_NEEDED = 21; // current + up to 5 non-overlapping years back
const NOTABLE_COUNT = 15;
const FLAT_THRESHOLD = 0.5; // % — smaller moves are noise/rounding, not a real buyback or dilution signal

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function classify(pctChange) {
  if (pctChange === null) return null;
  if (pctChange <= -FLAT_THRESHOLD) return "buyback";
  if (pctChange >= FLAT_THRESHOLD) return "dilution";
  return "flat";
}
function pctChange(now, then) {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return null;
  return round(((now / then) - 1) * 100);
}

async function fetchQuarterlyShares(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=BALANCE_SHEET&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);

  // Alpha Vantage returns quarterlyReports most-recent-first already.
  return rows
    .slice(0, QUARTERS_NEEDED)
    .map((r) => ({ fiscalDateEnding: r.fiscalDateEnding, shares: parseFloat(r.commonStockSharesOutstanding) }))
    .filter((r) => Number.isFinite(r.shares) && r.shares > 0);
}

exports.handler = async () => {
  console.log(`scheduled-share-count-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchQuarterlyShares(apiKey, symbol);
        if (quarters.length >= 5) results.set(symbol, quarters); // need at least a 1Y lookback to be useful
        return true;
      } catch (err) {
        console.error(`scheduled-share-count-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-share-count-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-share-count-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed. Refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, quarters] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      const sharesAt = (idx) => (quarters[idx] ? quarters[idx].shares : null);
      const change1Y = pctChange(sharesAt(0), sharesAt(4));
      const change3Y = pctChange(sharesAt(0), sharesAt(12));
      const change5Y = pctChange(sharesAt(0), sharesAt(20));

      // Non-overlapping year-over-year changes, most recent first — same
      // "non-overlapping annual" construction used by /factor-analysis's
      // momentum test, applied here to share count instead of a return.
      const yearlyChanges = [];
      for (let k = 0; k + 4 < quarters.length; k += 4) {
        const yc = pctChange(sharesAt(k), sharesAt(k + 4));
        if (yc === null) break;
        yearlyChanges.push(yc);
      }
      if (!yearlyChanges.length) continue;

      let currentStreak = 0;
      const latestClass = classify(yearlyChanges[0]);
      if (latestClass && latestClass !== "flat") {
        for (const yc of yearlyChanges) {
          if (classify(yc) !== latestClass) break;
          currentStreak++;
        }
        if (latestClass === "dilution") currentStreak = -currentStreak;
      }

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        sharesNow: sharesAt(0),
        change1Y,
        change3Y,
        change5Y,
        classification: classify(change1Y),
        yearlyChanges,
        currentStreak,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both share-count history and sector metadata");

    function mean(values) {
      const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
      return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    }

    const market = {
      companyCount: companies.length,
      avgChange1Y: mean(companies.map((c) => c.change1Y)),
      avgChange3Y: mean(companies.map((c) => c.change3Y)),
      buybackCount: companies.filter((c) => c.classification === "buyback").length,
      dilutionCount: companies.filter((c) => c.classification === "dilution").length,
      flatCount: companies.filter((c) => c.classification === "flat").length,
    };

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          avgChange1Y: mean(inSector.map((c) => c.change1Y)),
          avgChange3Y: mean(inSector.map((c) => c.change3Y)),
          buybackCount: inSector.filter((c) => c.classification === "buyback").length,
          dilutionCount: inSector.filter((c) => c.classification === "dilution").length,
        };
      })
      .filter(Boolean);

    // Year-over-year persistence: does last year's buyback/dilution rate
    // predict this year's? Pearson regression, computed client-side from
    // these raw pairs (same convention as /factor-analysis and the other
    // pages this session built).
    const persistencePairs = companies
      .filter((c) => c.yearlyChanges.length >= 2)
      .map((c) => ({ symbol: c.symbol, x: c.yearlyChanges[1], y: c.yearlyChanges[0] }));

    const buybackLeaders = [...companies]
      .filter((c) => c.change3Y !== null)
      .sort((a, b) => a.change3Y - b.change3Y)
      .slice(0, NOTABLE_COUNT)
      .map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, change1Y: c.change1Y, change3Y: c.change3Y, currentStreak: c.currentStreak }));

    const dilutionLeaders = [...companies]
      .filter((c) => c.change3Y !== null)
      .sort((a, b) => b.change3Y - a.change3Y)
      .slice(0, NOTABLE_COUNT)
      .map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, change1Y: c.change1Y, change3Y: c.change3Y, currentStreak: c.currentStreak }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      market,
      sectors,
      persistencePairs,
      buybackLeaders,
      dilutionLeaders,
      companies: companies.map((c) => ({
        symbol: c.symbol, name: c.name, sector: c.sector, change1Y: c.change1Y, change3Y: c.change3Y,
        change5Y: c.change5Y, classification: c.classification, currentStreak: c.currentStreak,
      })),
    };

    await getShareCountStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-share-count-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-share-count-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
