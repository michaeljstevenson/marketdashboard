// Scheduled Background Function (see [functions."scheduled-vol-risk-
// premium-background"] in netlify.toml) for the Volatility Risk Premium
// page: per S&P 500 constituent, how much volatility the options market is
// currently pricing in (implied volatility) vs. how much the stock has
// actually moved lately (realized volatility) — the site's first page built
// on Alpha Vantage's options-chain data (every other page is fundamentals-,
// price-return-, or technical-indicator-based). A different question from
// /volatility.html (VIX vs. S&P 500 realized volatility, index-level only,
// no per-stock cross-section) and /options-positioning.html (put/call
// ratio — directional sentiment, not the *magnitude* options are pricing
// in).
//
// Implied volatility: one HISTORICAL_OPTIONS call per company returns that
// day's full multi-expiration, multi-strike chain (thousands of rows for a
// heavily-optioned mega-cap — confirmed via a real test call: ~3,500 rows,
// ~65KB, for AAPL alone) WITH implied_volatility and delta already computed
// per contract, so no Black-Scholes solving is needed here. From that
// chain: pick the expiration closest to 30 calendar days out (within a
// 15–60 day band — outside that band the chain is either too short-dated to
// be a stable read or too far out to call "the market's near-term view",
// so the company is excluded rather than using a distorted comparison),
// then within that expiration pick the call contract whose delta is
// closest to 0.50 (the standard model-free way to locate the at-the-money
// strike without needing a separate spot-price lookup) — averaged with the
// same-strike put's IV when available, since put-call parity says they
// should be close and averaging cancels some single-quote noise. A company
// is excluded if no call lands within 0.15 of a 0.50 delta (a strike grid
// too sparse/illiquid to call anything "ATM" with confidence) — same
// "excluded, not distorted" convention as this site's other single-snapshot
// fundamentals pages.
//
// Realized volatility: NOT a second Alpha Vantage sweep. Daily closes come
// from Yahoo Finance (yahoo-client.js, the same helper scheduled-relative-
// strength-background.js and others already use, no quota/pacing concerns
// the way Alpha Vantage has), trimmed to the trailing 21 trading days (20
// daily log returns), standard-deviation annualized by sqrt(252). This
// keeps the page's actual Alpha Vantage cost to one ~503-call sweep of a
// single endpoint, the same shape/cost class as scheduled-rd-intensity-
// background.js and scheduled-rsi-reversal-background.js, even though two
// distinct data sources are involved.
//
// Volatility Risk Premium (VRP) = ATM implied vol − trailing realized vol,
// in percentage points. The well-documented finding in the options
// literature is that VRP is usually positive (options tend to overprice
// near-term risk) — this page tests whether that shows up cross-sectionally
// on this specific S&P 500 snapshot, and whether it's sector-concentrated.
//
// One-time snapshot, no recurring schedule — matches the convention this
// site has settled into for every full-universe page added since
// 2026-09-16. Re-run manually for a fresh pass.
//
// Reuses company name/sector from Sector Beeswarm's own weekly meta.json
// blob, same pattern as every other full-universe sweep in this codebase.
// Also does one optional, read-only cross-page read — Relative Strength
// Leaders/Laggards' own 3-month relative return — for this page's "does the
// market currently price richer volatility risk premium into names that
// have been lagging" test, with a graceful fallback (the test just doesn't
// render) if that blob isn't populated yet.
//
// ~503 sequential HISTORICAL_OPTIONS calls (one per constituent) at 1050ms
// spacing with a retry pass, same cadence as scheduled-rd-intensity-
// background.js and scheduled-rsi-reversal-background.js. The Yahoo daily-
// history fetch for each company's realized vol happens inside the same
// per-symbol pass (yahoo-client.js has its own retry/backoff and isn't
// subject to Alpha Vantage's rate limit) rather than as a second pass.

const { getVolRiskPremiumStore, BLOB_KEY } = require("./vol-risk-premium-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");
const { fetchDailyHistory } = require("./yahoo-client");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const TARGET_DAYS_OUT = 30;
const MIN_DAYS_OUT = 15;
const MAX_DAYS_OUT = 60;
const MAX_ATM_DELTA_DIFF = 0.15; // call delta must land within 0.35–0.65 to count as "ATM"
const RV_WINDOW = 20; // trading days of daily log returns (21 closes)
const TRADING_DAYS_PER_YEAR = 252;
const LEADERBOARD_COUNT = 15;
const MIN_SECTOR_N = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

async function fetchOptionsChain(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=HISTORICAL_OPTIONS&symbol=${symbol}&datatype=json&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.data;
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);
  return rows;
}

// Picks the expiration closest to TARGET_DAYS_OUT (within [MIN_DAYS_OUT,
// MAX_DAYS_OUT]) and, within it, the call contract whose delta is closest
// to 0.50 — the model-free "at the money" contract, no separate spot-price
// lookup needed. Averages with the same-strike put's IV when available.
// Returns null (excluded) if the chain has no expiration in band, or no
// call within MAX_ATM_DELTA_DIFF of a 0.50 delta.
function computeAtmIv(rows) {
  if (!rows.length) return null;
  const asOfDate = rows[0].date;
  const asOf = new Date(asOfDate);
  if (isNaN(asOf.getTime())) return null;

  const byExpiration = new Map();
  for (const r of rows) {
    if (!byExpiration.has(r.expiration)) byExpiration.set(r.expiration, []);
    byExpiration.get(r.expiration).push(r);
  }

  let bestExp = null;
  let bestDiff = Infinity;
  let bestDays = null;
  for (const expiration of byExpiration.keys()) {
    const days = (new Date(expiration) - asOf) / 86400000;
    if (!Number.isFinite(days) || days < MIN_DAYS_OUT || days > MAX_DAYS_OUT) continue;
    const diff = Math.abs(days - TARGET_DAYS_OUT);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestExp = expiration;
      bestDays = days;
    }
  }
  if (!bestExp) return null;

  const contracts = byExpiration.get(bestExp);
  let bestCall = null;
  let bestCallDiff = Infinity;
  for (const c of contracts) {
    if (c.type !== "call") continue;
    const delta = num(c.delta);
    const iv = num(c.implied_volatility);
    if (delta === null || iv === null || iv <= 0) continue;
    const diff = Math.abs(delta - 0.5);
    if (diff < bestCallDiff) {
      bestCallDiff = diff;
      bestCall = c;
    }
  }
  if (!bestCall || bestCallDiff > MAX_ATM_DELTA_DIFF) return null;

  const callIv = num(bestCall.implied_volatility);
  const matchingPut = contracts.find((c) => c.type === "put" && c.strike === bestCall.strike);
  const putIv = matchingPut ? num(matchingPut.implied_volatility) : null;
  const atmIv = putIv !== null && putIv > 0 ? (callIv + putIv) / 2 : callIv;
  if (!Number.isFinite(atmIv) || atmIv <= 0) return null;

  return {
    atmIv,
    daysToExpiry: Math.round(bestDays),
    expiration: bestExp,
    strike: num(bestCall.strike),
    asOfDate,
  };
}

// 20-trading-day realized volatility from Yahoo daily closes: standard
// deviation of daily log returns, annualized by sqrt(252). Excluded (not
// fabricated) if there isn't a clean trailing window — a recent IPO, a
// halted/delisted name, or a Yahoo fetch failure.
async function computeRealizedVol(symbol) {
  const history = await fetchDailyHistory(symbol);
  const closes = history.slice(-(RV_WINDOW + 1));
  if (closes.length < RV_WINDOW + 1) return null;
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1].close;
    const cur = closes[i].close;
    if (!prev || !cur || prev <= 0 || cur <= 0) continue;
    const r = Math.log(cur / prev);
    if (Number.isFinite(r)) logReturns.push(r);
  }
  if (logReturns.length < RV_WINDOW) return null;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  const dailyVol = Math.sqrt(variance);
  return dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

exports.handler = async () => {
  console.log(`scheduled-vol-risk-premium-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let rel3MBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) if (c.rel3M !== null && c.rel3M !== undefined) rel3MBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-vol-risk-premium-background: could not read relative-strength blob, continuing without the VRP-vs-relative-return test:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    const results = new Map();
    let excludedNoAtm = 0;
    let excludedNoRv = 0;

    async function fetchInto(symbol) {
      try {
        const rows = await fetchOptionsChain(apiKey, symbol);
        const atm = computeAtmIv(rows);
        if (!atm) {
          excludedNoAtm++;
          return true; // fetched fine, just no usable ATM contract — not a failure to retry
        }
        const realizedVol = await computeRealizedVol(symbol).catch(() => null);
        if (realizedVol === null) {
          excludedNoRv++;
          return true;
        }
        results.set(symbol, { ...atm, realizedVol });
        return true;
      } catch (err) {
        console.error(`scheduled-vol-risk-premium-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-vol-risk-premium-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(
      `scheduled-vol-risk-premium-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers ` +
      `(${excludedNoAtm} excluded for no usable ATM contract, ${excludedNoRv} excluded for no usable realized-vol window)`
    );
    if (results.size === 0) throw new Error("Every ticker failed or was excluded — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, entry] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const atmIvPct = entry.atmIv * 100;
      const realizedVolPct = entry.realizedVol * 100;
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        atmIv: round(atmIvPct),
        realizedVol: round(realizedVolPct),
        vrp: round(atmIvPct - realizedVolPct),
        daysToExpiry: entry.daysToExpiry,
        expiration: entry.expiration,
        asOfDate: entry.asOfDate,
        rel3M: rel3MBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with both a usable ATM IV and sector metadata");

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianAtmIv: round(median(inSector.map((c) => c.atmIv))),
          medianRealizedVol: round(median(inSector.map((c) => c.realizedVol))),
          medianVrp: round(median(inSector.map((c) => c.vrp))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianAtmIv: round(median(companies.map((c) => c.atmIv))),
      medianRealizedVol: round(median(companies.map((c) => c.realizedVol))),
      medianVrp: round(median(companies.map((c) => c.vrp))),
      pctPositiveVrp: round((companies.filter((c) => c.vrp > 0).length / companies.length) * 100, 1),
      medianDaysToExpiry: round(median(companies.map((c) => c.daysToExpiry)), 0),
    };

    const richestVrp = [...companies].sort((a, b) => b.vrp - a.vrp).slice(0, LEADERBOARD_COUNT);
    const cheapestVrp = [...companies].sort((a, b) => a.vrp - b.vrp).slice(0, LEADERBOARD_COUNT);

    const ivVsRvPairs = companies.map((c) => ({ x: c.realizedVol, y: c.atmIv, symbol: c.symbol }));
    const vrpVsRel3mPairs = hasRel3M
      ? companies.filter((c) => c.rel3M !== null).map((c) => ({ x: c.vrp, y: c.rel3M, symbol: c.symbol }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      excludedNoAtm,
      excludedNoRv,
      hasRel3M,
      market,
      sectors,
      richestVrp,
      cheapestVrp,
      ivVsRvPairs,
      vrpVsRel3mPairs,
      companies,
    };

    await getVolRiskPremiumStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-vol-risk-premium-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-vol-risk-premium-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
