// Scheduled Background Function (see [functions."scheduled-analyst-coverage-
// background"] in netlify.toml) that sweeps Alpha Vantage's
// EARNINGS_ESTIMATES endpoint across the full S&P 500 for the FY1 row's
// eps_estimate_analyst_count field — how many analysts actively cover each
// name's current-fiscal-year EPS — for the analyst-coverage.html page's
// test of the "neglected firm effect" (Arbel & Strebel 1983): the claim
// that thinly-covered stocks earn a return premium, historically
// attributed to an information/liquidity premium.
//
// A standalone full sweep, deliberately NOT read off
// scheduled-revisions-background.js's or scheduled-dispersion-background.js's
// own blobs even though both of those jobs already fetch this same field
// per ticker (see fetchEarningsEstimates() in each) — neither persists a
// full-universe array of it. scheduled-revisions-background.js keeps
// analystCount only on its top/bottom-10 drift leaderboards, and
// scheduled-dispersion-background.js only on its top/bottom-10 dispersion
// leaderboards; this page needs every constituent's count for its sector
// medians, histogram, quintile-bucket test, and full table. Same tradeoff
// this site already made for Analyst Estimate Dispersion vs. Earnings
// Revisions: a second (here, third) otherwise-redundant sweep of the same
// endpoint, kept in its own job so this new page never touches either
// already-shipped page's backend.
//
// Sector and company name come from the Sector Beeswarm page's own weekly
// meta.json blob, same pattern as every other full-universe sweep in this
// codebase. Also does one optional, read-only cross-page read — Relative
// Strength Leaders/Laggards' own 3-month relative return — for this page's
// coverage-vs-return tests, with a graceful fallback (those tests just
// don't render) if that blob isn't populated yet.
//
// Weekly (Saturday), not one-time: EARNINGS_ESTIMATES' analyst-count field
// moves week to week as coverage initiates or lapses and estimates roll
// forward — matches scheduled-revisions-background.js's and
// scheduled-dispersion-background.js's own cadence for the same endpoint,
// not the "one-time snapshot" convention this site uses for slower-moving
// two-statement fundamentals sweeps (INCOME_STATEMENT/BALANCE_SHEET/
// CASH_FLOW). Scheduled for 12:40 UTC: after scheduled-splits-background
// (12:20 UTC, a light ~33-ticker sweep that finishes well before 12:30)
// and comfortably before scheduled-relative-strength-background (13:10
// UTC, this job's own optional read dependency — reading it a few minutes
// stale from last week is fine, since it's an optional fallback-guarded
// read, not a hard dependency).

const { getAnalystCoverageStore, LATEST_KEY, HISTORY_KEY } = require("./analyst-coverage-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_HISTORY_POINTS = 260; // ~5 years of weekly snapshots
const MIN_SECTOR_N = 3;
const NOTABLE_COUNT = 15;
const QUINTILE_COUNT = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
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

async function fetchAnalystCount(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=EARNINGS_ESTIMATES&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const estimates = payload.estimates;
  if (!Array.isArray(estimates) || !estimates.length) return null;

  // Same FY1 selection as scheduled-revisions-background.js /
  // scheduled-dispersion-background.js: the nearest-dated "fiscal year"
  // horizon row is always the in-progress or next-to-report fiscal year.
  // A stock with genuinely zero analyst coverage returns no usable
  // "fiscal year" row at all here, not a row with a count of zero — see
  // the methodology note on the page itself, this endpoint can only
  // measure variation among covered stocks, not distinguish "1 analyst"
  // from "0 analysts" for names this sweep drops entirely.
  const fyRows = estimates.filter((e) => e.horizon === "fiscal year" && e.date);
  if (!fyRows.length) return null;
  fyRows.sort((a, b) => (a.date < b.date ? -1 : 1));
  const fy1 = fyRows[0];

  const analystCount = num(fy1.eps_estimate_analyst_count);
  if (analystCount === null || analystCount <= 0) return null;

  return { fyEndDate: fy1.date, analystCount };
}

exports.handler = async () => {
  console.log(`scheduled-analyst-coverage-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
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
      console.error("scheduled-analyst-coverage-background: could not read relative-strength blob, continuing without the coverage-vs-return tests:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const entry = await fetchAnalystCount(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-analyst-coverage-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    // Two passes, same cadence as scheduled-dispersion-background.js: ~1.05s
    // between calls, a minute+ cooling-off before retrying whatever the
    // first pass missed.
    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-analyst-coverage-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-analyst-coverage-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, est] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        analystCount: est.analystCount,
        rel3M: rel3MBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with a usable analyst count and sector metadata");

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianCoverage: round(median(inSector.map((c) => c.analystCount)), 1),
          meanCoverage: round(mean(inSector.map((c) => c.analystCount)), 1),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianCoverage: round(median(companies.map((c) => c.analystCount)), 1),
      meanCoverage: round(mean(companies.map((c) => c.analystCount)), 1),
    };

    const rankedByCoverage = [...companies].sort((a, b) => b.analystCount - a.analystCount);
    const mostCovered = rankedByCoverage.slice(0, NOTABLE_COUNT);
    const leastCovered = [...rankedByCoverage].reverse().slice(0, NOTABLE_COUNT);

    const histogram = companies.map((c) => c.analystCount);

    // The core "neglected firm effect" test, visualized directly: split the
    // rel3M-eligible universe into coverage quintiles (least-covered fifth
    // through most-covered fifth) and compare median 3-month relative
    // return across buckets — more legible than a single regression
    // coefficient, same "bucket comparison alongside a regression" approach
    // as scheduled-margin-leverage-background.js's Fed-funds-regime test.
    const eligibleForReturn = companies.filter((c) => c.rel3M !== null).sort((a, b) => a.analystCount - b.analystCount);
    const quintiles = [];
    if (eligibleForReturn.length >= QUINTILE_COUNT * MIN_SECTOR_N) {
      const n = eligibleForReturn.length;
      for (let q = 0; q < QUINTILE_COUNT; q++) {
        const lo = Math.floor((q * n) / QUINTILE_COUNT);
        const hi = q === QUINTILE_COUNT - 1 ? n : Math.floor(((q + 1) * n) / QUINTILE_COUNT);
        const bucket = eligibleForReturn.slice(lo, hi);
        if (!bucket.length) continue;
        quintiles.push({
          quintile: q + 1,
          minCoverage: bucket[0].analystCount,
          maxCoverage: bucket[bucket.length - 1].analystCount,
          n: bucket.length,
          medianRel3M: round(median(bucket.map((c) => c.rel3M)), 2),
          meanRel3M: round(mean(bucket.map((c) => c.rel3M)), 2),
        });
      }
    }

    const scatterPairs = eligibleForReturn.map((c) => ({ x: c.analystCount, y: round(c.rel3M, 2), symbol: c.symbol, sector: c.sector }));

    const leaderRow = (c) => ({
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      analystCount: c.analystCount,
      rel3M: c.rel3M === null ? null : round(c.rel3M, 2),
    });

    const generatedAt = new Date().toISOString();

    const latest = {
      generated_at_utc: generatedAt,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      hasRel3M,
      market,
      sectors,
      histogram,
      quintiles,
      scatterPairs,
      mostCovered: mostCovered.map(leaderRow),
      leastCovered: leastCovered.map(leaderRow),
      companies: companies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        analystCount: c.analystCount,
        rel3M: c.rel3M === null ? null : round(c.rel3M, 2),
      })),
    };

    const store = getAnalystCoverageStore();
    await store.setJSON(LATEST_KEY, latest);

    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];
    const todayDate = generatedAt.slice(0, 10);
    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push({
      date: todayDate,
      marketMedianCoverage: market.medianCoverage,
      sectors: Object.fromEntries(sectors.map((s) => [s.sector, s.medianCoverage])),
    });
    const trimmed = filtered.slice(-MAX_HISTORY_POINTS);
    await store.setJSON(HISTORY_KEY, { points: trimmed });

    console.log(`scheduled-analyst-coverage-background: wrote ${companies.length} companies across ${sectors.length} sectors, ${quintiles.length} quintile buckets, history now ${trimmed.length} points`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-analyst-coverage-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
