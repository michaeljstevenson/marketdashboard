// Scheduled Background Function (see [functions."scheduled-net-cash-
// position-background"] in netlify.toml) that sweeps Alpha Vantage's
// BALANCE_SHEET endpoint (latest quarter only) across the full S&P 500 for
// each company's net cash position — cash and short-term investments minus
// total debt — expressed as a % of market cap, for the net-cash-position.html
// page's test of the "value of cash" question (Faulkender & Wang 2006 and
// the broader corporate-cash-holdings literature: does the market treat a
// large cash cushion as a safety margin/option value, or discount it as
// idle capital not being put to work?).
//
// A single-endpoint sweep (~503 calls, no checkpoint needed — same call-
// volume class as scheduled-rd-intensity-background.js's single-endpoint
// sweep, well within a Background Function's ~15-minute ceiling), unlike
// ROIC vs. Cost of Capital's and Cash Conversion Cycle's two-statement
// sweeps. Only the latest quarter is needed (no TTM figure to build), so
// this doesn't even need the 4+-quarter windows those two pages fetch.
//
// Debt and cash field selection (shortLongTermDebtTotal with a short+long
// fallback, cashAndCashEquivalentsAtCarryingValue with a cashAndShortTerm-
// Investments fallback) copies scheduled-margin-leverage-background.js's
// and scheduled-roic-wacc-background.js's own totalDebtOf()/cashOf()
// helpers verbatim — a proven-safe field selection already exercised at
// this exact universe size by two other jobs, not reinvented here.
//
// Market cap comes from the Sector Beeswarm page's own weekly meta.json
// (same reuse pattern as every other full-universe job on this site) —
// net cash only means something relative to how the market actually
// values the company, not as a raw dollar figure. Also does two optional,
// read-only cross-page reads — Relative Strength Leaders/Laggards' 3-month
// relative return, and ROIC vs. Cost of Capital's own ROIC-minus-WACC
// spread — for this page's two "does a cash cushion show up as value"
// tests, both with a graceful fallback (those tests just don't render) if
// either blob isn't populated yet.
//
// Financials, Real Estate, and Utilities are deliberately excluded by
// sector, not left to a data gap the way Cash Conversion Cycle's inventory/
// cost-of-revenue exclusion happens naturally: those three sectors *do*
// report cash and debt figures, but a bank's deposit-funded balance sheet
// and a REIT's or utility's intentionally leveraged capital structure don't
// mean the same thing on a net-cash-ratio scale as an operating company's
// does — see the page's own methodology section.
//
// One-time snapshot, no schedule — matches this site's convention for every
// full-universe fundamentals sweep added since 2026-09-16 (quarterly
// balance-sheet figures don't move day to day).

const { getNetCashStore, BLOB_KEY } = require("./net-cash-position-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { getRoicWaccStore, BLOB_KEY: ROIC_WACC_KEY } = require("./roic-wacc-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const EXCLUDED_SECTORS = new Set(["Financials", "Real Estate", "Utilities"]);
const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Copies scheduled-margin-leverage-background.js's / scheduled-roic-wacc-
// background.js's own field-selection logic verbatim (see file header).
function totalDebtOf(bal) {
  const direct = num(bal.shortLongTermDebtTotal);
  if (direct !== null) return direct;
  const short = num(bal.shortTermDebt) ?? num(bal.currentDebt);
  const long = num(bal.longTermDebt) ?? num(bal.longTermDebtNoncurrent);
  if (short === null && long === null) return null;
  return (short || 0) + (long || 0);
}
function cashOf(bal) {
  return num(bal.cashAndCashEquivalentsAtCarryingValue) ?? num(bal.cashAndShortTermInvestments);
}

async function fetchLatestBalanceSheet(apiKey, symbol) {
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
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0]; // Alpha Vantage returns quarterlyReports most-recent-first
}

exports.handler = async () => {
  console.log(`scheduled-net-cash-position-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

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
      console.error("scheduled-net-cash-position-background: could not read relative-strength blob, continuing without the cash-vs-return test:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    let spreadBySymbol = {};
    try {
      const roicLatest = await getRoicWaccStore().get(ROIC_WACC_KEY, { type: "json" });
      if (roicLatest && Array.isArray(roicLatest.companies)) {
        for (const c of roicLatest.companies) if (c.spread !== null && c.spread !== undefined) spreadBySymbol[c.symbol] = c.spread;
      }
    } catch (err) {
      console.error("scheduled-net-cash-position-background: could not read roic-wacc blob, continuing without the cash-vs-value-creation test:", err.message);
    }
    const hasRoicSpread = Object.keys(spreadBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const bal = await fetchLatestBalanceSheet(apiKey, symbol);
        if (bal) results.set(symbol, bal);
        return true;
      } catch (err) {
        console.error(`scheduled-net-cash-position-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-net-cash-position-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-net-cash-position-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, bal] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      if (EXCLUDED_SECTORS.has(m.sector)) continue;
      if (!Number.isFinite(m.marketCap) || m.marketCap <= 0) continue;

      const debt = totalDebtOf(bal);
      const cash = cashOf(bal);
      if (debt === null || cash === null) continue;

      const netCashUsd = cash - debt;
      const netCashRatio = (netCashUsd / m.marketCap) * 100;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalQuarter: bal.fiscalDateEnding,
        netCashUsd,
        netCashRatio: round(netCashRatio),
        rel3M: rel3MBySymbol[symbol] ?? null,
        roicWaccSpread: spreadBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable cash/debt figures, market cap, and sector metadata");

    const sectors = SECTOR_ORDER
      .filter((sector) => !EXCLUDED_SECTORS.has(sector))
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianNetCashRatio: round(median(inSector.map((c) => c.netCashRatio))),
          meanNetCashRatio: round(mean(inSector.map((c) => c.netCashRatio))),
        };
      })
      .filter(Boolean);

    const fortressCount = companies.filter((c) => c.netCashRatio > 0).length;

    const market = {
      companyCount: companies.length,
      medianNetCashRatio: round(median(companies.map((c) => c.netCashRatio))),
      meanNetCashRatio: round(mean(companies.map((c) => c.netCashRatio))),
      fortressSharePct: round((fortressCount / companies.length) * 100, 1),
    };

    const rankedByRatio = [...companies].sort((a, b) => b.netCashRatio - a.netCashRatio);
    const mostCash = rankedByRatio.slice(0, NOTABLE_COUNT);
    const mostLevered = [...rankedByRatio].reverse().slice(0, NOTABLE_COUNT);

    const histogram = companies.map((c) => c.netCashRatio);

    const scatterRel3M = companies
      .filter((c) => c.rel3M !== null)
      .map((c) => ({ x: c.netCashRatio, y: round(c.rel3M, 2), symbol: c.symbol, sector: c.sector }));

    const scatterRoicSpread = companies
      .filter((c) => c.roicWaccSpread !== null)
      .map((c) => ({ x: c.netCashRatio, y: c.roicWaccSpread, symbol: c.symbol, sector: c.sector }));

    const leaderRow = (c) => ({
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      netCashRatio: c.netCashRatio,
      rel3M: c.rel3M === null ? null : round(c.rel3M, 2),
    });

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      excludedSectors: [...EXCLUDED_SECTORS],
      hasRel3M,
      hasRoicSpread,
      market,
      sectors,
      histogram,
      scatterRel3M,
      scatterRoicSpread,
      mostCash: mostCash.map(leaderRow),
      mostLevered: mostLevered.map(leaderRow),
      companies: companies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        netCashRatio: c.netCashRatio,
        rel3M: c.rel3M === null ? null : round(c.rel3M, 2),
      })),
    };

    await getNetCashStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-net-cash-position-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-net-cash-position-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
