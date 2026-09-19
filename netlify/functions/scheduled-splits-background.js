// Scheduled Background Function (see [functions."scheduled-splits-
// background"] in netlify.toml) for the /stock-split-tracker.html page.
//
// Two-stage sweep:
//   1. Yahoo Finance's split events across the full S&P 500 (~503 calls)
//      to find every split event in the last FREQUENCY_LOOKBACK_YEARS —
//      cheap, one call per ticker regardless of how much split history it
//      has, so this stage powers the long-run "is the stock split coming
//      back?" frequency chart at no extra cost.
//   2. For the much smaller set of tickers with a split inside the more
//      recent EVENT_STUDY_LOOKBACK_YEARS window, a second sweep of
//      full daily adjusted closes — plus SPY once — to
//      build a real event study: relative return vs. SPY in the trading
//      days before and after the split. Deliberately NOT fetched for
//      every ticker with any split in 15 years — a full daily-adjusted
//      pull is a much heavier payload than a split-events call, and splits from
//      a decade-plus ago aren't what a reader wants a price chart around.
//
// Data-quality filter (found while building this page): the original
// Alpha Vantage SPLITS feed mixed in non-split corporate-action adjustment factors —
// e.g. GE shows "splits" of 1.2530 (2024-04-02) and 1.2810 (2023-01-04),
// which are actually the GE Vernova and GE HealthCare spin-off adjustment
// ratios, not stock splits GE ever announced. Real splits are always a
// clean small-integer ratio ("10-for-1", "3-for-2", "1-for-8"); spin-off
// adjustment factors are arbitrary decimals derived from market prices at
// the spin-off date. SPLIT_RATIOS below is an allowlist of the ratios
// companies actually use, matched within a tight 0.15% tolerance — loose
// enough to absorb the source's own rounding, tight enough that GE's
// 1.2530 (2.4% off the nearest real candidate, 5-for-4) is correctly
// rejected rather than misread as a split.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob rather than paying for a second OVERVIEW sweep — same
// pattern as scheduled-share-count-background.js and friends.

const { getSplitsStore, BLOB_KEY } = require("./splits-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { fetchDailyHistory, fetchSplitEvents } = require("./yahoo-client");


const FREQUENCY_LOOKBACK_YEARS = 15;
const EVENT_STUDY_LOOKBACK_YEARS = 5;
const PRE_DAYS = 20;
const POST_DAYS = 120;
const MIN_N_FOR_CAR_POINT = 5;
const RECENT_LEADERBOARD_COUNT = 15;
const BENCHMARK = "SPY";
const RATIO_TOLERANCE = 0.0015; // 0.15% relative

// Allowlist of ratios real stock splits actually use — see header comment.
// [a, b] means "a-for-b" (value = a/b); the reverse "b-for-a" candidate is
// generated automatically below.
const SPLIT_RATIO_PAIRS = [
  [21, 20], [11, 10], [6, 5], [5, 4], [4, 3], [3, 2], [2, 1], [5, 2],
  [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [10, 1], [12, 1],
  [15, 1], [20, 1], [25, 1], [30, 1], [40, 1], [50, 1], [100, 1],
];
const RATIO_CANDIDATES = [];
for (const [a, b] of SPLIT_RATIO_PAIRS) {
  RATIO_CANDIDATES.push({ value: a / b, label: `${a}-for-${b}` });
  RATIO_CANDIDATES.push({ value: b / a, label: `${b}-for-${a}` });
}

function matchSplitRatio(factor) {
  let best = null;
  let bestErr = Infinity;
  for (const c of RATIO_CANDIDATES) {
    const err = Math.abs(factor - c.value) / c.value;
    if (err < bestErr) { bestErr = err; best = c; }
  }
  return bestErr <= RATIO_TOLERANCE ? best : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

async function fetchSplits(symbol) {
  return (await fetchSplitEvents(symbol)).filter((r) => Number.isFinite(r.factor) && r.factor > 0);
}

// -> ascending [{ date, adjClose }]
async function fetchDailyAdjusted(symbol) {
  return (await fetchDailyHistory(symbol))
    .map((r) => ({ date: r.date, adjClose: r.close }))
    .filter((r) => r.adjClose > 0);
}

// Runs fetchFn(symbol) across `symbols` sequentially at 300ms spacing, two
// passes with a 65s cooldown between them. Yahoo has no quota but 429s
// intermittently, so the spacing and retry pass stay.
async function sweepSequential(symbols, fetchFn, label) {
  const results = new Map();
  let todo = [...symbols];
  for (let pass = 0; pass < 2 && todo.length; pass++) {
    if (pass > 0) {
      console.log(`scheduled-splits-background: ${label} retry pass for ${todo.length} ticker(s)`);
      await sleep(65000);
    }
    const missed = [];
    for (const symbol of todo) {
      try {
        results.set(symbol, await fetchFn(symbol));
      } catch (err) {
        console.error(`scheduled-splits-background: ${label} ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        missed.push(symbol);
      }
      await sleep(300);
    }
    todo = missed;
  }
  console.log(`scheduled-splits-background: ${label} fetched ${results.size}/${symbols.length}`);
  return results;
}

exports.handler = async () => {
  console.log(`scheduled-splits-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const now = new Date();
    const freqCutoff = new Date(now); freqCutoff.setFullYear(now.getFullYear() - FREQUENCY_LOOKBACK_YEARS);
    const eventCutoff = new Date(now); eventCutoff.setFullYear(now.getFullYear() - EVENT_STUDY_LOOKBACK_YEARS);

    // ---- Stage 1: SPLITS sweep, full universe ----
    const splitsRaw = await sweepSequential(BREADTH_CONSTITUENTS, fetchSplits, "SPLITS");
    if (splitsRaw.size === 0) throw new Error("Every ticker failed the SPLITS sweep — refusing to write an empty snapshot");

    // All genuine splits within the 15-year frequency window, full universe.
    const allValidSplits = []; // { symbol, date, factor, label, direction }
    for (const [symbol, events] of splitsRaw.entries()) {
      for (const ev of events) {
        const d = new Date(ev.date);
        if (isNaN(d) || d < freqCutoff || d > now) continue;
        const match = matchSplitRatio(ev.factor);
        if (!match) {
          console.log(`scheduled-splits-background: ${symbol} ${ev.date} factor ${ev.factor} not a recognized split ratio — skipped (likely a spin-off adjustment)`);
          continue;
        }
        allValidSplits.push({ symbol, date: ev.date, factor: ev.factor, label: match.label, direction: match.value > 1 ? "forward" : "reverse" });
      }
    }
    if (!allValidSplits.length) throw new Error("No genuine split events matched the ratio allowlist across the universe");

    // splitsPerYear (frequency chart) — full 15-year window.
    const yearCounts = new Map();
    for (const s of allValidSplits) {
      const y = s.date.slice(0, 4);
      const rec = yearCounts.get(y) || { year: y, forwardCount: 0, reverseCount: 0 };
      if (s.direction === "forward") rec.forwardCount++; else rec.reverseCount++;
      yearCounts.set(y, rec);
    }
    const splitsPerYear = [...yearCounts.values()].sort((a, b) => a.year.localeCompare(b.year));

    // ---- Stage 2: recent-window subset needs real price history ----
    const recentSplits = allValidSplits.filter((s) => new Date(s.date) >= eventCutoff);
    const priceSymbols = [...new Set(recentSplits.map((s) => s.symbol))];
    console.log(`scheduled-splits-background: ${recentSplits.length} recent split event(s) across ${priceSymbols.length} ticker(s), fetching daily price history`);

    const priceSeries = await sweepSequential([...priceSymbols, BENCHMARK], fetchDailyAdjusted, "daily price history");
    const spySeries = priceSeries.get(BENCHMARK);

    function indexOfOnOrAfter(series, dateStr) {
      for (let i = 0; i < series.length; i++) if (series[i].date >= dateStr) return i;
      return -1;
    }
    function relReturn(series, fromIdx, toIdx) {
      if (fromIdx < 0 || toIdx < 0 || fromIdx >= series.length || toIdx >= series.length) return null;
      const base = series[fromIdx].adjClose;
      if (!base) return null;
      return series[toIdx].adjClose / base - 1;
    }

    // Event-study accumulation — forward splits only (see header comment for
    // why reverse splits, a different economic signal and vanishingly rare
    // among current S&P 500 names, are excluded from the averaged path).
    const offsetSum = new Map(); // offset -> sum of relative-return percentage points
    const offsetN = new Map();
    const regressionPoints = []; // { symbol, logFactor, forwardReturn }

    const tableRows = [];
    for (const ev of recentSplits) {
      const series = priceSeries.get(ev.symbol);
      const m = metaTickers[ev.symbol];
      const daysSince = Math.round((now - new Date(ev.date)) / 86400000);

      let returnSinceSplit = null;
      let base = -1;
      if (series && series.length && spySeries && spySeries.length) {
        const idx0 = indexOfOnOrAfter(series, ev.date);
        base = idx0 > 0 ? idx0 - 1 : -1;
        if (base >= 0) {
          const stockRet = relReturn(series, base, series.length - 1);
          const spyBase = indexOfOnOrAfter(spySeries, series[base].date);
          const spyLast = indexOfOnOrAfter(spySeries, series[series.length - 1].date);
          const spyRet = spyBase >= 0 ? relReturn(spySeries, spyBase, spyLast >= 0 ? spyLast : spySeries.length - 1) : null;
          if (stockRet !== null && spyRet !== null) returnSinceSplit = round((stockRet - spyRet) * 100, 1);
        }
      }

      tableRows.push({
        symbol: ev.symbol,
        name: (m && m.name) || ev.symbol,
        sector: (m && m.sector) || null,
        date: ev.date,
        label: ev.label,
        direction: ev.direction,
        daysSinceSplit: daysSince,
        returnSinceSplit,
      });

      // CAR contribution — forward direction, enough pre-window history.
      if (ev.direction === "forward" && series && spySeries && base >= PRE_DAYS) {
        const idx0 = base + 1;
        for (let offset = -PRE_DAYS; offset <= POST_DAYS; offset++) {
          const idx = idx0 + offset;
          if (idx < 0 || idx >= series.length) continue;
          const spyBase = indexOfOnOrAfter(spySeries, series[base].date);
          const spyIdx = indexOfOnOrAfter(spySeries, series[idx].date);
          if (spyBase < 0 || spyIdx < 0) continue;
          const stockRet = relReturn(series, base, idx);
          const spyRet = relReturn(spySeries, spyBase, spyIdx);
          if (stockRet === null || spyRet === null) continue;
          const rel = (stockRet - spyRet) * 100;
          offsetSum.set(offset, (offsetSum.get(offset) || 0) + rel);
          offsetN.set(offset, (offsetN.get(offset) || 0) + 1);
        }

        // Full +120 trading day horizon reached -> usable for the
        // regression of split size vs. forward relative performance.
        if (idx0 + POST_DAYS < series.length) {
          const spyBase = indexOfOnOrAfter(spySeries, series[base].date);
          const spyPost = indexOfOnOrAfter(spySeries, series[idx0 + POST_DAYS].date);
          if (spyBase >= 0 && spyPost >= 0) {
            const stockRet = relReturn(series, base, idx0 + POST_DAYS);
            const spyRet = relReturn(spySeries, spyBase, spyPost);
            if (stockRet !== null && spyRet !== null) {
              regressionPoints.push({ symbol: ev.symbol, logFactor: round(Math.log2(ev.factor), 4), forwardReturn: round((stockRet - spyRet) * 100, 2) });
            }
          }
        }
      }
    }

    const carPath = [...offsetSum.keys()]
      .sort((a, b) => a - b)
      .map((offset) => ({ offset, avgRelative: round(offsetSum.get(offset) / offsetN.get(offset), 3), n: offsetN.get(offset) }))
      .filter((p) => p.n >= MIN_N_FOR_CAR_POINT);

    // Sector activity, recent window, all directions.
    const sectorMap = new Map();
    for (const r of tableRows) {
      if (!r.sector) continue;
      const rec = sectorMap.get(r.sector) || { sector: r.sector, forwardCount: 0, reverseCount: 0, symbols: new Set() };
      if (r.direction === "forward") rec.forwardCount++; else rec.reverseCount++;
      rec.symbols.add(r.symbol);
      sectorMap.set(r.sector, rec);
    }
    const sectors = SECTOR_ORDER
      .map((sector) => {
        const rec = sectorMap.get(sector);
        if (!rec) return null;
        return { sector, forwardCount: rec.forwardCount, reverseCount: rec.reverseCount, companyCount: rec.symbols.size };
      })
      .filter(Boolean);

    tableRows.sort((a, b) => b.date.localeCompare(a.date));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      splitsLoadedCount: splitsRaw.size,
      priceLoadedCount: priceSeries.size,
      priceUniverseSize: priceSymbols.length + 1,
      frequencyLookbackYears: FREQUENCY_LOOKBACK_YEARS,
      eventStudyLookbackYears: EVENT_STUDY_LOOKBACK_YEARS,
      preDays: PRE_DAYS,
      postDays: POST_DAYS,
      splitsPerYear,
      sectors,
      carPath,
      regressionPoints,
      recentSplits: tableRows,
      recentLeaders: tableRows.slice(0, RECENT_LEADERBOARD_COUNT),
    };

    await getSplitsStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-splits-background: wrote ${allValidSplits.length} valid splits (${recentSplits.length} recent), ${carPath.length} CAR points, ${regressionPoints.length} regression points`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, splits: allValidSplits.length, recent: recentSplits.length }) };
  } catch (err) {
    console.error(`scheduled-splits-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
