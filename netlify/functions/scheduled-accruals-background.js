// Scheduled Background Function (see [functions."scheduled-accruals-
// background"] in netlify.toml) for the Earnings Quality via Accruals page —
// the Sloan (1996) "accrual anomaly" screen. Sweeps Alpha Vantage's
// CASH_FLOW and BALANCE_SHEET endpoints (quarterly) across the full S&P
// 500, the same two-statement sweep shape/cost as scheduled-roic-wacc-
// background.js and scheduled-cash-conversion-cycle-background.js (~1006
// calls). One-time snapshot, no schedule — matches this file's current
// convention for new full-universe Equities jobs (run manually via the
// Netlify dashboard "Run now").
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob, same pattern as every other full-universe sweep in this
// codebase. Also does one *optional*, read-only cross-page read — relative-
// strength's latest.json, for each company's 3-month relative price return,
// used only in this page's accrual-anomaly regression, not in the accrual
// math itself — with a graceful fallback if that blob isn't populated yet,
// so this job never hard-depends on another one-time-snapshot job having
// run first.

const { getAccrualsStore, BLOB_KEY, CHECKPOINT_KEY } = require("./accruals-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// The TTM window itself only needs 4 quarters of CASH_FLOW, but the Sloan
// averaging denominator needs a BALANCE_SHEET row ~4 quarters (1 year)
// before the latest one — fetch 6 of each so both statements line up even
// across the occasional reporting-date gap.
const QUARTERS_NEEDED = 6;
const PRIOR_ASSET_LAG = 4; // quarters back from the latest balance sheet for the averaging denominator
const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3;

// Same pacing tradeoff as scheduled-margin-leverage-background.js and
// scheduled-roic-wacc-background.js: two calls per company (~1006 total)
// needs pacing tight enough to leave room for a retry pass inside a
// Background Function's ~15-minute ceiling.
const CALL_SLEEP_MS = 750;
const RUN_BUDGET_MS = 12 * 60 * 1000;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 120;

const KEEP_FIELDS = {
  CASH_FLOW: ["fiscalDateEnding", "netIncome", "operatingCashflow"],
  BALANCE_SHEET: ["fiscalDateEnding", "totalAssets"],
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
// against elsewhere in this codebase (e.g. scheduled-margin-leverage-
// background.js's num() helper).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

async function fetchStatement(apiKey, fn, symbol) {
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
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) throw new Error(`${fn} unexpected response shape for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  return pick(rows.slice(0, QUARTERS_NEEDED), KEEP_FIELDS[fn]); // most-recent-first
}

// Computes the trailing-twelve-month Sloan total-accruals ratio for one
// company. Total accruals = TTM net income − TTM cash flow from operations,
// scaled by the average of total assets at the start and end of that TTM
// window (Sloan's own construction: average, not point-in-time, total
// assets — smooths out a one-off asset sale/acquisition that would
// otherwise swing the ratio on the denominator side alone).
//
// Returns null (excluded, not estimated) when there isn't a clean
// 4-consecutive-quarter CASH_FLOW window, or when the balance sheet ~4
// quarters before the latest one isn't available — a real, and reasonably
// common, coverage gap for names with a shorter Alpha Vantage history or a
// fiscal-calendar change, flagged in the page's methodology rather than
// papered over with a single-point-in-time asset base.
function computeCompanyMetrics(cfRows, balRows) {
  if (cfRows.length < 4) return null;
  const ttmWindow = cfRows.slice(0, 4);

  let ttmNetIncome = 0, ttmCFO = 0;
  for (const r of ttmWindow) {
    const ni = num(r.netIncome);
    const cfo = num(r.operatingCashflow);
    if (ni === null || cfo === null) return null; // need a complete TTM window for both figures
    ttmNetIncome += ni;
    ttmCFO += cfo;
  }

  const currentDate = ttmWindow[0].fiscalDateEnding;
  const balIdx = balRows.findIndex((r) => r.fiscalDateEnding === currentDate);
  if (balIdx === -1) return null; // no matching latest-quarter balance sheet
  const currentAssets = num(balRows[balIdx].totalAssets);

  const priorBal = balRows[balIdx + PRIOR_ASSET_LAG];
  if (!priorBal) return null; // missing prior-period balance sheet needed for the averaging denominator — excluded, see methodology
  const priorAssets = num(priorBal.totalAssets);

  if (currentAssets === null || priorAssets === null || currentAssets <= 0 || priorAssets <= 0) return null;

  const avgTotalAssets = (currentAssets + priorAssets) / 2;
  const totalAccruals = ttmNetIncome - ttmCFO;
  const accrualRatio = (totalAccruals / avgTotalAssets) * 100;

  return {
    fiscalQuarter: currentDate,
    priorFiscalQuarter: priorBal.fiscalDateEnding,
    ttmNetIncome,
    ttmCFO,
    totalAccruals,
    avgTotalAssets,
    accrualRatio,
  };
}

exports.handler = async () => {
  console.log(`scheduled-accruals-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    // Optional cross-page read — 3-month relative price return. Degrades
    // gracefully rather than failing this job.
    let rel3MBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) if (c.rel3M !== null && c.rel3M !== undefined) rel3MBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-accruals-background: could not read relative-strength blob, continuing without the accrual-anomaly test:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    const startedAt = Date.now();
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
    const store = getAccrualsStore();
    const saved = await store.get(CHECKPOINT_KEY, { type: "json" });
    const resume = !!(saved && !saved.complete && Date.now() - Date.parse(saved.startedAt) < CHECKPOINT_MAX_AGE_MS);
    const cycleStartedAt = resume ? saved.startedAt : new Date().toISOString();
    const results = new Map(resume ? Object.entries(saved.results) : []); // symbol -> { cf, bal }
    if (resume) console.log(`scheduled-accruals-background: resuming checkpoint with ${results.size} ticker(s) already fetched`);

    const failures = resume ? { ...(saved.failed || {}) } : {};
    const saveCheckpoint = (complete) =>
      store.setJSON(CHECKPOINT_KEY, { startedAt: cycleStartedAt, complete, results: Object.fromEntries(results), failed: failures });

    async function fetchInto(symbol) {
      try {
        const cf = await fetchStatement(apiKey, "CASH_FLOW", symbol);
        await sleep(CALL_SLEEP_MS);
        const bal = await fetchStatement(apiKey, "BALANCE_SHEET", symbol);
        delete failures[symbol];
        results.set(symbol, { cf, bal });
        return true;
      } catch (err) {
        console.error(`scheduled-accruals-background: ${symbol} failed: ${err.message}`);
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
        console.log(`scheduled-accruals-background: retry pass for ${todo.length} ticker(s)`);
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
    if (stoppedForTime) console.log(`scheduled-accruals-background: out of time with ${results.size}/${BREADTH_CONSTITUENTS.length} fetched — run again to finish`);

    console.log(`scheduled-accruals-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    let excludedForMissingPriorAssets = 0;
    const companies = [];
    for (const [symbol, { cf, bal }] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const metrics = computeCompanyMetrics(cf, bal);
      if (!metrics) {
        // Distinguishes "no complete TTM CASH_FLOW window" from the specific
        // documented edge case this page's own test harness exercises: a
        // company with fewer than PRIOR_ASSET_LAG+1 BALANCE_SHEET quarters
        // on file, so there's no prior-period total-assets figure to average
        // against. Both are excluded the same way (not estimated), but this
        // counter keeps the exclusion reason honest in the page/PR writeup.
        if (cf.length >= 4 && bal.filter((r) => num(r.totalAssets) !== null).length <= PRIOR_ASSET_LAG) {
          excludedForMissingPriorAssets++;
        }
        continue;
      }

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalQuarter: metrics.fiscalQuarter,
        priorFiscalQuarter: metrics.priorFiscalQuarter,
        accrualRatio: round(metrics.accrualRatio),
        ttmNetIncomeUsd: metrics.ttmNetIncome,
        ttmCfoUsd: metrics.ttmCFO,
        totalAccrualsUsd: metrics.totalAccruals,
        avgTotalAssetsUsd: metrics.avgTotalAssets,
        rel3M: rel3MBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable statement history and sector metadata");

    // Ascending: most-negative (most cash-backed) first, most-positive
    // (most aggressive) last.
    const rankedByAccrual = [...companies].filter((c) => c.accrualRatio !== null).sort((a, b) => a.accrualRatio - b.accrualRatio);
    rankedByAccrual.forEach((c, i) => { c.rankAccrual = i + 1; });

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianAccrualRatio: round(median(inSector.map((c) => c.accrualRatio))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianAccrualRatio: round(median(companies.map((c) => c.accrualRatio))),
      cashBackedPct: round((companies.filter((c) => c.accrualRatio < 0).length / companies.length) * 100, 1),
      aggressivePct: round((companies.filter((c) => c.accrualRatio > 0).length / companies.length) * 100, 1),
    };

    const mostCashBacked = rankedByAccrual.slice(0, NOTABLE_COUNT);
    const mostAggressive = rankedByAccrual.slice(-NOTABLE_COUNT).reverse();

    const accrualRel3MPairs = hasRel3M
      ? companies.filter((c) => c.rel3M !== null && c.accrualRatio !== null).map((c) => ({ x: c.accrualRatio, y: c.rel3M, symbol: c.symbol }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      partial: stoppedForTime,
      hasRel3M,
      excludedForMissingPriorAssets,
      market,
      sectors,
      mostCashBacked,
      mostAggressive,
      accrualRel3MPairs,
      companies,
    };

    if (stoppedForTime) {
      const published = await store.get(BLOB_KEY, { type: "json" });
      if (published && !published.partial) {
        console.log("scheduled-accruals-background: partial run, keeping the last complete published snapshot until the next run finishes the cycle");
        return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, fetched: results.size, published: false }) };
      }
    }
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-accruals-background: wrote ${companies.length} companies across ${sectors.length} sectors (${excludedForMissingPriorAssets} excluded for a missing prior-period balance sheet)`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial: stoppedForTime, fetched: results.size, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-accruals-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
