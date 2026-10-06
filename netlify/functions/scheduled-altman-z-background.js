// Scheduled Background Function (see [functions."scheduled-altman-z-
// background"] in netlify.toml) for the Altman Z-Score page — the classic
// Altman (1968) bankruptcy/financial-distress screen, applied across the
// full S&P 500. Sweeps Alpha Vantage's INCOME_STATEMENT and BALANCE_SHEET
// endpoints (annual, one report per company — the model is a point-in-time
// solvency snapshot, not a trailing-twelve-month flow figure, so a single
// fiscal year's statements are what the original model actually uses).
//
// Deliberately its own independent ~1006-call sweep rather than reading
// scheduled-margin-leverage-background.js's checkpoint: that checkpoint's
// annual KEEP_FIELDS carry totalAssets/totalCurrentAssets/
// totalCurrentLiabilities but not retainedEarnings or totalLiabilities,
// which this page's X2 and X4 terms need — same "extending someone else's
// checkpoint is riskier than a second sweep" reasoning scheduled-roic-wacc-
// background.js and scheduled-cash-conversion-cycle-background.js already
// used for the same two endpoints.
//
// Reuses company name/sector/market cap from the Sector Beeswarm page's
// own weekly meta.json blob — market cap is Alpha Vantage's
// MarketCapitalization field from a COMPANY_OVERVIEW sweep that job already
// pays for, so this page needs no OVERVIEW call of its own for X4 (market
// value of equity).
//
// Also does two *optional*, read-only cross-page reads — each with a
// graceful fallback if the blob isn't populated yet:
//   - equity-risk-premium's latest.json, for each company's Beta, to test
//     whether the market's own risk pricing lines up with fundamental
//     distress risk.
//   - relative-strength's latest.json, for each company's 3-month relative
//     price return, to test whether distress risk shows up in recent price
//     action.

const { getAltmanZStore, BLOB_KEY, CHECKPOINT_KEY } = require("./altman-z-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getErpStore, LATEST_KEY: ERP_LATEST_KEY } = require("./equity-risk-premium-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3;
// Financials and Real Estate are excluded from the model itself (not just a
// display filter): a bank's or REIT's balance sheet — deposits/float as
// "liabilities," leveraged real property as the asset base — isn't the kind
// of capital structure the 1968 model was built to read, and total-
// liabilities-heavy sectors like these would otherwise dominate the
// "most distressed" leaderboard for reasons that have nothing to do with
// financial distress. Same convention as /cash-conversion-cycle.html
// excluding sectors where its own inputs aren't meaningful.
const EXCLUDED_SECTORS = new Set(["Financials", "Real Estate"]);

// Two calls per company (~1006 total) — same pacing tradeoff as scheduled-
// roic-wacc-background.js and scheduled-cash-conversion-cycle-background.js.
const CALL_SLEEP_MS = 750;
const RUN_BUDGET_MS = 12 * 60 * 1000;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 120;

const KEEP_FIELDS = {
  INCOME_STATEMENT: ["fiscalDateEnding", "totalRevenue", "ebit", "operatingIncome"],
  BALANCE_SHEET: ["fiscalDateEnding", "totalAssets", "totalCurrentAssets", "totalCurrentLiabilities", "totalLiabilities", "retainedEarnings"],
};
const pick = (rows, keys) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on several fundamentals endpoints — same gotcha guarded
// against elsewhere in this codebase (e.g. scheduled-roic-wacc-
// background.js's num() helper).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function ebitOf(inc) {
  return num(inc.ebit) ?? num(inc.operatingIncome);
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function zoneOf(z) {
  if (z > 2.99) return "Safe";
  if (z >= 1.81) return "Grey Zone";
  return "Distress";
}

async function fetchAnnual(apiKey, fn, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=${fn}&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.annualReports;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${fn} unexpected response shape for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  return pick(rows.slice(0, 1), KEEP_FIELDS[fn])[0]; // most recent fiscal year only
}

// Computes the five Altman (1968) ratios and the Z-Score for one company.
// Returns null when the latest annual balance sheet and income statement
// don't share a fiscal year end, or when a required input is missing/
// non-positive in a way that would make the ratio meaningless (zero/
// negative total assets, zero total liabilities, no market cap on file).
function computeZ(inc, bal, marketCap) {
  if (!inc || !bal || inc.fiscalDateEnding !== bal.fiscalDateEnding) return null;

  const totalAssets = num(bal.totalAssets);
  const totalCurrentAssets = num(bal.totalCurrentAssets);
  const totalCurrentLiabilities = num(bal.totalCurrentLiabilities);
  const totalLiabilities = num(bal.totalLiabilities);
  const retainedEarnings = num(bal.retainedEarnings);
  const ebit = ebitOf(inc);
  const totalRevenue = num(inc.totalRevenue);

  if (totalAssets === null || totalAssets <= 0) return null;
  if (totalLiabilities === null || totalLiabilities <= 0) return null;
  if (totalCurrentAssets === null || totalCurrentLiabilities === null) return null;
  if (retainedEarnings === null || ebit === null || totalRevenue === null) return null;
  if (marketCap === null || marketCap <= 0) return null;

  const workingCapital = totalCurrentAssets - totalCurrentLiabilities;
  const x1 = workingCapital / totalAssets;
  const x2 = retainedEarnings / totalAssets;
  const x3 = ebit / totalAssets;
  const x4 = marketCap / totalLiabilities;
  const x5 = totalRevenue / totalAssets;
  const z = 1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * x4 + 1.0 * x5;

  return {
    fiscalYearEnding: bal.fiscalDateEnding,
    z,
    zone: zoneOf(z),
    x1, x2, x3, x4, x5,
    workingCapital, totalAssets, totalLiabilities, retainedEarnings, ebit, totalRevenue, marketCap,
  };
}

exports.handler = async () => {
  console.log(`scheduled-altman-z-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    // Optional cross-page reads — beta and 3-month relative return. Both
    // degrade gracefully rather than failing this job.
    let betaBySymbol = {};
    try {
      const erpLatest = await getErpStore().get(ERP_LATEST_KEY, { type: "json" });
      if (erpLatest && Array.isArray(erpLatest.companies)) {
        for (const c of erpLatest.companies) if (c.beta !== null && c.beta !== undefined) betaBySymbol[c.symbol] = c.beta;
      }
    } catch (err) {
      console.error("scheduled-altman-z-background: could not read equity-risk-premium blob, skipping the Z-vs-beta test:", err.message);
    }
    const hasBetaData = Object.keys(betaBySymbol).length > 0;

    let rel3MBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) if (c.rel3M !== null && c.rel3M !== undefined) rel3MBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-altman-z-background: could not read relative-strength blob, skipping the Z-vs-return test:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    const startedAt = Date.now();
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
    const store = getAltmanZStore();
    const saved = await store.get(CHECKPOINT_KEY, { type: "json" });
    const resume = !!(saved && !saved.complete && Date.now() - Date.parse(saved.startedAt) < CHECKPOINT_MAX_AGE_MS);
    const cycleStartedAt = resume ? saved.startedAt : new Date().toISOString();
    const results = new Map(resume ? Object.entries(saved.results) : []); // symbol -> { income, balance }
    if (resume) console.log(`scheduled-altman-z-background: resuming checkpoint with ${results.size} ticker(s) already fetched`);

    const failures = resume ? { ...(saved.failed || {}) } : {};
    const saveCheckpoint = (complete) =>
      store.setJSON(CHECKPOINT_KEY, { startedAt: cycleStartedAt, complete, results: Object.fromEntries(results), failed: failures });

    async function fetchInto(symbol) {
      try {
        const income = await fetchAnnual(apiKey, "INCOME_STATEMENT", symbol);
        await sleep(CALL_SLEEP_MS);
        const balance = await fetchAnnual(apiKey, "BALANCE_SHEET", symbol);
        delete failures[symbol];
        results.set(symbol, { income, balance });
        return true;
      } catch (err) {
        console.error(`scheduled-altman-z-background: ${symbol} failed: ${err.message}`);
        failures[symbol] = String(err.message).slice(0, 200);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = BREADTH_CONSTITUENTS.filter((s) => !results.has(s));
    let stoppedForTime = false;
    let sinceCheckpoint = 0;
    for (let pass = 0; pass < 2 && todo.length && !stoppedForTime; pass++) {
      if (pass > 0) {
        console.log(`scheduled-altman-z-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(45000);
      }
      const missed = [];
      for (const symbol of todo) {
        if (outOfTime()) { stoppedForTime = true; break; }
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        if (got && ++sinceCheckpoint >= CHECKPOINT_EVERY) { await saveCheckpoint(false); sinceCheckpoint = 0; }
        await sleep(CALL_SLEEP_MS);
      }
      todo = missed;
    }
    await saveCheckpoint(!stoppedForTime);
    if (stoppedForTime) console.log(`scheduled-altman-z-background: out of time with ${results.size}/${BREADTH_CONSTITUENTS.length} fetched — run again to finish`);

    console.log(`scheduled-altman-z-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, { income, balance }] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      if (EXCLUDED_SECTORS.has(m.sector)) continue;
      const metrics = computeZ(income, balance, m.marketCap ?? null);
      if (!metrics) continue;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalYearEnding: metrics.fiscalYearEnding,
        z: round(metrics.z),
        zone: metrics.zone,
        x1: round(metrics.x1, 3),
        x2: round(metrics.x2, 3),
        x3: round(metrics.x3, 3),
        x4: round(metrics.x4, 3),
        x5: round(metrics.x5, 3),
        beta: betaBySymbol[symbol] ?? null,
        rel3M: rel3MBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable statement history and sector metadata");

    const rankedByZ = [...companies].filter((c) => c.z !== null).sort((a, b) => b.z - a.z);
    rankedByZ.forEach((c, i) => { c.rankZ = i + 1; });

    const sectors = SECTOR_ORDER
      .filter((sector) => !EXCLUDED_SECTORS.has(sector))
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianZ: round(median(inSector.map((c) => c.z))),
          distressPct: round((inSector.filter((c) => c.zone === "Distress").length / inSector.length) * 100, 1),
          safePct: round((inSector.filter((c) => c.zone === "Safe").length / inSector.length) * 100, 1),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianZ: round(median(companies.map((c) => c.z))),
      distressPct: round((companies.filter((c) => c.zone === "Distress").length / companies.length) * 100, 1),
      greyPct: round((companies.filter((c) => c.zone === "Grey Zone").length / companies.length) * 100, 1),
      safePct: round((companies.filter((c) => c.zone === "Safe").length / companies.length) * 100, 1),
    };

    const safest = rankedByZ.slice(0, NOTABLE_COUNT);
    const mostDistressed = rankedByZ.slice(-NOTABLE_COUNT).reverse();

    const zBetaPairs = hasBetaData
      ? companies.filter((c) => c.beta !== null && c.z !== null).map((c) => ({ x: c.beta, y: c.z, symbol: c.symbol }))
      : [];
    const zRel3mPairs = hasRel3M
      ? companies.filter((c) => c.rel3M !== null && c.z !== null).map((c) => ({ x: c.z, y: c.rel3M, symbol: c.symbol }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      partial: stoppedForTime,
      hasBetaData,
      hasRel3M,
      excludedSectors: [...EXCLUDED_SECTORS],
      market,
      sectors,
      safest,
      mostDistressed,
      zBetaPairs,
      zRel3mPairs,
      companies,
    };

    if (stoppedForTime) {
      const published = await store.get(BLOB_KEY, { type: "json" });
      if (published && !published.partial) {
        console.log("scheduled-altman-z-background: partial run, keeping the last complete published snapshot until the next run finishes the cycle");
        return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, fetched: results.size, published: false }) };
      }
    }
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-altman-z-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial: stoppedForTime, fetched: results.size, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-altman-z-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
