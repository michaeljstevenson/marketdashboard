// Scheduled function (see netlify.toml) that fetches full daily price
// history for SPY and URTH from Yahoo Finance and writes it to Netlify
// Blobs for drawdown-history.js. Not an Alpha Vantage job, so it doesn't
// touch that quota.
//
// Bare User-Agent on purpose: Yahoo's chart endpoint 429s browser-style
// UAs on multi-year ranges (see scheduled-seasonality-background.js).

const { getDrawdownStore, BLOB_KEY } = require("./drawdown-blob-store");

const SYMBOLS = ["SPY", "URTH"];
const USER_AGENT = "Mozilla/5.0";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDaily(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
    `?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
      const payload = await res.json();
      const result = payload.chart && payload.chart.result && payload.chart.result[0];
      if (!result) throw new Error(`Yahoo returned no data for ${symbol}`);
      const ts = result.timestamp || [];
      const closes = result.indicators.quote[0].close || [];
      const rows = [];
      ts.forEach((t, i) => {
        if (closes[i] == null) return;
        rows.push([new Date(t * 1000).toISOString().slice(0, 10), Math.round(closes[i] * 10000) / 10000]);
      });
      return rows;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

exports.handler = async () => {
  const series = {};
  for (const symbol of SYMBOLS) {
    series[symbol] = await fetchDaily(symbol);
    await sleep(500);
  }
  await getDrawdownStore().setJSON(BLOB_KEY, {
    generated_at_utc: new Date().toISOString(),
    note: "Unadjusted daily closes [date, close] from Yahoo Finance.",
    series,
  });
};
