// Scheduled function (see [functions."scheduled-breadth-background"] in
// netlify.toml) that computes real market breadth internals —
// advances/declines, 52-week new highs/lows, and % of constituents above
// their 200-day SMA — across a sample of liquid S&P 500 names, and writes
// the result to Netlify Blobs for breadth-internals.js to serve.
//
// Named with the "-background" suffix so Netlify runs it as a Background
// Function (up to 15 minutes) instead of a standard function (~30s) — a
// first attempt as a standard function got killed mid-run every time,
// since ~100 sequential Alpha Vantage calls (each pulling a symbol's full
// daily history) plus the required inter-call spacing takes well over 30s.
//
// Runs once daily after the close. Each run re-fetches full daily history
// for every constituent (TIME_SERIES_DAILY, outputsize=full) and recomputes
// the whole series from scratch, rather than incrementally appending one
// day — simpler and self-healing (a missed run or a mid-series data
// correction from Alpha Vantage doesn't leave the blob out of sync), and
// affordable since it only runs once a day, not per page load.

const { getStore } = require("@netlify/blobs");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SMA_WINDOW = 200;
const HIGH_LOW_WINDOW = 252; // ~52 trading weeks
const BLOB_STORE = "breadth";
const BLOB_KEY = "internals.json";

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
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=full&apikey=${apiKey}`
  );
  const series = payload["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      `Alpha Vantage TIME_SERIES_DAILY missing data for ${symbol}: ` +
        (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 200))
    );
  }
  return Object.entries(series)
    .map(([date, day]) => ({ date, close: parseFloat(day["4. close"]) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// For a single name's closes, returns a map date -> { up, newHigh, newLow, above200sma }.
function computeNameFlags(closes) {
  const flags = new Map();
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

    flags.set(date, {
      up: close > prevClose,
      newHigh: close >= windowHigh,
      newLow: close <= windowLow,
      above200sma,
    });
  }
  return flags;
}

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    // Sequential with a gap, same reasoning as data.js: Alpha Vantage trips
    // a burst-rate detector when requests land too close together even
    // when awaited one at a time.
    const perNameFlags = new Map();
    for (const symbol of BREADTH_CONSTITUENTS) {
      const closes = await fetchDailyCloses(apiKey, symbol);
      perNameFlags.set(symbol, computeNameFlags(closes));
      await sleep(300);
    }

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
      }

      return {
        date,
        advances,
        declines,
        newHighs,
        newLows,
        pctAbove200sma: smaCoverage ? Math.round((above200 / smaCoverage) * 1000) / 10 : null,
      };
    });

    let cumulative = 0;
    const rows = dailyRows.map((row) => {
      cumulative += row.advances - row.declines;
      return { ...row, adLine: cumulative };
    });

    const payload = {
      generated_at_utc: new Date().toISOString(),
      constituentCount: BREADTH_CONSTITUENTS.length,
      rows,
    };

    const store = getStore(BLOB_STORE);
    await store.setJSON(BLOB_KEY, payload);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, rows: rows.length }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
