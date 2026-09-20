// Scheduled function (see [functions."scheduled-breadth-background"] in
// netlify.toml) that computes real market breadth internals —
// advances/declines, 52-week new highs/lows, % of constituents above
// their 200-day SMA, and % at all-time highs — across the full S&P 500
// constituent list (see breadth-constituents.js), and writes the result
// to Netlify Blobs for breadth-internals.js to serve.
//
// The "Day's change distribution" widget on market-breadth.html is fed
// by a separate, more frequent job (scheduled-daychange-background.js) —
// see that file for why it isn't computed here too.
//
// Named with the "-background" suffix so Netlify runs it as a Background
// Function (up to 15 minutes): it makes ~500 sequential Yahoo Finance
// history calls, well over the ~30s a standard function gets.
//
// Runs once daily after the close. Each run re-fetches full daily history
// for every constituent from Yahoo Finance (see yahoo-client.js) and
// recomputes the whole series from scratch, rather than incrementally
// appending one day: simpler and self-healing (a missed run or a
// mid-series data correction doesn't leave the blob out of sync).
//
// Uses the split/dividend-adjusted close so a stock split can't leave an
// artificially high pre-split price that blocks a stock from ever
// registering a new all-time high again. Yahoo's history goes back to a
// stock's listing (not capped at ~26 years like the previous source).

const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { getBreadthStore, BLOB_KEY } = require("./breadth-blob-store");
const { getDayChangeStore, BLOB_KEY: DAYCHANGE_BLOB_KEY } = require("./daychange-blob-store");
const { fetchDailyHistory } = require("./yahoo-client");

// Yahoo's history reaches back to 1970, but the earliest years have only a
// handful of stocks, so their breadth percentages are noise, and a
// cumulative A/D line starting there would sit at a completely different
// level. The published series starts where it always has.
const HISTORY_START = "1999-11-02";

const SMA_WINDOW = 200;
const HIGH_LOW_WINDOW = 252; // ~52 trading weeks

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SPY, for the ATH-ATL breadth chart's price overlay. Not a constituent,
// so it isn't part of BREADTH_CONSTITUENTS or the atHigh/atLow math, just
// a date-aligned close series to plot alongside.
async function fetchSpxDailyCloses() {
  const closes = await fetchDailyHistory("SPY");
  const byDate = new Map();
  for (const { date, close } of closes) byDate.set(date, close);
  return byDate;
}

// For a single name's closes, returns a map date -> { up, newHigh, newLow,
// above200sma, atHigh }. atHigh means today's close is at or above every
// prior close in the fetched history — i.e. a new all-time high as far
// back as Yahoo's daily data goes for that symbol (which for most
// of these liquid, long-listed names reaches back to the 1990s or the
// symbol's IPO, whichever is later — see the "all-time" caveat on the
// ath-index.html page).
function computeNameFlags(closes) {
  const flags = new Map();
  let runningMax = closes.length ? closes[0].close : -Infinity;
  let runningMin = closes.length ? closes[0].close : Infinity;

  for (let i = 1; i < closes.length; i++) {
    const { date, close } = closes[i];
    const prevClose = closes[i - 1].close;

    const highLowStart = Math.max(0, i - HIGH_LOW_WINDOW + 1);
    const windowSlice = closes.slice(highLowStart, i + 1);
    const windowHigh = Math.max(...windowSlice.map((p) => p.close));
    const windowLow = Math.min(...windowSlice.map((p) => p.close));

    let above200sma = null;
    if (i >= SMA_WINDOW - 1) {
      const smaSlice = closes.slice(i - SMA_WINDOW + 1, i + 1);
      const sma = smaSlice.reduce((sum, p) => sum + p.close, 0) / SMA_WINDOW;
      above200sma = close > sma;
    }

    const atHigh = close >= runningMax;
    runningMax = Math.max(runningMax, close);

    // Mirrors atHigh: today's close at or below every prior close in the
    // fetched history — same "as far back as the daily data
    // goes" caveat applies (see the ath-index.html "why two data
    // sources" explainer for the ATH side of this).
    const atLow = close <= runningMin;
    runningMin = Math.min(runningMin, close);

    flags.set(date, {
      up: close > prevClose,
      newHigh: close >= windowHigh,
      newLow: close <= windowLow,
      above200sma,
      atHigh,
      atLow,
    });
  }
  return flags;
}

// Cross-sectional % change distributions for the "Day's change
// distribution" widget's longer ranges (5D/MTD/QTD/YTD/5Y) — "1D" is
// owned by scheduled-daychange-background.js instead (see that file),
// since it needs to refresh hourly on a live quote rather than once a
// day against history this job already has in memory.
function baselineIndexOnOrBefore(closes, targetDate) {
  // closes sorted ascending by date (YYYY-MM-DD strings sort correctly).
  let best = -1;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i].date <= targetDate) best = i;
    else break;
  }
  return best;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function computeRangeSummaries(perNameCloses, constituentTotal) {
  // Latest trading date across the dataset — use whichever symbol has
  // the most recent last-row date, in case of a handful of stale fetches.
  let latestDate = null;
  for (const closes of perNameCloses.values()) {
    if (!closes.length) continue;
    const last = closes[closes.length - 1].date;
    if (!latestDate || last > latestDate) latestDate = last;
  }
  if (!latestDate) return {};

  const latest = new Date(latestDate + "T00:00:00Z");
  const monthStart = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), 1));
  const qMonth = Math.floor(latest.getUTCMonth() / 3) * 3;
  const quarterStart = new Date(Date.UTC(latest.getUTCFullYear(), qMonth, 1));
  const yearStart = new Date(Date.UTC(latest.getUTCFullYear(), 0, 1));
  const oneYearAgo = new Date(Date.UTC(latest.getUTCFullYear() - 1, latest.getUTCMonth(), latest.getUTCDate()));
  const threeYearsAgo = new Date(Date.UTC(latest.getUTCFullYear() - 3, latest.getUTCMonth(), latest.getUTCDate()));
  const fiveYearsAgo = new Date(Date.UTC(latest.getUTCFullYear() - 5, latest.getUTCMonth(), latest.getUTCDate()));

  const dayBefore = (d) => isoDate(new Date(d.getTime() - 24 * 60 * 60 * 1000));

  // "5D" is a trading-day lookback (nth-prior row), not a calendar
  // baseline date like the others, so it's keyed to null here and
  // special-cased in the loop below.
  const rangeBaselines = {
    "5D": null,
    MTD: dayBefore(monthStart),
    QTD: dayBefore(quarterStart),
    YTD: dayBefore(yearStart),
    "1Y": isoDate(oneYearAgo),
    "3Y": isoDate(threeYearsAgo),
    "5Y": isoDate(fiveYearsAgo),
  };

  // Anything longer than 1Y is annualized (CAGR) rather than shown as
  // cumulative total return — a 3-year cumulative +37% and a 5-year
  // cumulative +39% look almost identical but are very different
  // annual growth rates (+11%/yr vs. +7%/yr), and cumulative figures
  // across different multi-year horizons aren't comparable to each
  // other the way annualized ones are.
  const ANNUALIZE_YEARS = { "3Y": 3, "5Y": 5 };

  const ranges = {};

  for (const [rangeKey, baselineDate] of Object.entries(rangeBaselines)) {
    const changes = [];
    for (const [symbol, closes] of perNameCloses.entries()) {
      if (!closes.length) continue;
      const latestClose = closes[closes.length - 1].close;
      let baselineClose = null;
      if (rangeKey === "5D") {
        const idx = closes.length - 1 - 5;
        if (idx >= 0) baselineClose = closes[idx].close;
      } else {
        const idx = baselineIndexOnOrBefore(closes, baselineDate);
        if (idx >= 0) baselineClose = closes[idx].close;
      }
      if (baselineClose === null || baselineClose <= 0) continue;
      const ratio = latestClose / baselineClose;
      const years = ANNUALIZE_YEARS[rangeKey];
      const pct = years ? (ratio <= 0 ? null : (ratio ** (1 / years) - 1) * 100) : (ratio - 1) * 100;
      if (pct === null) continue;
      changes.push({ symbol, pctChange: Math.round(pct * 100) / 100 });
    }
    if (!changes.length) continue;
    changes.sort((a, b) => a.pctChange - b.pctChange);
    const values = changes.map((c) => c.pctChange);
    const n = values.length;
    const median = n % 2 === 1 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
    const mean = values.reduce((sum, v) => sum + v, 0) / n;
    const up = changes.filter((c) => c.pctChange > 0).length;
    const down = changes.filter((c) => c.pctChange < 0).length;
    ranges[rangeKey] = {
      n,
      total: constituentTotal,
      median: Math.round(median * 100) / 100,
      mean: Math.round(mean * 100) / 100,
      up,
      down,
      unchanged: n - up - down,
      annualized: !!ANNUALIZE_YEARS[rangeKey],
      changes,
    };
  }

  return { asOfDate: latestDate, ranges };
}

exports.handler = async () => {
  console.log(`scheduled-breadth-background: starting, ${BREADTH_CONSTITUENTS.length} symbols`);
  try {
    // Sequential with a short gap: Yahoo has no quota but 429s intermittently
    // (yahoo-client.js retries with backoff), plus a retry pass below for
    // whatever still fails.
    const perNameFlags = new Map();
    const perNameCloses = new Map();
    const failedSymbols = [];
    for (const symbol of BREADTH_CONSTITUENTS) {
      try {
        const closes = await fetchDailyHistory(symbol);
        perNameFlags.set(symbol, computeNameFlags(closes));
        perNameCloses.set(symbol, closes);
      } catch (err) {
        console.error(`scheduled-breadth-background: ${symbol} failed: ${err.message}`);
        failedSymbols.push(symbol);
      }
      await sleep(300);
    }

    if (failedSymbols.length) {
      console.log(`scheduled-breadth-background: retrying ${failedSymbols.length} failed symbol(s)`);
      for (const symbol of failedSymbols) {
        try {
          const closes = await fetchDailyHistory(symbol);
          perNameFlags.set(symbol, computeNameFlags(closes));
          perNameCloses.set(symbol, closes);
        } catch (err) {
          console.error(`scheduled-breadth-background: ${symbol} failed on retry: ${err.message}`);
        }
        await sleep(300);
      }
    }
    console.log(`scheduled-breadth-background: fetched ${perNameFlags.size}/${BREADTH_CONSTITUENTS.length} symbols`);

    let spxByDate = new Map();
    try {
      spxByDate = await fetchSpxDailyCloses();
    } catch (err) {
      console.error(`scheduled-breadth-background: SPX fetch failed: ${err.message}`);
    }
    await sleep(300);

    // Union of every date any name reported, so a single missing/delisted
    // name mid-history doesn't collapse the whole date range.
    const allDates = new Set();
    for (const flags of perNameFlags.values()) {
      for (const date of flags.keys()) allDates.add(date);
    }
    const sortedDates = [...allDates].sort().filter((d) => d >= HISTORY_START);

    const dailyRows = sortedDates.map((date) => {
      let advances = 0;
      let declines = 0;
      let newHighs = 0;
      let newLows = 0;
      let above200 = 0;
      let smaCoverage = 0;
      let atHighs = 0;
      let atLows = 0;

      for (const flags of perNameFlags.values()) {
        const f = flags.get(date);
        if (!f) continue;
        if (f.up) advances++;
        else declines++;
        if (f.newHigh) newHighs++;
        if (f.newLow) newLows++;
        if (f.above200sma !== null) {
          smaCoverage++;
          if (f.above200sma) above200++;
        }
        if (f.atHigh) atHighs++;
        if (f.atLow) atLows++;
      }

      const coverage = advances + declines;
      return {
        date,
        advances,
        declines,
        newHighs,
        newLows,
        pctAbove200sma: smaCoverage ? Math.round((above200 / smaCoverage) * 1000) / 10 : null,
        atHighs,
        pctAtHighs: coverage ? Math.round((atHighs / coverage) * 1000) / 10 : null,
        atLows,
        pctAtLows: coverage ? Math.round((atLows / coverage) * 1000) / 10 : null,
        spxClose: spxByDate.has(date) ? spxByDate.get(date) : null,
      };
    });

    let cumulative = 0;
    const rows = dailyRows.map((row) => {
      cumulative += row.advances - row.declines;
      return { ...row, adLine: cumulative };
    });

    // Snapshot of exactly which names are at an all-time high as of the
    // latest date, for display as a list (the daily rows above only carry
    // the aggregate count/percentage, not which names).
    const latestDate = sortedDates[sortedDates.length - 1];
    const athTickers = [];
    let athCoverage = 0;
    for (const [symbol, flags] of perNameFlags.entries()) {
      const f = flags.get(latestDate);
      if (!f) continue;
      athCoverage++;
      if (f.atHigh) athTickers.push(symbol);
    }
    athTickers.sort();

    const payload = {
      generated_at_utc: new Date().toISOString(),
      constituentCount: BREADTH_CONSTITUENTS.length,
      rows,
      athSummary: {
        asOfDate: latestDate,
        count: athTickers.length,
        total: athCoverage,
        pct: athCoverage ? Math.round((athTickers.length / athCoverage) * 1000) / 10 : null,
        tickers: athTickers,
      },
    };

    const store = getBreadthStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-breadth-background: wrote ${rows.length} rows to blob`);

    // Longer-range slices of the "Day's change distribution" widget
    // (5D/MTD/QTD/YTD/5Y) — computed here since the full close history
    // needed for them is already in memory; "1D" is owned by
    // scheduled-daychange-background.js instead (see that file), so this
    // read-modify-writes the shared blob rather than overwriting it wholesale.
    try {
      const { asOfDate: rangesAsOfDate, ranges } = computeRangeSummaries(perNameCloses, BREADTH_CONSTITUENTS.length);
      const dcStore = getDayChangeStore();
      const existingDayChange = (await dcStore.get(DAYCHANGE_BLOB_KEY, { type: "json" })) || {};
      const dayChangePayload = {
        ...existingDayChange,
        generated_at_utc: new Date().toISOString(),
        asOfDate: rangesAsOfDate,
        ranges: { ...(existingDayChange.ranges || {}), ...ranges },
      };
      await dcStore.setJSON(DAYCHANGE_BLOB_KEY, dayChangePayload);
      console.log(`scheduled-breadth-background: wrote ${Object.keys(ranges).join(", ")} ranges to daychange blob`);
    } catch (err) {
      console.error(`scheduled-breadth-background: day-change ranges failed (non-fatal): ${err.message}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, rows: rows.length }),
    };
  } catch (err) {
    console.error(`scheduled-breadth-background: FAILED: ${err.message}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
