// Scheduled Background Function (see [functions."scheduled-fcf-yield-
// background"] in netlify.toml) for the /fcf-yield.html page.
//
// Sweeps Alpha Vantage's CASH_FLOW endpoint (quarterly reports) across the
// full S&P 500 (~503 calls) and, for every company with at least 4 usable
// quarterly reports, sums the most recent 4 into a TTM figure:
//   TTM Free Cash Flow = TTM operatingCashflow - TTM |capitalExpenditures|
//
// Sign-convention finding (checked directly against a live CASH_FLOW pull
// for AAPL while building this job): Alpha Vantage reports
// capitalExpenditures as a POSITIVE outflow figure (e.g. ~$12.7B for
// AAPL's FY2025, not -12.7B) — the opposite of the raw SEC XBRL sign some
// other data vendors pass through unchanged. Handled defensively anyway
// (always subtracting the absolute value) in case a subset of tickers
// reports the field with the opposite sign, which does happen on some
// smaller/foreign filers across Alpha Vantage's fundamentals endpoints.
// A company is skipped entirely (not partially annualized) if any of its
// most recent 4 quarterly reports is missing operatingCashflow or
// capitalExpenditures.
//
// Deliberately does NOT run a second OVERVIEW sweep for market cap/sector/
// name — those come from the Sector Beeswarm page's own weekly meta.json
// (scheduled-beeswarm-meta-background.js), same reuse pattern as
// scheduled-revisions-background.js and friends. Trailing P/E for the
// earnings-yield comparison is read (read-only, gracefully) off the P/E
// Divergence page's own snapshot blob (scheduled-pe-divergence-
// background.js) rather than a third OVERVIEW-family sweep — see
// scheduled-shareholder-yield-background.js for the established idiom of
// one page reading another's blob. P/E Divergence's own `companies` array
// is already filtered to tickers with BOTH a sane trailing and forward
// P/E (its own MAX_MEANINGFUL_PE cap), so earnings-yield coverage here is
// a subset of the full FCF-yield universe — companies outside that filter
// still get an FCF yield, just no earnings-yield/divergence figure (the
// same graceful-omission shape as a missing trailing P/E outright). If
// that blob isn't populated yet (fresh environment, or P/E Divergence's
// own one-time snapshot hasn't run), this job still writes a full FCF-
// yield snapshot with earnings yield omitted everywhere, flagged via
// `peDivergenceAvailable: false` in the payload for the page to show a
// warning banner rather than fail.
//
// Snapshot-only endpoint (no time series for the market-wide figure), so
// the market-median FCF yield is appended to a running weekly history each
// run — same accumulating pattern as scheduled-pe-divergence-background.js.
//
// One-time snapshot (no `schedule` in netlify.toml) — see this function's
// own netlify.toml comment block for the current site-wide convention and
// a sensible Saturday slot for the record.

const { getFcfYieldStore, BLOB_KEY } = require("./fcf-yield-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getPeDivergenceStore, BLOB_KEY: PE_BLOB_KEY } = require("./pe-divergence-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const NOTABLE_COUNT = 15;
const MAX_HISTORY_WEEKS = 104;

// Outlier bound on TTM FCF yield, not a clamp: a row is dropped entirely
// (not shown, not clamped to the cap) if |FCF yield| exceeds this. Real
// S&P 500 constituents essentially never show a genuine trailing FCF
// yield beyond this range even in a hard drawdown (deeply cyclical/energy
// names have printed high-teens/low-20s in real stress) — a reading past
// it is overwhelmingly a marketCap/FCF unit or join mismatch (e.g. a stale
// beeswarm meta.json market cap against a name that's since split or been
// acquired), not a real valuation signal, matching how P/E Divergence
// excludes P/E ratios beyond its own MAX_MEANINGFUL_PE=300 sanity cap
// rather than plotting them.
const MAX_ABS_FCF_YIELD_PCT = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
// Alpha Vantage returns the literal string "None" (not null/omitted) for a
// missing numeric field on the fundamentals endpoints — same gotcha
// guarded against in scheduled-margin-leverage-background.js.
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchCashFlowQuarters(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(`${ALPHA_VANTAGE_URL}?function=CASH_FLOW&symbol=${symbol}&apikey=${apiKey}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) return null; // no data for this symbol (delisted, dual-class, etc.)
  return rows.slice(0, 4); // most-recent-first, same convention as BALANCE_SHEET/INCOME_STATEMENT elsewhere in this codebase
}

// TTM FCF = TTM operating cash flow - TTM |capex|. Requires all 4 of the
// most recent quarterly reports to have both fields usable — a company
// with only 1-3 usable quarters is skipped rather than annualized off a
// partial window.
function computeTtmFcf(reports) {
  if (!reports || reports.length < 4) return null;
  let ocfSum = 0;
  let capexSum = 0;
  for (const r of reports) {
    const ocf = num(r.operatingCashflow);
    const capex = num(r.capitalExpenditures);
    if (ocf === null || capex === null) return null;
    ocfSum += ocf;
    capexSum += Math.abs(capex);
  }
  return ocfSum - capexSum;
}

exports.handler = async () => {
  console.log(`scheduled-fcf-yield-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const [beeswarmMeta, peDivergenceData] = await Promise.all([
      getBeeswarmStore().get(META_KEY, { type: "json" }).catch(() => null),
      getPeDivergenceStore().get(PE_BLOB_KEY, { type: "json" }).catch(() => null),
    ]);
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};

    const peDivergenceAvailable = !!(peDivergenceData && Array.isArray(peDivergenceData.companies) && peDivergenceData.companies.length);
    const trailingPeBySymbol = new Map();
    if (peDivergenceAvailable) {
      for (const c of peDivergenceData.companies) {
        if (Number.isFinite(c.trailingPE) && c.trailingPE > 0) trailingPeBySymbol.set(c.symbol, c.trailingPE);
      }
    } else {
      console.log("scheduled-fcf-yield-background: pe-divergence blob not populated yet — writing FCF yield only, earnings yield omitted");
    }

    const results = new Map();
    async function fetchInto(symbol) {
      try {
        const reports = await fetchCashFlowQuarters(apiKey, symbol);
        if (reports) results.set(symbol, reports);
        return true;
      } catch (err) {
        console.error(`scheduled-fcf-yield-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-fcf-yield-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-fcf-yield-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, reports] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector || !m.marketCap || m.marketCap <= 0) continue;
      const ttmFcf = computeTtmFcf(reports);
      if (ttmFcf === null) continue; // fewer than 4 usable quarterly reports

      const fcfYield = (ttmFcf / m.marketCap) * 100;
      if (!Number.isFinite(fcfYield) || Math.abs(fcfYield) > MAX_ABS_FCF_YIELD_PCT) continue;

      const trailingPE = trailingPeBySymbol.get(symbol) ?? null;
      const earningsYield = trailingPE !== null ? round((100 / trailingPE)) : null;
      const divergence = earningsYield !== null ? round(fcfYield - earningsYield) : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        ttmFcf: Math.round(ttmFcf),
        marketCap: Math.round(m.marketCap),
        fcfYield: round(fcfYield),
        trailingPE: trailingPE !== null ? round(trailingPE) : null,
        earningsYield,
        divergence,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable TTM FCF and sector metadata");

    const withDivergence = companies.filter((c) => c.divergence !== null);

    const market = {
      companyCount: companies.length,
      earningsYieldCoverage: withDivergence.length,
      medianFcfYield: round(median(companies.map((c) => c.fcfYield))),
      meanFcfYield: round(mean(companies.map((c) => c.fcfYield))),
      medianEarningsYield: round(median(withDivergence.map((c) => c.earningsYield))),
    };

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianFcfYield: round(median(inSector.map((c) => c.fcfYield))),
        };
      })
      .filter(Boolean);

    // One point per company: earnings yield (x) vs. FCF yield (y) — the
    // "cash conversion" comparison. Only companies with both figures.
    const scatterPairs = withDivergence.map((c) => ({ symbol: c.symbol, sector: c.sector, x: c.earningsYield, y: c.fcfYield }));

    const highestFcfYield = [...companies].sort((a, b) => b.fcfYield - a.fcfYield).slice(0, NOTABLE_COUNT);
    const lowestFcfYield = [...companies].sort((a, b) => a.fcfYield - b.fcfYield).slice(0, NOTABLE_COUNT);
    const biggestPositiveDivergence = [...withDivergence].sort((a, b) => b.divergence - a.divergence).slice(0, NOTABLE_COUNT);
    const biggestNegativeDivergence = [...withDivergence].sort((a, b) => a.divergence - b.divergence).slice(0, NOTABLE_COUNT);

    const store = getFcfYieldStore();
    const previous = (await store.get(BLOB_KEY, { type: "json" })) || { history: [] };
    const history = Array.isArray(previous.history) ? previous.history : [];
    const weekKey = new Date().toISOString().slice(0, 10);
    const weekEntry = { week: weekKey, medianFcfYield: market.medianFcfYield, companyCount: market.companyCount };
    if (!history.length || history[history.length - 1].week !== weekKey) {
      history.push(weekEntry);
    } else {
      history[history.length - 1] = weekEntry;
    }
    while (history.length > MAX_HISTORY_WEEKS) history.shift();

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      peDivergenceAvailable,
      market,
      sectors,
      history,
      scatterPairs,
      leaders: { highestFcfYield, lowestFcfYield, biggestPositiveDivergence, biggestNegativeDivergence },
      companies,
    };

    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-fcf-yield-background: wrote ${companies.length} companies (${withDivergence.length} with earnings yield) across ${sectors.length} sectors, ${history.length}-week history`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-fcf-yield-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
