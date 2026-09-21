// Scheduled Background Function (see [functions."scheduled-shareholder-
// yield-background"] in netlify.toml) that combines dividend yield and
// buyback yield into a single "shareholder yield" view across the S&P 500,
// for the shareholder-yield.html page — the backlog's "Buyback Yield vs.
// Dividend Yield" idea.
//
// Dividend yield comes from a dedicated Alpha Vantage OVERVIEW
// sweep (its DividendYield field is already a trailing, per-share-price-
// normalized yield — no need to separately sum raw DIVIDENDS payments
// against a price series). Buyback yield is *not* re-fetched: it's read
// straight off the already-computed trailing-12-month share-count change
// in the "share-count-trends" Netlify Blobs store (see
// scheduled-share-count-background.js), negated (a shrinking share count
// is a buyback; buybackYield = -change1Y) — that job already does the
// harder work of turning quarterly BALANCE_SHEET data into a clean 1-year
// buyback/dilution number, and re-deriving it here from scratch would just
// be a second, redundant BALANCE_SHEET sweep of the exact same data.
//
// Sector and company name come from the beeswarm store's meta.json, the
// same reuse pattern as scheduled-revisions-background.js and
// scheduled-dispersion-background.js.
//
// Runs weekly (Saturday 11:25 UTC), after scheduled-share-count-background
// (10:50 UTC, finishes ~11:00) so its trends.json is fresh when read here,
// and after scheduled-dispersion-background's own ~503-call sweep (starts
// 11:10, finishes ~11:19) so the two full-index sweeps don't compete for
// the rate limit. Weekly, not daily: OVERVIEW's DividendYield field and a
// trailing-12-month share-count change both move slowly.

const { getShareholderYieldStore, BLOB_KEY } = require("./shareholder-yield-blob-store");
const { getShareCountStore, BLOB_KEY: SHARE_COUNT_KEY } = require("./share-count-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

// Netlify captures no console output for background functions, and a run that
// dies leaves no trace, so this job writes its own progress and any error to
// STATUS_KEY (same store as its snapshot, ignored by the page API).
const STATUS_KEY = "status.json";
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchDividendYield(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  if (!payload.Symbol) return null; // AV returns {} for a delisted/unrecognized symbol
  const yieldFrac = num(payload.DividendYield);
  return yieldFrac !== null ? yieldFrac * 100 : 0; // no DividendYield field = non-payer, treated as 0%
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function round(v, d = 3) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

exports.handler = async () => {
  console.log(`scheduled-shareholder-yield-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  const startedAtMs = Date.now();
  const status = { startedAt: new Date().toISOString(), phase: "starting", processed: 0, total: BREADTH_CONSTITUENTS.length, failedCount: 0, recentErrors: [] };
  let setStatus = async () => {};
  try {
    const statusStore = getShareholderYieldStore();
    setStatus = async (patch) => {
      Object.assign(status, patch, { updatedAt: new Date().toISOString(), elapsedSec: Math.round((Date.now() - startedAtMs) / 1000) });
      try { await statusStore.setJSON(STATUS_KEY, status); } catch (e) { console.error(`status write failed: ${e.message}`); }
    };
    await setStatus({ phase: "starting" });
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const [beeswarmMeta, shareCountData] = await Promise.all([
      getBeeswarmStore().get(META_KEY, { type: "json" }),
      getShareCountStore().get(SHARE_COUNT_KEY, { type: "json" }),
    ]);
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};
    if (!shareCountData || !Array.isArray(shareCountData.companies)) {
      throw new Error("share-count-trends data not available yet, scheduled-share-count-background must run first");
    }
    const buybackByTicker = new Map(
      shareCountData.companies
        .filter((c) => c.change1Y !== null && c.change1Y !== undefined)
        .map((c) => [c.symbol, -c.change1Y]) // buyback yield = negative of the % change in shares outstanding
    );

    const dividendYields = new Map();
    await setStatus({ phase: "sweeping" });

    async function fetchInto(symbol) {
      try {
        const y = await fetchDividendYield(apiKey, symbol);
        if (y !== null) dividendYields.set(symbol, y);
        return true;
      } catch (err) {
        console.error(`scheduled-shareholder-yield-background: ${symbol} failed: ${err.message}`);
        status.failedCount++;
        status.recentErrors = [...status.recentErrors, `${symbol}: ${err.message}`.slice(0, 200)].slice(-10);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    // Same two-pass, ~1.05s-spaced sweep as the site's other full-index
    // OVERVIEW/EARNINGS_ESTIMATES jobs.
    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-shareholder-yield-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        status.processed++;
        if (status.processed % 50 === 0) await setStatus({ phase: pass ? "retrying" : "sweeping" });
        await sleep(1050);
      }
      todo = missed;
    }

    console.log(`scheduled-shareholder-yield-background: fetched dividend yield for ${dividendYields.size}/${BREADTH_CONSTITUENTS.length} tickers`);

    await setStatus({ phase: "computing", fetched: dividendYields.size });
    const rows = [];
    for (const symbol of BREADTH_CONSTITUENTS) {
      const m = metaTickers[symbol];
      const divYield = dividendYields.get(symbol);
      const buybackYield = buybackByTicker.get(symbol);
      if (!m || !m.sector || divYield === undefined || buybackYield === undefined) continue;
      rows.push({
        ticker: symbol,
        name: m.name || symbol,
        sector: m.sector,
        dividendYield: round(divYield, 2),
        buybackYield: round(buybackYield, 2),
        totalShareholderYield: round(divYield + buybackYield, 2),
      });
    }

    if (!rows.length) throw new Error("No tickers resolved with dividend yield, buyback yield, and sector metadata");

    const sectorAgg = SECTOR_ORDER.map((sector) => {
      const inSector = rows.filter((r) => r.sector === sector);
      return {
        sector,
        count: inSector.length,
        avgDividendYield: round(mean(inSector.map((r) => r.dividendYield))),
        avgBuybackYield: round(mean(inSector.map((r) => r.buybackYield))),
        avgTotalYield: round(mean(inSector.map((r) => r.totalShareholderYield))),
      };
    }).filter((s) => s.count > 0);

    const market = {
      avgDividendYield: round(mean(rows.map((r) => r.dividendYield))),
      avgBuybackYield: round(mean(rows.map((r) => r.buybackYield))),
      avgTotalYield: round(mean(rows.map((r) => r.totalShareholderYield))),
    };

    const topTotal = [...rows].sort((a, b) => b.totalShareholderYield - a.totalShareholderYield).slice(0, 10);
    const topDividendOnly = [...rows].sort((a, b) => b.dividendYield - a.dividendYield).slice(0, 10);
    const topBuybackOnly = [...rows].sort((a, b) => b.buybackYield - a.buybackYield).slice(0, 10);

    const leaderboardRow = (r) => ({
      ticker: r.ticker, name: r.name, sector: r.sector,
      dividendYield: r.dividendYield, buybackYield: r.buybackYield, totalShareholderYield: r.totalShareholderYield,
    });

    const scatterPoints = rows.map((r) => ({
      ticker: r.ticker, sector: r.sector, dividendYield: r.dividendYield, buybackYield: r.buybackYield,
    }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universe_size: rows.length,
      universe_total: BREADTH_CONSTITUENTS.length,
      market,
      sectors: sectorAgg,
      scatter: scatterPoints,
      topTotal: topTotal.map(leaderboardRow),
      topDividendOnly: topDividendOnly.map(leaderboardRow),
      topBuybackOnly: topBuybackOnly.map(leaderboardRow),
    };

    await getShareholderYieldStore().setJSON(BLOB_KEY, payload);
    await setStatus({ phase: "done", rows: rows.length });
    console.log(`scheduled-shareholder-yield-background: wrote ${rows.length} rows across ${sectorAgg.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, rows: rows.length, sectors: sectorAgg.length }) };
  } catch (err) {
    console.error(`scheduled-shareholder-yield-background: FAILED: ${err.message}`);
    await setStatus({ phase: "failed", error: String(err.message).slice(0, 500) });
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
