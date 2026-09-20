// Scheduled Background Function (see [functions."scheduled-equity-risk-premium-background"]
// in netlify.toml) that sweeps Alpha Vantage's OVERVIEW across the
// full S&P 500 (BREADTH_CONSTITUENTS) plus a single TREASURY_YIELD call,
// and computes a simple "earnings yield minus the risk-free rate" equity
// risk premium proxy per stock and per sector — the "Equity Risk Premium
// by Sector" page.
//
// This is a deliberately different, much simpler construction than
// /implied-erp (Damodaran's FCFE/DCF-based model, sourced not locally
// computed): earnings yield (1 / trailing P/E) minus the 10-year Treasury
// yield is the classic "Fed model" comparison — easy to compute
// cross-sectionally for 500 names from data Alpha Vantage already
// provides, but a well-known simplification (it ignores growth
// expectations and share-buyback/reinvestment differences, and is
// sensitive to inflation regime in ways real equity risk premia arguably
// shouldn't be). The page's own methodology section is explicit about
// this rather than implying it's a competing "true" ERP number.
//
// Reads name/sector directly off each stock's own OVERVIEW response
// (normalizeSector, the same GICS-normalization helper
// scheduled-beeswarm-meta-background.js uses) rather than joining against
// that job's meta.json blob — this job already pays for a full OVERVIEW
// sweep for PERatio/Beta, so pulling Name/Sector from the same response
// avoids a second cross-job dependency for no extra Alpha Vantage cost.
//
// ~504 sequential calls (503 constituents + 1 TREASURY_YIELD), 1050ms
// apart with a retry pass — same pacing proven at this exact scale by
// scheduled-beeswarm-meta-background.js's own OVERVIEW sweep.

const { getErpStore, LATEST_KEY, HISTORY_KEY } = require("./equity-risk-premium-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LEADERBOARD_COUNT = 15;
const MAX_HISTORY_POINTS = 104; // ~2 years of weekly snapshots

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

async function fetchRiskFreeRate(apiKey) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=TREASURY_YIELD&interval=monthly&maturity=10year&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  for (const point of data) {
    const v = parseFloat(point.value);
    if (Number.isFinite(v)) return { rate: v, date: point.date };
  }
  throw new Error("no usable TREASURY_YIELD data point found");
}

async function fetchOverview(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = await res.json();
  if (p.Note || p.Information || p.error) throw new Error(p.Note || p.Information || JSON.stringify(p.error));
  if (!p.Symbol) return null; // empty body — no data for this symbol
  return {
    name: p.Name || symbol,
    sector: normalizeSector(symbol, p.Sector),
    peRatio: parseFloat(p.PERatio),
    beta: parseFloat(p.Beta),
  };
}

exports.handler = async () => {
  console.log(`scheduled-equity-risk-premium-background: starting, ${BREADTH_CONSTITUENTS.length} tickers + TREASURY_YIELD`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    let riskFree = null;
    for (let attempt = 0; attempt < 3 && !riskFree; attempt++) {
      try {
        riskFree = await fetchRiskFreeRate(apiKey);
      } catch (err) {
        console.error(`scheduled-equity-risk-premium-background: TREASURY_YIELD fetch failed (attempt ${attempt + 1}): ${err.message}`);
        await sleep(5000);
      }
    }
    if (!riskFree) throw new Error("Could not fetch TREASURY_YIELD after 3 attempts");
    await sleep(1050);

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const ov = await fetchOverview(apiKey, symbol);
        if (ov) results.set(symbol, ov);
        return true;
      } catch (err) {
        console.error(`scheduled-equity-risk-premium-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-equity-risk-premium-background: retry pass for ${todo.length} ticker(s)`);
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

    const companies = [];
    for (const [symbol, ov] of results.entries()) {
      if (!ov.sector) continue;
      // Negative or zero trailing EPS makes P/E (and therefore earnings
      // yield) meaningless, not just noisy — excluded rather than clamped.
      const validPe = Number.isFinite(ov.peRatio) && ov.peRatio > 0;
      const earningsYield = validPe ? (100 / ov.peRatio) : null;
      const erp = earningsYield !== null ? earningsYield - riskFree.rate : null;
      companies.push({
        symbol,
        name: ov.name,
        sector: ov.sector,
        peRatio: round(ov.peRatio),
        earningsYield: round(earningsYield),
        erp: round(erp),
        beta: Number.isFinite(ov.beta) ? round(ov.beta) : null,
      });
    }

    const ranked = companies.filter((c) => c.erp !== null).sort((a, b) => b.erp - a.erp);
    ranked.forEach((c, i) => { c.rankErp = i + 1; });
    const unranked = companies.filter((c) => c.erp === null);
    unranked.forEach((c) => { c.rankErp = null; });
    const allCompanies = [...ranked, ...unranked];

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = ranked.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianErp: round(median(inSector.map((c) => c.erp))),
          avgErp: round(mean(inSector.map((c) => c.erp))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: ranked.length,
      riskFreeRate: round(riskFree.rate),
      riskFreeAsOf: riskFree.date,
      medianErp: round(median(ranked.map((c) => c.erp))),
      avgErp: round(mean(ranked.map((c) => c.erp))),
    };

    const leaders = ranked.slice(0, LEADERBOARD_COUNT);
    const laggards = ranked.slice(-LEADERBOARD_COUNT).reverse();

    // ERP-vs-beta pairs: does the market actually price higher-beta stocks
    // with a higher earnings-yield premium, the way a rational risk-return
    // tradeoff would predict? Single-snapshot cross-section — no need to
    // wait on accumulated history, unlike a forward-return test.
    const betaPairs = ranked
      .filter((c) => c.beta !== null)
      .map((c) => ({ x: c.beta, y: c.erp, symbol: c.symbol }));

    const store = getErpStore();
    const generatedAt = new Date().toISOString();
    const todayDate = generatedAt.slice(0, 10);

    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];
    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push({ date: todayDate, medianErp: market.medianErp, avgErp: market.avgErp, riskFreeRate: market.riskFreeRate });
    const trimmedPoints = filtered.slice(-MAX_HISTORY_POINTS);
    await store.setJSON(HISTORY_KEY, { points: trimmedPoints });

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      market,
      sectors,
      leaders,
      laggards,
      betaPairs,
      history: trimmedPoints,
      companies: allCompanies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        peRatio: c.peRatio,
        earningsYield: c.earningsYield,
        beta: c.beta,
        erp: c.erp,
        rankErp: c.rankErp,
      })),
    };

    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-equity-risk-premium-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `risk-free=${market.riskFreeRate}%, ${trimmedPoints.length} history points, ${betaPairs.length} beta pairs`
    );

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("scheduled-equity-risk-premium-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
