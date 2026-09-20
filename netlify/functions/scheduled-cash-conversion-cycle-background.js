// Scheduled Background Function (see [functions."scheduled-cash-
// conversion-cycle-background"] in netlify.toml) for the Cash Conversion
// Cycle page — how many days of cash a company has tied up in (or freed
// up by) its own operating cycle. Sweeps Alpha Vantage's INCOME_STATEMENT
// and BALANCE_SHEET endpoints (quarterly) across the full S&P 500, its own
// independent ~1006-call sweep for the same reason scheduled-roic-wacc-
// background.js runs its own rather than reading scheduled-margin-
// leverage-background.js's checkpoint: none of those existing checkpoints
// carry inventory, receivables, payables, or cost of revenue. One-time
// snapshot, no schedule — matches this file's current convention for new
// full-universe Equities jobs (run manually via the Netlify dashboard
// "Run now").
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob, same pattern as every other full-universe sweep in this
// codebase. Also does one optional, read-only cross-page read — ROIC vs.
// Cost of Capital's own latest snapshot, for this page's "does working-
// capital efficiency actually show up in a higher return on invested
// capital" regression — with a graceful fallback (the test just doesn't
// render) if that blob isn't populated yet.

const { getCashConversionCycleStore, BLOB_KEY, CHECKPOINT_KEY } = require("./cash-conversion-cycle-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRoicWaccStore, BLOB_KEY: ROIC_BLOB_KEY } = require("./roic-wacc-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Same reasoning as scheduled-roic-wacc-background.js: this is a single
// cross-sectional snapshot (trailing-twelve-month revenue/COGS + a
// latest-quarter balance-sheet snapshot), not a multi-year trend, so only
// the most recent few quarters are kept.
const QUARTERS_NEEDED = 5;
const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3;

const CALL_SLEEP_MS = 750;
const RUN_BUDGET_MS = 12 * 60 * 1000;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 120;

const KEEP_FIELDS = {
  INCOME_STATEMENT: ["fiscalDateEnding", "totalRevenue", "costOfRevenue", "costofGoodsAndServicesSold"],
  BALANCE_SHEET: ["fiscalDateEnding", "inventory", "currentNetReceivables", "currentAccountsPayable"],
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

function cogsOf(inc) {
  return num(inc.costOfRevenue) ?? num(inc.costofGoodsAndServicesSold);
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

// Computes trailing-twelve-month revenue/COGS and a latest-quarter
// working-capital snapshot for one company. Returns null when there isn't
// a clean 4-consecutive-quarter TTM window with both statements present,
// or when any of the three day-count components (DSO/DIO/DPO) can't be
// computed — which, deliberately, excludes most Financials, Real Estate
// and Utilities names entirely, since "inventory" and "cost of revenue"
// aren't meaningful concepts for a bank, a REIT, or a power utility. That
// exclusion is a real scope limitation of this page, not a bug — flagged
// explicitly in the methodology section rather than left implicit.
function computeCompanyMetrics(incomeRows, balanceRows) {
  const balByDate = new Map(balanceRows.map((r) => [r.fiscalDateEnding, r]));
  const matched = incomeRows.filter((inc) => balByDate.has(inc.fiscalDateEnding)).slice(0, 4);
  if (matched.length < 4) return null;

  let ttmRevenue = 0, ttmCogs = 0, hasAllCogs = true;
  for (const inc of matched) {
    const rev = num(inc.totalRevenue);
    if (rev === null) return null;
    ttmRevenue += rev;
    const cogs = cogsOf(inc);
    if (cogs === null) hasAllCogs = false;
    else ttmCogs += cogs;
  }
  if (ttmRevenue <= 0) return null;

  const latestBal = balByDate.get(matched[0].fiscalDateEnding);
  const receivables = num(latestBal.currentNetReceivables);
  const inventory = num(latestBal.inventory);
  const payables = num(latestBal.currentAccountsPayable);

  const dso = receivables !== null ? (receivables / ttmRevenue) * 365 : null;
  const dio = (hasAllCogs && ttmCogs > 0 && inventory !== null) ? (inventory / ttmCogs) * 365 : null;
  const dpo = (hasAllCogs && ttmCogs > 0 && payables !== null) ? (payables / ttmCogs) * 365 : null;
  if (dso === null || dio === null || dpo === null) return null;

  return {
    fiscalQuarter: matched[0].fiscalDateEnding,
    dso, dio, dpo,
    ccc: dso + dio - dpo,
  };
}

exports.handler = async () => {
  console.log(`scheduled-cash-conversion-cycle-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let roicBySymbol = {};
    try {
      const roicLatest = await getRoicWaccStore().get(ROIC_BLOB_KEY, { type: "json" });
      if (roicLatest && Array.isArray(roicLatest.companies)) {
        for (const c of roicLatest.companies) if (c.roic !== null && c.roic !== undefined) roicBySymbol[c.symbol] = c.roic;
      }
    } catch (err) {
      console.error("scheduled-cash-conversion-cycle-background: could not read roic-wacc blob, continuing without the CCC-vs-ROIC test:", err.message);
    }
    const hasRoicData = Object.keys(roicBySymbol).length > 0;

    const startedAt = Date.now();
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
    const store = getCashConversionCycleStore();
    const saved = await store.get(CHECKPOINT_KEY, { type: "json" });
    const resume = !!(saved && !saved.complete && Date.now() - Date.parse(saved.startedAt) < CHECKPOINT_MAX_AGE_MS);
    const cycleStartedAt = resume ? saved.startedAt : new Date().toISOString();
    const results = new Map(resume ? Object.entries(saved.results) : []); // symbol -> { income, balance }
    if (resume) console.log(`scheduled-cash-conversion-cycle-background: resuming checkpoint with ${results.size} ticker(s) already fetched`);

    const failures = resume ? { ...(saved.failed || {}) } : {};
    const saveCheckpoint = (complete) =>
      store.setJSON(CHECKPOINT_KEY, { startedAt: cycleStartedAt, complete, results: Object.fromEntries(results), failed: failures });

    async function fetchInto(symbol) {
      try {
        const income = await fetchStatement(apiKey, "INCOME_STATEMENT", symbol);
        await sleep(CALL_SLEEP_MS);
        const balance = await fetchStatement(apiKey, "BALANCE_SHEET", symbol);
        delete failures[symbol];
        results.set(symbol, { income, balance });
        return true;
      } catch (err) {
        console.error(`scheduled-cash-conversion-cycle-background: ${symbol} failed: ${err.message}`);
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
        console.log(`scheduled-cash-conversion-cycle-background: retry pass for ${todo.length} ticker(s)`);
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
    if (stoppedForTime) console.log(`scheduled-cash-conversion-cycle-background: out of time with ${results.size}/${BREADTH_CONSTITUENTS.length} fetched — run again to finish`);

    console.log(`scheduled-cash-conversion-cycle-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, { income, balance }] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const metrics = computeCompanyMetrics(income, balance);
      if (!metrics) continue;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalQuarter: metrics.fiscalQuarter,
        dso: round(metrics.dso, 1),
        dio: round(metrics.dio, 1),
        dpo: round(metrics.dpo, 1),
        ccc: round(metrics.ccc, 1),
        roic: roicBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable statement history and sector metadata");

    const rankedByCcc = [...companies].sort((a, b) => a.ccc - b.ccc);
    rankedByCcc.forEach((c, i) => { c.rankCcc = i + 1; });

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianDso: round(median(inSector.map((c) => c.dso)), 1),
          medianDio: round(median(inSector.map((c) => c.dio)), 1),
          medianDpo: round(median(inSector.map((c) => c.dpo)), 1),
          medianCcc: round(median(inSector.map((c) => c.ccc)), 1),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianDso: round(median(companies.map((c) => c.dso)), 1),
      medianDio: round(median(companies.map((c) => c.dio)), 1),
      medianDpo: round(median(companies.map((c) => c.dpo)), 1),
      medianCcc: round(median(companies.map((c) => c.ccc)), 1),
      negativeCccPct: round((companies.filter((c) => c.ccc < 0).length / companies.length) * 100, 1),
    };

    // "Fastest" = most negative/lowest CCC (least cash tied up); "slowest"
    // = highest CCC (most cash tied up in the operating cycle).
    const fastest = rankedByCcc.slice(0, NOTABLE_COUNT);
    const slowest = [...rankedByCcc].reverse().slice(0, NOTABLE_COUNT);

    const dsoVsDpoPairs = companies.map((c) => ({ x: c.dso, y: c.dpo, symbol: c.symbol }));
    const cccVsRoicPairs = hasRoicData
      ? companies.filter((c) => c.roic !== null).map((c) => ({ x: c.ccc, y: c.roic, symbol: c.symbol }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      partial: stoppedForTime,
      hasRoicData,
      market,
      sectors,
      fastest,
      slowest,
      dsoVsDpoPairs,
      cccVsRoicPairs,
      companies,
    };

    if (stoppedForTime) {
      const published = await store.get(BLOB_KEY, { type: "json" });
      if (published && !published.partial) {
        console.log("scheduled-cash-conversion-cycle-background: partial run, keeping the last complete published snapshot until the next run finishes the cycle");
        return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, fetched: results.size, published: false }) };
      }
    }
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-cash-conversion-cycle-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial: stoppedForTime, fetched: results.size, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-cash-conversion-cycle-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
