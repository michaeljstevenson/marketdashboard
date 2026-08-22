// Scheduled Background Function (see [functions."scheduled-sectors-background"]
// in netlify.toml) that computes performance across the 11 SPDR sector ETFs
// plus SPY as a benchmark, across a range of standard timeframes, and writes
// the result to Netlify Blobs for sector-performance.js to serve. Also
// carries a trimmed ~2-year daily close history per ticker (reusing the
// full history already fetched for the return calculations, no extra API
// calls) for the sector-analysis.html performance chart.
//
// Named with the "-background" suffix for the same reason as
// scheduled-breadth-background.js: fetching full daily history for 12
// symbols sequentially (with required inter-call spacing to avoid Alpha
// Vantage's burst limiter) takes well over the ~30s a standard function
// gets, so this needs a Background Function's up-to-15-minute window.
//
// Runs once daily after the close. Each run re-fetches full daily history
// for every ticker (TIME_SERIES_DAILY_ADJUSTED, outputsize=full) and
// recomputes every return from scratch rather than incrementally, for the
// same reasons as the breadth job: simpler and self-healing.
//
// Uses the split/dividend-adjusted close, not the raw close: plain
// TIME_SERIES_DAILY doesn't retroactively adjust historical prices for
// splits, so a sector ETF that split within the lookback window (this
// happened with XLK, discovered when its "1Y" return came back as -28%
// instead of the real ~+40%) produces wildly wrong trailing returns.
// Adjusted close bundles in dividend reinvestment too, so these are true
// total returns, not price-only returns.

const { getSectorStore, BLOB_KEY } = require("./sector-blob-store");
const { recordAvCall } = require("./av-call-counter");

const HISTORY_POINTS = 504; // ~2 trading years, same convention as data.js

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// The 11 SPDR sector ETFs, plus SPY as the market-cap-weighted S&P 500
// benchmark used for relative (excess-return) performance.
const SECTORS = [
  { ticker: "XLK", name: "Technology" },
  { ticker: "XLF", name: "Financials" },
  { ticker: "XLV", name: "Health Care" },
  { ticker: "XLE", name: "Energy" },
  { ticker: "XLI", name: "Industrials" },
  { ticker: "XLY", name: "Consumer Discretionary" },
  { ticker: "XLP", name: "Consumer Staples" },
  { ticker: "XLU", name: "Utilities" },
  { ticker: "XLB", name: "Materials" },
  { ticker: "XLRE", name: "Real Estate" },
  { ticker: "XLC", name: "Communication Services" },
];
const BENCHMARK = { ticker: "SPY", name: "S&P 500" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  await recordAvCall();
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

function addMonths(dateObj, months) {
  const d = new Date(dateObj);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function startOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfQuarter(d) {
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
}

function startOfYear(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

// Finds the closing price on the latest trading day on or before
// targetDateStr. closes must be sorted ascending by date. Since lookback
// windows here span at most ~20 years of daily data, a backward linear
// scan is simple and fast enough for a once-a-day background job.
function closeOnOrBefore(closes, targetDateStr) {
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i].date <= targetDateStr) return closes[i];
  }
  return null;
}

function pctChange(latest, base) {
  if (base === null || base === undefined || base === 0) return null;
  return (latest / base - 1) * 100;
}

// Computes every standard timeframe return for one ticker's close series,
// anchored to its own latest available trading day.
function computeReturns(closes) {
  if (!closes.length) return null;
  const latest = closes[closes.length - 1];
  const latestDate = new Date(latest.date + "T00:00:00Z");

  const prev1d = closes.length >= 2 ? closes[closes.length - 2] : null;
  const prev1w = closeOnOrBefore(closes.slice(0, -1), toDateStr(new Date(latestDate.getTime() - 7 * 86400000)));

  const mtdBase = closeOnOrBefore(closes, toDateStr(new Date(startOfMonth(latestDate).getTime() - 86400000)));
  const qtdBase = closeOnOrBefore(closes, toDateStr(new Date(startOfQuarter(latestDate).getTime() - 86400000)));
  const ytdBase = closeOnOrBefore(closes, toDateStr(new Date(startOfYear(latestDate).getTime() - 86400000)));

  const m1Base = closeOnOrBefore(closes, toDateStr(addMonths(latestDate, -1)));
  const m3Base = closeOnOrBefore(closes, toDateStr(addMonths(latestDate, -3)));
  const m6Base = closeOnOrBefore(closes, toDateStr(addMonths(latestDate, -6)));
  const y1Base = closeOnOrBefore(closes, toDateStr(addMonths(latestDate, -12)));

  return {
    asOfDate: latest.date,
    latestClose: latest.close,
    returns: {
      d1: pctChange(latest.close, prev1d ? prev1d.close : null),
      w1: pctChange(latest.close, prev1w ? prev1w.close : null),
      mtd: pctChange(latest.close, mtdBase ? mtdBase.close : null),
      qtd: pctChange(latest.close, qtdBase ? qtdBase.close : null),
      ytd: pctChange(latest.close, ytdBase ? ytdBase.close : null),
      m1: pctChange(latest.close, m1Base ? m1Base.close : null),
      m3: pctChange(latest.close, m3Base ? m3Base.close : null),
      m6: pctChange(latest.close, m6Base ? m6Base.close : null),
      y1: pctChange(latest.close, y1Base ? y1Base.close : null),
    },
  };
}

function relativeReturns(sectorReturns, benchmarkReturns) {
  const rel = {};
  for (const key of Object.keys(sectorReturns)) {
    const s = sectorReturns[key];
    const b = benchmarkReturns[key];
    rel[key] = s === null || b === null ? null : Math.round((s - b) * 100) / 100;
  }
  return rel;
}

exports.handler = async () => {
  console.log(`scheduled-sectors-background: starting, ${SECTORS.length} sectors + benchmark`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const allTickers = [BENCHMARK, ...SECTORS];
    const computed = new Map();

    // 800ms between calls (not the 300ms used elsewhere) — those other jobs
    // fetch short trailing windows, while this one pulls full daily history
    // (outputsize=full) for 12 symbols back-to-back, which was tripping
    // Alpha Vantage's burst limiter partway through the run and silently
    // dropping whichever tickers landed on the throttled calls (e.g. only
    // 7/11 sectors loading, a different 4 missing each run).
    for (const { ticker } of allTickers) {
      try {
        const closes = await fetchDailyCloses(apiKey, ticker);
        computed.set(ticker, { returns: computeReturns(closes), history: closes.slice(-HISTORY_POINTS) });
      } catch (err) {
        console.error(`scheduled-sectors-background: ${ticker} failed: ${err.message}`);
      }
      await sleep(800);
    }

    // Retry pass: any ticker that failed above gets one more attempt after
    // the rest of the batch has had time to clear the rate-limit window,
    // rather than leaving the page permanently short until tomorrow's run.
    const missing = allTickers.filter(({ ticker }) => !computed.has(ticker));
    if (missing.length) {
      console.log(`scheduled-sectors-background: retrying ${missing.length} failed ticker(s): ${missing.map((t) => t.ticker).join(", ")}`);
      await sleep(2000);
      for (const { ticker } of missing) {
        try {
          const closes = await fetchDailyCloses(apiKey, ticker);
          computed.set(ticker, { returns: computeReturns(closes), history: closes.slice(-HISTORY_POINTS) });
        } catch (err) {
          console.error(`scheduled-sectors-background: ${ticker} retry failed: ${err.message}`);
        }
        await sleep(800);
      }
    }

    console.log(`scheduled-sectors-background: fetched ${computed.size}/${allTickers.length} tickers`);

    const benchmark = computed.get(BENCHMARK.ticker);
    if (!benchmark) throw new Error("Benchmark (SPY) failed to load — cannot compute relative performance");

    const roundReturns = (returns) =>
      Object.fromEntries(Object.entries(returns).map(([k, v]) => [k, v === null ? null : Math.round(v * 100) / 100]));
    const roundHistory = (history) => history.map((h) => ({ date: h.date, close: Math.round(h.close * 100) / 100 }));

    const sectors = SECTORS.map(({ ticker, name }) => {
      const entry = computed.get(ticker);
      if (!entry) return null;
      return {
        ticker,
        name,
        asOfDate: entry.returns.asOfDate,
        latestClose: Math.round(entry.returns.latestClose * 100) / 100,
        returns: roundReturns(entry.returns.returns),
        relative: relativeReturns(entry.returns.returns, benchmark.returns.returns),
        history: roundHistory(entry.history),
      };
    }).filter(Boolean);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      benchmark: {
        ticker: BENCHMARK.ticker,
        name: BENCHMARK.name,
        asOfDate: benchmark.returns.asOfDate,
        latestClose: Math.round(benchmark.returns.latestClose * 100) / 100,
        returns: roundReturns(benchmark.returns.returns),
        history: roundHistory(benchmark.history),
      },
      sectors,
    };

    const store = getSectorStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-sectors-background: wrote ${sectors.length} sectors to blob`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, sectors: sectors.length }),
    };
  } catch (err) {
    console.error(`scheduled-sectors-background: FAILED: ${err.message}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
