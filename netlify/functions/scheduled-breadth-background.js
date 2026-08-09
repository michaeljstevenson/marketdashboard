// Scheduled function (see [functions."scheduled-breadth-background"] in
// netlify.toml) that computes real market breadth internals —
// advances/declines, 52-week new highs/lows, % of constituents above
// their 200-day SMA, and % at all-time highs — across the full S&P 500
// constituent list (see breadth-constituents.js), and writes the result
// to Netlify Blobs for breadth-internals.js to serve.
//
// Named with the "-background" suffix so Netlify runs it as a Background
// Function (up to 15 minutes) instead of a standard function (~30s) — a
// first attempt as a standard function got killed mid-run every time,
// since ~500 sequential Alpha Vantage calls (each pulling a symbol's full
// daily history) plus the required inter-call spacing takes several
// minutes, well over the ~30s a standard function gets (though still
// comfortably within a Background Function's 15-minute window).
//
// Runs once daily after the close. Each run re-fetches full daily history
// for every constituent (TIME_SERIES_DAILY_ADJUSTED, outputsize=full) and
// recomputes the whole series from scratch, rather than incrementally
// appending one day — simpler and self-healing (a missed run or a
// mid-series data correction from Alpha Vantage doesn't leave the blob
// out of sync), and affordable since it only runs once a day, not per
// page load.
//
// Uses the split/dividend-adjusted close, not the raw close — the same
// fix applied to scheduled-sectors-background.js after discovering
// TIME_SERIES_DAILY doesn't retroactively adjust historical prices for
// splits. That's especially critical for all-time-high detection here: an
// unadjusted pre-split price looks artificially high forever afterward,
// permanently (and wrongly) blocking a stock from ever registering a new
// all-time high again.

const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { getBreadthStore, BLOB_KEY } = require("./breadth-blob-store");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SMA_WINDOW = 200;
const HIGH_LOW_WINDOW = 252; // ~52 trading weeks

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchDailyCloses(apiKey, symbol) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${apiKey}`
  );
  const series = payload["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      `Alpha Vantage TIME_SERIES_DAILY_ADJUSTED missing data for ${symbol}: ` +
        (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 200))
    );
  }
  return Object.entries(series)
    .map(([date, day]) => ({ date, close: parseFloat(day["5. adjusted close"]) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// SPX itself, for the ATH-ATL breadth chart's price overlay — not a
// constituent, so it isn't part of BREADTH_CONSTITUENTS or the atHigh/
// atLow math above, just a date-aligned close series to plot alongside.
async function fetchSpxDailyCloses(apiKey) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=INDEX_DATA&symbol=SPX&interval=daily&apikey=${apiKey}`
  );
  const data = payload.data;
  if (!data || !data.length) {
    throw new Error(
      `Alpha Vantage INDEX_DATA missing data for SPX: ` +
        (payload.Note || payload.Information || payload.error || JSON.stringify(payload).slice(0, 200))
    );
  }
  const byDate = new Map();
  for (const d of data) byDate.set(d.date, parseFloat(d.close));
  return byDate;
}

// For a single name's closes, returns a map date -> { up, newHigh, newLow,
// above200sma, atHigh }. atHigh means today's close is at or above every
// prior close in the fetched history — i.e. a new all-time high as far
// back as Alpha Vantage's daily data goes for that symbol (which for most
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
    // fetched history — same "as far back as Alpha Vantage's daily data
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

exports.handler = async () => {
  console.log(`scheduled-breadth-background: starting, ${BREADTH_CONSTITUENTS.length} symbols`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    // Sequential with a gap, same reasoning as data.js: Alpha Vantage trips
    // a burst-rate detector when requests land too close together even
    // when awaited one at a time.
    const perNameFlags = new Map();
    for (const symbol of BREADTH_CONSTITUENTS) {
      try {
        const closes = await fetchDailyCloses(apiKey, symbol);
        perNameFlags.set(symbol, computeNameFlags(closes));
      } catch (err) {
        console.error(`scheduled-breadth-background: ${symbol} failed: ${err.message}`);
      }
      await sleep(300);
    }
    console.log(`scheduled-breadth-background: fetched ${perNameFlags.size}/${BREADTH_CONSTITUENTS.length} symbols`);

    let spxByDate = new Map();
    try {
      spxByDate = await fetchSpxDailyCloses(apiKey);
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
    const sortedDates = [...allDates].sort();

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
