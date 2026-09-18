// Scheduled Background Function (see [functions."scheduled-buyback-
// tracker-background"] in netlify.toml) that sweeps Alpha Vantage's
// CASH_FLOW endpoint across the full S&P 500 (BREADTH_CONSTITUENTS) for
// trailing-twelve-month dollar-value buyback spend and buyback intensity
// (TTM buyback $ / TTM net income) — the "Buyback Dollar-Value Tracker"
// page.
//
// This is the dollar-value companion to share-count-trends.html (which
// infers buybacks indirectly from net share-count deltas) and
// shareholder-yield.html (per-share buyback yield, sourced from that
// page's output) — this page is about aggregate dollars and intensity
// relative to earnings, not per-share yield.
//
// CASH_FLOW's quarterlyReports don't consistently populate one single
// buyback field across every company: some report
// proceedsFromRepurchaseOfEquity (a negative number — cash outflow),
// others only populate paymentsForRepurchaseOfCommonStock (positive).
// Preference order: proceedsFromRepurchaseOfEquity (abs()'d) first,
// falling back to paymentsForRepurchaseOfCommonStock when the first is
// literally the string "None" (Alpha Vantage's marker for "not reported"
// on this statement, not "reported as zero"). A quarter where NEITHER
// field parses is skipped from the TTM sum rather than treated as $0 —
// "not reported" and "reported as zero" are different things, and
// conflating them would understate real buyback activity for tickers
// with patchy field coverage. netIncome comes directly off the same
// quarterlyReports payload — no separate INCOME_STATEMENT sweep needed.
//
// Real cross-page dependency, not a coincidence: this job reads
// relative-strength's own latest.json (getRelativeStrengthStore) for the
// 3-month price-performance half of the buyback-intensity-vs-forward-
// return test, same pattern earnings-growth-divergence-background.js
// uses, rather than running a second ~503-call price sweep of its own.
// If that blob isn't populated yet, this job still writes buyback rows
// (relPrice3M: null on every company) instead of failing outright, and
// the page shows a warning rather than erroring — same fallback earnings-
// growth-divergence.html implements.
//
// Name/sector come from Sector Beeswarm's own weekly meta.json, same
// convention as every other full-universe job on this site.
//
// ~503 sequential CASH_FLOW calls, 1050ms apart with a retry pass — same
// pacing proven at this scale by scheduled-beeswarm-meta-background.js.

const { getBuybackTrackerStore, LATEST_KEY } = require("./buyback-tracker-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_FETCHED = 12; // TTM (4) + prior-year TTM (4-8) + a couple extra for the aggregate trend chart
const LEADERBOARD_COUNT = 15;
const AGGREGATE_QUARTERS = 12;
const MIN_COMPANIES_FOR_AGGREGATE_QUARTER = 100; // drop thin/still-reporting quarters from the market-wide trend rather than show a misleading dip

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
function sum(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

function parseBuyback(report) {
  const proceeds = parseFloat(report.proceedsFromRepurchaseOfEquity);
  if (Number.isFinite(proceeds)) return Math.abs(proceeds);
  const payments = parseFloat(report.paymentsForRepurchaseOfCommonStock);
  if (Number.isFinite(payments)) return Math.abs(payments);
  return null;
}
function parseNetIncome(report) {
  const v = parseFloat(report.netIncome);
  return Number.isFinite(v) ? v : null;
}
function calQuarterLabel(fiscalDateEnding) {
  const d = new Date(fiscalDateEnding + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

async function fetchCashFlow(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=CASH_FLOW&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);

  // Alpha Vantage returns quarterlyReports most-recent-first already.
  return rows.slice(0, QUARTERS_FETCHED).map((r) => ({
    fiscalDateEnding: r.fiscalDateEnding,
    calQuarter: calQuarterLabel(r.fiscalDateEnding),
    buyback: parseBuyback(r),
    netIncome: parseNetIncome(r),
  }));
}

exports.handler = async () => {
  console.log(`scheduled-buyback-tracker-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let relativeStrengthBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relativeStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-buyback-tracker-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relativeStrengthBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchCashFlow(apiKey, symbol);
        if (quarters.length >= 4) results.set(symbol, quarters); // need at least a full TTM
        return true;
      } catch (err) {
        console.error(`scheduled-buyback-tracker-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-buyback-tracker-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-buyback-tracker-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const aggMap = new Map(); // calQuarter -> { total, count }
    const companies = [];

    for (const [symbol, quarters] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      for (const q of quarters) {
        if (q.buyback === null || !q.calQuarter) continue;
        const entry = aggMap.get(q.calQuarter) || { total: 0, count: 0 };
        entry.total += q.buyback;
        entry.count += 1;
        aggMap.set(q.calQuarter, entry);
      }

      const trailing4 = quarters.slice(0, 4);
      const prior4 = quarters.slice(4, 8);

      const ttmBuyback = sum(trailing4.map((q) => q.buyback));
      const ttmNetIncome = sum(trailing4.map((q) => q.netIncome));
      const priorTtmBuyback = prior4.length === 4 ? sum(prior4.map((q) => q.buyback)) : null;

      const intensity = (ttmNetIncome !== null && ttmNetIncome > 0 && ttmBuyback !== null)
        ? (ttmBuyback / ttmNetIncome) * 100
        : null;

      // "Skip if either period has zero data" — priorTtmBuyback null (no
      // quarter in that window had a parseable field at all) or exactly 0
      // both make a YoY % change undefined/meaningless, not just a
      // divide-by-zero edge case.
      const yoyGrowth = (ttmBuyback !== null && priorTtmBuyback !== null && priorTtmBuyback !== 0)
        ? ((ttmBuyback - priorTtmBuyback) / priorTtmBuyback) * 100
        : null;

      const relPrice3M = Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, symbol)
        ? relativeStrengthBySymbol[symbol]
        : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        ttmBuyback: round(ttmBuyback, 0),
        ttmNetIncome: round(ttmNetIncome, 0),
        intensity: round(intensity),
        yoyGrowth: round(yoyGrowth),
        relPrice3M,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both cash-flow history and sector metadata");

    const quarterlyAggregate = [...aggMap.entries()]
      .map(([quarter, v]) => ({ quarter, totalBuyback: round(v.total, 0), companyCount: v.count }))
      .filter((r) => r.companyCount >= MIN_COMPANIES_FOR_AGGREGATE_QUARTER)
      .sort((a, b) => (a.quarter < b.quarter ? -1 : a.quarter > b.quarter ? 1 : 0))
      .slice(-AGGREGATE_QUARTERS);

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        const withIntensity = inSector.filter((c) => c.intensity !== null);
        return {
          sector,
          companyCount: inSector.length,
          totalTtmBuyback: round(sum(inSector.map((c) => c.ttmBuyback)), 0),
          avgIntensity: round(mean(withIntensity.map((c) => c.intensity))),
          medianIntensity: round(median(withIntensity.map((c) => c.intensity))),
          intensityCount: withIntensity.length,
        };
      })
      .filter(Boolean);

    const withIntensity = companies.filter((c) => c.intensity !== null);
    const bins = [];
    for (let lo = 0; lo < 100; lo += 10) {
      bins.push({ label: `${lo}-${lo + 10}%`, lo, hi: lo + 10, count: 0 });
    }
    bins.push({ label: "100%+", lo: 100, hi: Infinity, count: 0 });
    for (const c of withIntensity) {
      const bin = bins.find((b) => c.intensity >= b.lo && c.intensity < b.hi) || bins[bins.length - 1];
      bin.count += 1;
    }

    const market = {
      companyCount: companies.length,
      withIntensity: withIntensity.length,
      withPriceData: companies.filter((c) => c.relPrice3M !== null).length,
      totalTtmBuyback: round(sum(companies.map((c) => c.ttmBuyback)), 0),
      totalTtmNetIncome: round(sum(companies.map((c) => c.ttmNetIncome)), 0),
      medianIntensity: round(median(withIntensity.map((c) => c.intensity))),
    };

    const largestTtmBuyback = [...companies]
      .filter((c) => c.ttmBuyback !== null)
      .sort((a, b) => b.ttmBuyback - a.ttmBuyback)
      .slice(0, LEADERBOARD_COUNT);

    const highestIntensity = [...withIntensity]
      .sort((a, b) => b.intensity - a.intensity)
      .slice(0, LEADERBOARD_COUNT);

    const withYoy = companies.filter((c) => c.yoyGrowth !== null);
    const biggestYoyIncrease = [...withYoy].sort((a, b) => b.yoyGrowth - a.yoyGrowth).slice(0, LEADERBOARD_COUNT);
    const biggestYoyDecrease = [...withYoy].sort((a, b) => a.yoyGrowth - b.yoyGrowth).slice(0, LEADERBOARD_COUNT);

    const scatterPairs = withIntensity
      .filter((c) => c.relPrice3M !== null)
      .map((c) => ({ x: c.intensity, y: c.relPrice3M, symbol: c.symbol }));

    const store = getBuybackTrackerStore();
    const latest = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasPriceData,
      market,
      quarterlyAggregate,
      sectors,
      intensityDistribution: bins.map((b) => ({ label: b.label, count: b.count })),
      largestTtmBuyback,
      highestIntensity,
      biggestYoyIncrease,
      biggestYoyDecrease,
      scatterPairs,
      companies,
    };

    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-buyback-tracker-background: done, ${results.size}/${BREADTH_CONSTITUENTS.length} tickers, ` +
      `${companies.length} with sector metadata, ${withIntensity.length} with a valid intensity, hasPriceData=${hasPriceData}`
    );

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("scheduled-buyback-tracker-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
