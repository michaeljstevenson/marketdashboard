// Scheduled Background Function (see [functions."scheduled-relative-strength-background"]
// in netlify.toml) that sweeps Yahoo Finance's daily adjusted closes
// across the full S&P 500 (BREADTH_CONSTITUENTS, same list Market Breadth,
// Sector Beeswarm, Earnings Revisions, etc. already sweep) plus SPY, and
// computes trailing 1-month/3-month price momentum relative to SPY for
// every constituent — the "Relative Strength Leaders/Laggards" page.
//
// Deliberately trims to the last ~100 trading days, not full history: a 1-month (21 trading day) and 3-month (63 trading day) lookback
// both fit comfortably inside that window with room to spare for holidays/
// thin trading, and trimming keeps what's held in memory small — full
// history per ticker (5,000+ daily bars per name) would multiply
// the parse cost of this sweep by roughly two orders of
// magnitude for lookback depth this page doesn't use. A 6-month/1-year
// lookback ladder (like /small-cap-vs-large-cap's) was considered and
// dropped for that reason — this page trades ladder depth for the
// reliability of a same-scale, same-cost sweep as the site's other
// full-universe weekly jobs.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than
// paying for a second ~503-call OVERVIEW sweep just for labels.
//
// Weekly, not daily: a 21/63-trading-day momentum read doesn't meaningfully
// change day to day, and the rank-persistence test below needs snapshots
// spaced far enough apart for the forward-return window to mean something.
//
// ~504 sequential calls (503 constituents + SPY), 300ms apart with a
// retry pass.

const { getRelativeStrengthStore, LATEST_KEY, HISTORY_KEY } = require("./relative-strength-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { fetchDailyHistory } = require("./yahoo-client");
const COMPACT_DAYS = 100;


const LOOKBACK_1M_DAYS = 21;
const LOOKBACK_3M_DAYS = 63;
const LEADERBOARD_COUNT = 15;
const MAX_HISTORY_WEEKS = 20; // ~5 months of weekly snapshots

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

async function fetchDailyAdjusted(symbol) {
  return (await fetchDailyHistory(symbol)).slice(-COMPACT_DAYS);
}

// Trailing return from `lookbackDays` trading days ago to the most recent
// close. Returns null if there isn't enough history (recent IPO, data gap).
function trailingReturn(closes, lookbackDays) {
  const n = closes.length;
  if (n < lookbackDays + 1) return null;
  const latest = closes[n - 1].close;
  const past = closes[n - 1 - lookbackDays].close;
  if (!past) return null;
  return latest / past - 1;
}

// Compounding-consistent excess return: (1+stock)/(1+benchmark) - 1,
// expressed in percentage points. Simple subtraction (stock% - spy%) was
// considered but understates/overstates excess return at larger magnitudes
// since it ignores compounding — this matches the ratio construction used
// on /small-cap-vs-large-cap and /international-vs-us.
function relativeReturn(stockRet, benchRet) {
  if (stockRet === null || benchRet === null) return null;
  return ((1 + stockRet) / (1 + benchRet) - 1) * 100;
}

exports.handler = async () => {
  console.log(`scheduled-relative-strength-background: starting, ${BREADTH_CONSTITUENTS.length} tickers + SPY`);
  try {

    // SPY is the benchmark every other number in this job depends on —
    // fetch it first and abort the whole run if it fails rather than
    // silently computing "relative" returns against nothing.
    let spyCloses = null;
    for (let attempt = 0; attempt < 3 && !spyCloses; attempt++) {
      try {
        spyCloses = await fetchDailyAdjusted("SPY");
      } catch (err) {
        console.error(`scheduled-relative-strength-background: SPY fetch failed (attempt ${attempt + 1}): ${err.message}`);
        await sleep(5000);
      }
    }
    if (!spyCloses) throw new Error("Could not fetch SPY benchmark data after 3 attempts");
    await sleep(300);

    const spyPrice = spyCloses[spyCloses.length - 1].close;
    const spyRet1M = trailingReturn(spyCloses, LOOKBACK_1M_DAYS);
    const spyRet3M = trailingReturn(spyCloses, LOOKBACK_3M_DAYS);

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const closes = await fetchDailyAdjusted(symbol);
        if (closes.length >= LOOKBACK_1M_DAYS + 1) results.set(symbol, closes);
        return true;
      } catch (err) {
        console.error(`scheduled-relative-strength-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-relative-strength-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(300);
      }
      todo = missed;
    }

    const companies = [];
    for (const [symbol, closes] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      const price = closes[closes.length - 1].close;
      const ret1M = trailingReturn(closes, LOOKBACK_1M_DAYS);
      const ret3M = trailingReturn(closes, LOOKBACK_3M_DAYS);
      const rel1M = relativeReturn(ret1M, spyRet1M);
      const rel3M = relativeReturn(ret3M, spyRet3M);

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        price: round(price),
        ret1M: round(ret1M !== null ? ret1M * 100 : null),
        ret3M: round(ret3M !== null ? ret3M * 100 : null),
        rel1M: round(rel1M),
        rel3M: round(rel3M),
      });
    }

    // Rank by 3-month relative return, best first (1 = strongest leader).
    const ranked = companies.filter((c) => c.rel3M !== null).sort((a, b) => b.rel3M - a.rel3M);
    ranked.forEach((c, i) => { c.rank3M = i + 1; });
    const unranked = companies.filter((c) => c.rel3M === null);
    unranked.forEach((c) => { c.rank3M = null; });

    const n = ranked.length;
    const leaderCut = Math.max(1, Math.round(n * 0.2));
    ranked.forEach((c) => {
      if (c.rank3M <= leaderCut) c.classification = "Leader";
      else if (c.rank3M > n - leaderCut) c.classification = "Laggard";
      else c.classification = "Neutral";
    });
    unranked.forEach((c) => { c.classification = null; });

    const allCompanies = [...ranked, ...unranked];

    const SECTOR_ORDER_MODULE = require("./beeswarm-sectors");
    const sectors = SECTOR_ORDER_MODULE.SECTOR_ORDER
      .map((sector) => {
        const inSector = ranked.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          avgRel1M: round(mean(inSector.map((c) => c.rel1M))),
          avgRel3M: round(mean(inSector.map((c) => c.rel3M))),
          leaderCount: inSector.filter((c) => c.classification === "Leader").length,
          laggardCount: inSector.filter((c) => c.classification === "Laggard").length,
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: n,
      avgRel1M: round(mean(ranked.map((c) => c.rel1M))),
      avgRel3M: round(mean(ranked.map((c) => c.rel3M))),
      medianRel3M: round(median(ranked.map((c) => c.rel3M))),
      pctOutperforming3M: round(n ? (ranked.filter((c) => c.rel3M > 0).length / n) * 100 : null, 1),
      spyRet1M: round(spyRet1M !== null ? spyRet1M * 100 : null),
      spyRet3M: round(spyRet3M !== null ? spyRet3M * 100 : null),
    };

    const leaders = ranked.slice(0, LEADERBOARD_COUNT);
    const laggards = ranked.slice(-LEADERBOARD_COUNT).reverse();

    // ---- Weekly history + forward-return persistence test ----
    // A snapshot's 3-month rank is a trailing-window statistic; pairing it
    // with the *next* snapshot's own rank would mostly measure how much
    // two 92%-overlapping 63-day windows agree with each other, not real
    // persistence. Instead each pair compares this week's rank against the
    // realized forward return *to* the next snapshot — a window that
    // shares no trading days with the rank that predicts it.
    const store = getRelativeStrengthStore();
    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];

    const generatedAt = new Date().toISOString();
    const todayDate = generatedAt.slice(0, 10);

    const prices = {};
    const rel3mRank = {};
    ranked.forEach((c) => { prices[c.symbol] = c.price; rel3mRank[c.symbol] = c.rank3M; });

    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push({ date: todayDate, spyPrice: round(spyPrice), prices, rel3mRank });
    const trimmedPoints = filtered.slice(-MAX_HISTORY_WEEKS);

    const persistencePairs = [];
    for (let i = 0; i + 1 < trimmedPoints.length; i++) {
      const prev = trimmedPoints[i];
      const cur = trimmedPoints[i + 1];
      if (!prev.spyPrice || !cur.spyPrice) continue;
      const forwardSpyRet = cur.spyPrice / prev.spyPrice - 1;
      for (const symbol of Object.keys(prev.rel3mRank || {})) {
        const rank = prev.rel3mRank[symbol];
        const prevPrice = prev.prices[symbol];
        const curPrice = cur.prices[symbol];
        if (!rank || !prevPrice || !curPrice) continue;
        const forwardStockRet = curPrice / prevPrice - 1;
        const y = relativeReturn(forwardStockRet, forwardSpyRet);
        if (y === null) continue;
        persistencePairs.push({ x: rank, y: round(y), symbol, fromDate: prev.date, toDate: cur.date });
      }
    }

    await store.setJSON(HISTORY_KEY, { points: trimmedPoints });

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      market,
      sectors,
      leaders,
      laggards,
      persistencePairs,
      weeksAccumulated: trimmedPoints.length,
      companies: allCompanies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        price: c.price,
        ret1M: c.ret1M,
        ret3M: c.ret3M,
        rel1M: c.rel1M,
        rel3M: c.rel3M,
        rank3M: c.rank3M,
        classification: c.classification,
      })),
    };

    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-relative-strength-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `${trimmedPoints.length} weekly snapshots retained, ${persistencePairs.length} persistence pairs`
    );

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("scheduled-relative-strength-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
