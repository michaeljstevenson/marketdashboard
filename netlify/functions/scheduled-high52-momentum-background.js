// Scheduled Background Function (see [functions."scheduled-high52-momentum-
// background"] in netlify.toml) for the 52-Week High Momentum page. Sweeps
// Alpha Vantage's OVERVIEW endpoint (function=OVERVIEW) across the full
// S&P 500 for the 52WeekHigh/52WeekLow fields — a single-endpoint sweep
// (~503 calls), same shape/cost as scheduled-rd-intensity-background.js and
// scheduled-rsi-reversal-background.js.
//
// NOTE ON WHERE THIS PAGE CAME FROM: this page replaces an originally
// planned "Workforce Productivity — Revenue per Employee" page. That idea
// turned out to be a confirmed dead end: real test calls against
// COMPANY_OVERVIEW for five different S&P 500 constituents (AAPL, IBM,
// WMT, NVDA, CRWD), plus a check of the endpoint's own tool schema, showed
// no FullTimeEmployees field (or any employee-count field at all) is
// present in this account's OVERVIEW response — not a naming quirk like
// past OVERVIEW field-name shifts on this site, a genuine absence. SEC
// EDGAR's XBRL company-facts API (the standard free alternative for
// per-company headcount, via the dei:EntityNumberOfEmployees tag) was
// identified as a possible substitute but could not be verified with a
// real test call because this sandbox's network egress policy blocks
// data.sec.gov outright — so, per this codebase's "no fabricated data,
// verify real field names/shapes before shipping" conventions, that
// substitution was left for a future session with unrestricted network
// access rather than built here on an unverified schema. See
// ROUTINE_BRIEF.md's "Already attempted, skipped" entry for the full
// account. This page (52-Week High Momentum) was built instead as this
// session's third fresh, off-list Equities idea, reusing the same
// confirmed-real OVERVIEW fields (52WeekHigh/52WeekLow) already used
// elsewhere on this site (scheduled-equity-risk-premium-background.js).
//
// Tests the "52-week high effect" (George & Hwang, 2004): does a stock
// trading near its 52-week high tend to keep outperforming, rather than
// mean-revert? That's the opposite-signed cousin of
// scheduled-rsi-reversal-background.js's short-term-reversal test on this
// same site — reversal expects extremes to revert, the 52-week-high effect
// expects (a specific kind of) extreme to continue. Needs a per-company
// range-position DECILE recorded alongside that company's realized forward
// return over the following week, joined across successive weekly
// snapshots — so, like RSI Mean-Reversion, this is a real recurring weekly
// job, not a one-time snapshot.
//
// Forward returns are NOT computed from a second price sweep, and neither
// is "current price" for the range-position calculation itself: both reuse
// scheduled-relative-strength-background.js's own weekly history.json (its
// {date, spyPrice, prices} points already exist for that page's own
// rank-persistence test), read (not written) here and copied into this
// job's own weekly history point, tagged with the source point's own date
// (priceAsOf) — identical pattern to scheduled-rsi-reversal-background.js.
// Consecutive weekly points in *this* job's own history are then diffed
// the same way. A transition is skipped (not recorded as a fabricated
// zero-return week) if the two points share the same priceAsOf.
//
// Reuses company name/sector from Sector Beeswarm's own weekly meta.json
// blob, same pattern as every other full-universe sweep in this codebase.
//
// Weekly, Saturday — see netlify.toml for the exact slot and why. Pacing:
// ~503 sequential calls at 1050ms with a retry pass, same cadence as
// scheduled-rsi-reversal-background.js and scheduled-rd-intensity-background.js.

const { getHigh52Store, LATEST_KEY, HISTORY_KEY } = require("./high52-momentum-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, HISTORY_KEY: RS_HISTORY_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const NEAR_HIGH_THRESHOLD = 90; // rangePos >= this counts as "near the 52-week high"
const NEAR_LOW_THRESHOLD = 10; // rangePos <= this counts as "near the 52-week low"
const LEADERBOARD_COUNT = 15;
const MIN_SECTOR_N = 3;
const MAX_HISTORY_WEEKS = 20; // ~5 months of weekly snapshots, same retention as rsi-reversal's own history

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

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on several endpoints — same gotcha guarded against
// elsewhere in this codebase (e.g. scheduled-rd-intensity-background.js's
// own num() helper).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Same compounding-consistent excess-return construction used by
// scheduled-relative-strength-background.js and
// scheduled-rsi-reversal-background.js: (1+stock)/(1+benchmark) - 1, in
// percentage points.
function relativeReturn(stockRet, benchRet) {
  if (stockRet === null || benchRet === null || !Number.isFinite(stockRet) || !Number.isFinite(benchRet)) return null;
  return ((1 + stockRet) / (1 + benchRet) - 1) * 100;
}

async function fetchHighLow(apiKey, symbol) {
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
  if (!payload.Symbol) return null; // empty body — no OVERVIEW data for this symbol
  const high = num(payload["52WeekHigh"]);
  const low = num(payload["52WeekLow"]);
  if (high === null || low === null || high <= low) return null; // excluded, not fabricated — see computeRangePos below
  return { high, low };
}

// Position within the trailing 52-week price range, 0 (at the 52-week low)
// to 100 (at the 52-week high). Alpha Vantage's 52WeekHigh/52WeekLow are
// refreshed "generally the same day a company reports its latest earnings
// and financials" per its own docs, not necessarily same-day as the price
// snapshot this job joins against (Relative Strength Leaders/Laggards'
// weekly price history) — so a live price can occasionally sit fractionally
// outside a slightly-stale [low, high] band. Clipped to [0, 100] rather
// than excluded in that case, since it's still a meaningful "at/near the
// edge of the range" reading.
function computeRangePos(price, low, high) {
  if (price === null || low === null || high === null || high <= low) return null;
  const raw = ((price - low) / (high - low)) * 100;
  return Math.max(0, Math.min(100, raw));
}

// Ranks ascending by range position (1 = lowest/nearest the 52-week low)
// and splits into 10 equal-count deciles (10 = nearest the 52-week high) —
// same construction as scheduled-rsi-reversal-background.js's assignDeciles.
function assignDeciles(companies) {
  const ranked = [...companies].sort((a, b) => a.rangePos - b.rangePos);
  const n = ranked.length;
  ranked.forEach((c, i) => {
    c.decile = Math.min(10, Math.floor((i * 10) / n) + 1);
  });
}

// Diffs consecutive points in this job's own history to build the
// {decile, rangePos, forwardRelReturn} pairs the momentum test runs on. A
// pair is skipped (not recorded as a zero-return week) when the two points
// share the same priceAsOf — meaning scheduled-relative-strength-background
// hasn't produced a fresh weekly snapshot between them, so no real forward
// return exists to measure yet. Mirrors
// scheduled-rsi-reversal-background.js's buildReversalPairs exactly, with
// "rangePos" swapped in for "rsi".
function buildMomentumPairs(points) {
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
    for (const symbol of Object.keys(prev.rangePos || {})) {
      const rangePosVal = prev.rangePos[symbol];
      const decile = prev.decile[symbol];
      const prevPrice = prev.prices[symbol];
      const curPrice = cur.prices[symbol];
      if (rangePosVal === undefined || !decile || !prevPrice || !curPrice) continue;
      const forwardStockRet = curPrice / prevPrice - 1;
      const y = relativeReturn(forwardStockRet, forwardSpyRet);
      if (y === null) continue;
      pairs.push({ symbol, x: rangePosVal, decile, y: round(y), fromDate: prev.date, toDate: cur.date });
    }
  }
  return { pairs, skippedStalePrice };
}

exports.handler = async () => {
  console.log(`scheduled-high52-momentum-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
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
      console.error("scheduled-high52-momentum-background: could not read relative-strength history, continuing without a price snapshot this run:", err.message);
    }
    const prices = priceSnapshot ? priceSnapshot.prices || {} : {};

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const entry = await fetchHighLow(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-high52-momentum-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-high52-momentum-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-high52-momentum-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, entry] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const price = prices[symbol];
      const rangePos = price !== undefined ? computeRangePos(price, entry.low, entry.high) : null;
      if (rangePos === null) continue; // no usable current price this run — excluded, not fabricated
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        high: round(entry.high),
        low: round(entry.low),
        price: round(price),
        rangePos: round(rangePos),
        pctFromHigh: round(((entry.high - price) / entry.high) * 100),
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with a usable 52-week high/low, current price, and sector metadata");

    assignDeciles(companies);

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianRangePos: round(median(inSector.map((c) => c.rangePos))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianRangePos: round(median(companies.map((c) => c.rangePos))),
      nearHighCount: companies.filter((c) => c.rangePos >= NEAR_HIGH_THRESHOLD).length,
      nearLowCount: companies.filter((c) => c.rangePos <= NEAR_LOW_THRESHOLD).length,
    };

    const nearHighLeaders = companies
      .filter((c) => c.rangePos >= NEAR_HIGH_THRESHOLD)
      .sort((a, b) => b.rangePos - a.rangePos)
      .slice(0, LEADERBOARD_COUNT);
    const nearLowLeaders = companies
      .filter((c) => c.rangePos <= NEAR_LOW_THRESHOLD)
      .sort((a, b) => a.rangePos - b.rangePos)
      .slice(0, LEADERBOARD_COUNT);

    // ---- Weekly history + 52-week-high-effect test ----
    const store = getHigh52Store();
    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];

    const generatedAt = new Date().toISOString();
    const todayDate = generatedAt.slice(0, 10);

    const rangePosBySymbol = {};
    const decileBySymbol = {};
    companies.forEach((c) => { rangePosBySymbol[c.symbol] = c.rangePos; decileBySymbol[c.symbol] = c.decile; });

    const newPoint = {
      date: todayDate,
      priceAsOf: priceSnapshot ? priceSnapshot.date : null,
      spyPrice: priceSnapshot ? priceSnapshot.spyPrice : null,
      prices: priceSnapshot ? priceSnapshot.prices : {},
      rangePos: rangePosBySymbol,
      decile: decileBySymbol,
    };

    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push(newPoint);
    const trimmedPoints = filtered.slice(-MAX_HISTORY_WEEKS);

    const { pairs: momentumPairs, skippedStalePrice } = buildMomentumPairs(trimmedPoints);

    await store.setJSON(HISTORY_KEY, { points: trimmedPoints });

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasPriceSnapshot: !!priceSnapshot,
      market,
      sectors,
      nearHighLeaders,
      nearLowLeaders,
      weeksAccumulated: trimmedPoints.length,
      skippedStalePriceTransitions: skippedStalePrice,
      momentumPairs,
      companies: companies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        high: c.high,
        low: c.low,
        price: c.price,
        rangePos: c.rangePos,
        pctFromHigh: c.pctFromHigh,
        decile: c.decile,
      })),
    };

    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-high52-momentum-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `${trimmedPoints.length} weekly snapshots retained, ${momentumPairs.length} momentum pairs (${skippedStalePrice} transition(s) skipped for a stale price source)`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length, momentumPairs: momentumPairs.length }) };
  } catch (err) {
    console.error(`scheduled-high52-momentum-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
