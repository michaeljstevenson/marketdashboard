// Fully in-house homepage ticker, replacing the TradingView embed.
// Uses the premium Alpha Vantage key's entitlements (15-min delayed US
// stock data + historical/major index data) to show real index levels
// (S&P 500, NASDAQ Composite, VIX) instead of ETF/CFD proxies, plus a
// stock watchlist. MSCI World still has no real free index feed, so it
// stays on its ETF tracker (URTH).
//
// Cached for 60s: with ~23 upstream calls per refresh and a premium key
// rated for 75 calls/minute, refreshing once a minute keeps us at ~23
// calls/min regardless of visitor traffic (edge caching decouples the
// two) — comfortably under the cap with room to spare.

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

const STOCKS = [
  "NVDA", "AAPL", "GOOG", "MSFT", "AMZN", "JPM", "MU", "V", "JNJ", "BAC",
  "SPCX", "META", "TSLA", "QCOM", "INTC", "IBM", "PLTR",
];

async function fetchJson(params) {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  const res = await fetch(`${ALPHA_VANTAGE_URL}?${params}&apikey=${apiKey}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${params}`);
  return res.json();
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function fetchIndex(symbol, label) {
  const payload = await fetchJson(`function=INDEX_DATA&symbol=${symbol}&interval=daily`);
  const data = payload.data;
  if (!data || data.length < 2) throw new Error(`Missing INDEX_DATA for ${symbol}`);
  const latest = parseFloat(data[0].close);
  const prev = parseFloat(data[1].close);
  return {
    label,
    value: round(latest, 2),
    changePercent: round(((latest - prev) / prev) * 100, 2),
  };
}

async function fetchQuote(symbol, label) {
  const payload = await fetchJson(`function=GLOBAL_QUOTE&symbol=${symbol}&entitlement=delayed`);
  const q = payload["Global Quote - DATA DELAYED BY 15 MINUTES"] || payload["Global Quote"];
  if (!q) throw new Error(`Missing GLOBAL_QUOTE for ${symbol}`);
  return {
    label,
    value: round(parseFloat(q["05. price"]), 2),
    changePercent: round(parseFloat(q["10. change percent"].replace("%", "")), 2),
  };
}

async function fetchWti() {
  const payload = await fetchJson("function=WTI&interval=daily");
  const data = payload.data;
  if (!data || data.length < 2) throw new Error("Missing WTI data");
  const latest = parseFloat(data[0].value);
  const prev = parseFloat(data[1].value);
  return {
    label: "WTI Crude Oil",
    value: round(latest, 2),
    changePercent: round(((latest - prev) / prev) * 100, 2),
  };
}

async function fetchFedFunds() {
  const payload = await fetchJson("function=FEDERAL_FUNDS_RATE&interval=daily");
  const data = payload.data;
  if (!data || !data.length) throw new Error("Missing Fed Funds data");
  return {
    label: "Fed Funds Rate",
    value: round(parseFloat(data[0].value), 2),
    changePercent: null,
    isRate: true,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Firing all ~23 calls at once trips Alpha Vantage's per-second burst
// limit even on the premium key (confirmed empirically - 5 concurrent
// succeeded, 17 concurrent had roughly half fail). Batching in groups of
// 5 with a short pause between batches stays under that ceiling.
async function batched(tasks, batchSize, delayMs) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize).map((fn) => fn());
    results.push(...(await Promise.all(batch)));
    if (i + batchSize < tasks.length) await sleep(delayMs);
  }
  return results;
}

exports.handler = async () => {
  try {
    if (!process.env.ALPHAVANTAGE_API_KEY) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const tasks = [
      () => fetchIndex("SPX", "S&P 500"),
      () => fetchIndex("COMP", "NASDAQ Composite"),
      () => fetchIndex("VIX", "VIX"),
      () => fetchFedFunds(),
      () => fetchQuote("URTH", "MSCI World Index (URTH)"),
      () => fetchWti(),
      ...STOCKS.map((s) => () => fetchQuote(s, s)),
    ];

    const items = await batched(tasks, 5, 800);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ items }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
