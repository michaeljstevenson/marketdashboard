// Shared Yahoo Finance fetchers for the scheduled jobs and functions that
// moved off Alpha Vantage (sectors, countries, concentration-market,
// ticker, daychange). No API key or quota, but Yahoo 429s intermittently,
// so everything here retries with backoff.
//
// Bare User-Agent on purpose: Yahoo's chart endpoint 429s browser-style
// UAs on multi-year ranges (see scheduled-seasonality-background.js).

const USER_AGENT = "Mozilla/5.0";
const SPARK_BATCH_SIZE = 20; // spark returns HTTP 400 above 20 symbols per call

// Symbols the site's constituent lists still use under their old ticker but
// Yahoo only serves under the new one (BNY Mellon rebrand, Marsh McLennan
// rename). Results are keyed back to the original symbol.
const YAHOO_ALIASES = { BK: "BNY", MMC: "MRSH" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchYahooJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Full daily history as [{ date, close }] ascending. `adjusted` selects the
// split/dividend-adjusted close (matches Alpha Vantage's "5. adjusted
// close"); otherwise the raw close. Bars with a null close (Yahoo pads
// halted/incomplete days) are dropped.
async function fetchDailyHistory(symbol, { adjusted = true } = {}) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_ALIASES[symbol] || symbol)}` +
    `?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=div,splits`;
  const payload = await fetchYahooJson(url);
  const result = payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) throw new Error(`Yahoo returned no data for ${symbol}`);
  const ts = result.timestamp || [];
  const closes =
    (adjusted && result.indicators.adjclose && result.indicators.adjclose[0].adjclose) ||
    result.indicators.quote[0].close ||
    [];
  const out = [];
  ts.forEach((t, i) => {
    if (closes[i] == null) return;
    out.push({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] });
  });
  if (!out.length) throw new Error(`Yahoo returned no closes for ${symbol}`);
  return out;
}

// Latest price and previous close for many symbols at once (one call per
// 20 symbols). Returns Map(symbol -> { price, prevClose }); symbols Yahoo
// has no two-bar history for are simply absent from the map, like a failed
// per-symbol Alpha Vantage quote used to be.
async function fetchQuotes(symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += SPARK_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SPARK_BATCH_SIZE);
    const yahooSymbol = (s) => YAHOO_ALIASES[s] || s;
    const payload = await fetchYahooJson(
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${batch.map((s) => encodeURIComponent(yahooSymbol(s))).join(",")}&range=5d&interval=1d`
    );
    for (const symbol of batch) {
      const entry = payload[yahooSymbol(symbol)];
      const closes = ((entry && entry.close) || []).filter((c) => c != null);
      if (closes.length < 2) continue;
      out.set(symbol, { price: closes[closes.length - 1], prevClose: closes[closes.length - 2] });
    }
  }
  return out;
}

async function fetchChartResult(symbol, { interval = "1d", events = "div,splits" } = {}) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_ALIASES[symbol] || symbol)}` +
    `?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=${interval}&events=${events}`;
  const payload = await fetchYahooJson(url);
  const result = payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) throw new Error(`Yahoo returned no data for ${symbol}`);
  return result;
}

const isoDate = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// Full daily OHLCV + adjusted close, ascending. Rows Yahoo pads with null
// closes (halted/incomplete days) are dropped.
async function fetchDailyBars(symbol) {
  const result = await fetchChartResult(symbol);
  const q = result.indicators.quote[0];
  const adj = (result.indicators.adjclose && result.indicators.adjclose[0].adjclose) || q.close;
  const out = [];
  (result.timestamp || []).forEach((t, i) => {
    if (q.close[i] == null || adj[i] == null) return;
    out.push({ date: isoDate(t), high: q.high[i], low: q.low[i], close: q.close[i], adjClose: adj[i], volume: q.volume[i] });
  });
  if (!out.length) throw new Error(`Yahoo returned no closes for ${symbol}`);
  return out;
}

// Cash dividends as [{ date (ex-date), amount }] ascending, split-adjusted
// per share like Alpha Vantage's DIVIDENDS.
async function fetchDividendEvents(symbol) {
  const result = await fetchChartResult(symbol, { interval: "1mo", events: "div" });
  const divs = (result.events && result.events.dividends) || {};
  return Object.values(divs)
    .map((d) => ({ date: isoDate(d.date), amount: d.amount }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Splits as [{ date, factor }] ascending, factor = new shares per old share
// (4-for-1 => 4, 1-for-10 reverse => 0.1), same convention as Alpha Vantage's
// SPLITS split_factor.
async function fetchSplitEvents(symbol) {
  const result = await fetchChartResult(symbol, { interval: "1mo", events: "splits" });
  const splits = (result.events && result.events.splits) || {};
  return Object.values(splits)
    .map((s) => ({ date: isoDate(s.date), factor: s.numerator / s.denominator }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Month-end closes as [{ date (last trading day of month), close }], built
// from daily bars so dates line up with Alpha Vantage's FX_MONTHLY rather
// than Yahoo's first-of-month monthly bars.
async function fetchMonthEndCloses(symbol) {
  const daily = await fetchDailyHistory(symbol, { adjusted: false });
  const byMonth = new Map();
  for (const row of daily) byMonth.set(row.date.slice(0, 7), row);
  return [...byMonth.values()];
}

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

// Intraday bars for many symbols at once (20 per spark call), regular
// session only. Returns Map(symbol -> { "YYYY-MM-DD": [{ time: "HH:MM", close }] })
// in New York time, bars ascending; `time` is the bar's start and `close`
// its last price, so the 15:45 bar closes at 16:00. Symbols Yahoo returns
// nothing for are absent from the map.
async function fetchIntradayBatch(symbols, { range = "5d", interval = "15m" } = {}) {
  const out = new Map();
  const yahooSymbol = (s) => YAHOO_ALIASES[s] || s;
  for (let i = 0; i < symbols.length; i += SPARK_BATCH_SIZE) {
    const batch = symbols.slice(i, i + SPARK_BATCH_SIZE);
    const payload = await fetchYahooJson(
      `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${batch.map((s) => encodeURIComponent(yahooSymbol(s))).join(",")}&range=${range}&interval=${interval}`
    );
    for (const symbol of batch) {
      const e = payload[yahooSymbol(symbol)];
      if (!e || !e.timestamp || !e.close) continue;
      const byDate = {};
      e.timestamp.forEach((t, k) => {
        if (e.close[k] == null) return;
        const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
        (byDate[`${p.year}-${p.month}-${p.day}`] ||= []).push({ time: `${p.hour}:${p.minute}`, close: e.close[k] });
      });
      if (Object.keys(byDate).length) out.set(symbol, byDate);
    }
  }
  return out;
}

module.exports = {
  fetchDailyHistory,
  fetchDailyBars,
  fetchDividendEvents,
  fetchSplitEvents,
  fetchMonthEndCloses,
  fetchQuotes,
  fetchIntradayBatch,
  sleep,
};
