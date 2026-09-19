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
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
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

module.exports = { fetchDailyHistory, fetchQuotes, sleep };
