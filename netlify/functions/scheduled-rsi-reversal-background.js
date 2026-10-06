// Scheduled Background Function (see [functions."scheduled-rsi-reversal-
// background"] in netlify.toml) for the RSI Mean-Reversion / Short-Term
// Reversal Screen page. Sweeps Alpha Vantage's RSI technical-indicator
// endpoint (function=RSI, daily interval, time_period=14, series_type=close)
// across the full S&P 500 — the site's first use of any Alpha Vantage
// technical-indicator endpoint (every other page is fundamentals-,
// price-return-, or flow-based). Each call returns a full daily RSI time
// series; only the latest value is used for the cross-sectional snapshot,
// same "full series returned, only last point used" shape as
// scheduled-splits-background.js's SPLITS calls. A single-endpoint sweep
// (~503 calls, no BALANCE_SHEET/CASH_FLOW/INCOME_STATEMENT involved), the
// same shape/cost as scheduled-rd-intensity-background.js.
//
// Tests short-term reversal (Jegadeesh 1990; Lehmann 1990) rather than the
// 1-3 month momentum scheduled-relative-strength-background.js already
// covers: do stocks with an extreme RSI reading now show the following
// week's return reverting toward the mean? That needs a per-company RSI
// *decile* recorded alongside that company's realized forward return over
// the following week, joined across successive weekly snapshots — so this
// is a real recurring weekly job (unlike most fundamentals sweeps added to
// this site since 2026-09-16, which converted to one-time snapshots), and
// needs at least two runs before a single forward-return pair exists, and
// several before a stable per-decile average does. See rsi-reversal.js /
// rsi-reversal.html for how the cold-start states are handled.
//
// Forward returns are NOT computed from a second price sweep. Instead, each
// run reads scheduled-relative-strength-background.js's own weekly
// history.json (its {date, spyPrice, prices} points already exist for that
// page's own rank-persistence test) and copies that snapshot's spyPrice/
// prices into THIS job's own history point, tagged with the source point's
// own date (priceAsOf). Consecutive weekly points in *this* job's history
// are then diffed the same way scheduled-relative-strength-background.js
// diffs its own points — this avoids ~503 redundant TIME_SERIES_DAILY_
// ADJUSTED calls per run, at the cost of a real (documented, gracefully
// degrading) dependency: if scheduled-relative-strength-background hasn't
// run since this job's last snapshot, priceAsOf is unchanged and that
// week's transition is skipped rather than recording a fabricated
// zero-return week (see buildReversalPairs() below).
//
// Reuses company name/sector from Sector Beeswarm's own weekly meta.json
// blob, same pattern as every other full-universe sweep in this codebase.
//
// Weekly, Saturday — see netlify.toml for the exact slot and why. Pacing:
// ~503 sequential calls at 1050ms with a retry pass, same cadence as
// scheduled-rd-intensity-background.js and scheduled-revisions-background.js.

const { getRsiReversalStore, LATEST_KEY, HISTORY_KEY } = require("./rsi-reversal-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, HISTORY_KEY: RS_HISTORY_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const OVERSOLD_THRESHOLD = 30;
const OVERBOUGHT_THRESHOLD = 70;
const LEADERBOARD_COUNT = 15;
const MIN_SECTOR_N = 3;
const MAX_HISTORY_WEEKS = 20; // ~5 months of weekly snapshots, same retention as relative-strength's own history

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Same compounding-consistent excess-return construction used by
// scheduled-relative-strength-background.js (and the pages that reuse its
// blob): (1+stock)/(1+benchmark) - 1, in percentage points.
function relativeReturn(stockRet, benchRet) {
  if (stockRet === null || benchRet === null || !Number.isFinite(stockRet) || !Number.isFinite(benchRet)) return null;
  return ((1 + stockRet) / (1 + benchRet) - 1) * 100;
}

async function fetchLatestRsi(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const series = payload["Technical Analysis: RSI"];
  if (!series || typeof series !== "object") {
    throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);
  }
  const dates = Object.keys(series).sort(); // AV returns these unordered; ascending sort makes "latest" unambiguous
  if (!dates.length) return null;
  const latestDate = dates[dates.length - 1];
  const rsi = parseFloat(series[latestDate].RSI);
  if (!Number.isFinite(rsi)) return null;
  return { date: latestDate, rsi };
}

// Ranks ascending by RSI (1 = lowest/most oversold) and splits into 10
// equal-count deciles (1 = most oversold, 10 = most overbought) — the
// standard construction for a decile-bucket reversal test.
function assignDeciles(companies) {
  const ranked = [...companies].sort((a, b) => a.rsi - b.rsi);
  const n = ranked.length;
  ranked.forEach((c, i) => {
    c.decile = Math.min(10, Math.floor((i * 10) / n) + 1);
  });
}

// Diffs consecutive points in this job's own history to build the
// {decile, rsi, forwardRelReturn} pairs the reversal test runs on. A pair
// is skipped (not recorded as a zero-return week) when the two points share
// the same priceAsOf — meaning scheduled-relative-strength-background
// hasn't produced a fresh weekly snapshot between them, so no real forward
// return exists to measure yet.
function buildReversalPairs(points) {
  const pairs = [];
  let skippedStalePrice = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const prev = points[i];
    const cur = points[i + 1];
    if (!prev.spyPrice || !cur.spyPrice || !prev.priceAsOf || prev.priceAsOf === cur.priceAsOf) {
      skippedStalePrice++;
      continue;
    }
    const forwardSpyRet = cur.spyPrice / prev.spyPrice - 1;
    for (const symbol of Object.keys(prev.rsi || {})) {
      const rsiVal = prev.rsi[symbol];
      const decile = prev.decile[symbol];
      const prevPrice = prev.prices[symbol];
      const curPrice = cur.prices[symbol];
      if (rsiVal === undefined || !decile || !prevPrice || !curPrice) continue;
      const forwardStockRet = curPrice / prevPrice - 1;
      const y = relativeReturn(forwardStockRet, forwardSpyRet);
      if (y === null) continue;
      pairs.push({ symbol, x: rsiVal, decile, y: round(y), fromDate: prev.date, toDate: cur.date });
    }
  }
  return { pairs, skippedStalePrice };
}

exports.handler = async () => {
  console.log(`scheduled-rsi-reversal-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    // Read (not write) relative-strength's own weekly price history for
    // this run's price snapshot — see the file header for why this avoids
    // a second full-universe price sweep.
    let priceSnapshot = null; // { date, spyPrice, prices }
    try {
      const rsHistory = await getRelativeStrengthStore().get(RS_HISTORY_KEY, { type: "json" });
      const rsPoints = rsHistory && Array.isArray(rsHistory.points) ? rsHistory.points : [];
      if (rsPoints.length) priceSnapshot = rsPoints[rsPoints.length - 1];
    } catch (err) {
      console.error("scheduled-rsi-reversal-background: could not read relative-strength history, continuing without a price snapshot this run:", err.message);
    }

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const entry = await fetchLatestRsi(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-rsi-reversal-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-rsi-reversal-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-rsi-reversal-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, entry] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        rsi: round(entry.rsi, 2),
        asOfDate: entry.date,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with both an RSI reading and sector metadata");

    assignDeciles(companies);

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianRsi: round(median(inSector.map((c) => c.rsi))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianRsi: round(median(companies.map((c) => c.rsi))),
      oversoldCount: companies.filter((c) => c.rsi < OVERSOLD_THRESHOLD).length,
      overboughtCount: companies.filter((c) => c.rsi > OVERBOUGHT_THRESHOLD).length,
    };

    const oversoldLeaders = companies
      .filter((c) => c.rsi < OVERSOLD_THRESHOLD)
      .sort((a, b) => a.rsi - b.rsi)
      .slice(0, LEADERBOARD_COUNT);
    const overboughtLeaders = companies
      .filter((c) => c.rsi > OVERBOUGHT_THRESHOLD)
      .sort((a, b) => b.rsi - a.rsi)
      .slice(0, LEADERBOARD_COUNT);

    // ---- Weekly history + reversal test ----
    const store = getRsiReversalStore();
    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];

    const generatedAt = new Date().toISOString();
    const todayDate = generatedAt.slice(0, 10);

    const rsiBySymbol = {};
    const decileBySymbol = {};
    companies.forEach((c) => { rsiBySymbol[c.symbol] = c.rsi; decileBySymbol[c.symbol] = c.decile; });

    const newPoint = {
      date: todayDate,
      priceAsOf: priceSnapshot ? priceSnapshot.date : null,
      spyPrice: priceSnapshot ? priceSnapshot.spyPrice : null,
      prices: priceSnapshot ? priceSnapshot.prices : {},
      rsi: rsiBySymbol,
      decile: decileBySymbol,
    };

    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push(newPoint);
    const trimmedPoints = filtered.slice(-MAX_HISTORY_WEEKS);

    const { pairs: reversalPairs, skippedStalePrice } = buildReversalPairs(trimmedPoints);

    await store.setJSON(HISTORY_KEY, { points: trimmedPoints });

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasPriceSnapshot: !!priceSnapshot,
      market,
      sectors,
      oversoldLeaders,
      overboughtLeaders,
      weeksAccumulated: trimmedPoints.length,
      skippedStalePriceTransitions: skippedStalePrice,
      reversalPairs,
      companies: companies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        rsi: c.rsi,
        decile: c.decile,
        asOfDate: c.asOfDate,
      })),
    };

    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-rsi-reversal-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `${trimmedPoints.length} weekly snapshots retained, ${reversalPairs.length} reversal pairs (${skippedStalePrice} transition(s) skipped for a stale price source)`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length, reversalPairs: reversalPairs.length }) };
  } catch (err) {
    console.error(`scheduled-rsi-reversal-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
