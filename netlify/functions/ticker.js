// Fully in-house homepage ticker, replacing the TradingView embed.
// Uses the premium Alpha Vantage key's 15-min-delayed US stock data (and,
// when the account's entitled to it, real index levels for S&P 500/NASDAQ
// Composite/VIX via INDEX_DATA) plus a stock watchlist. When INDEX_DATA
// isn't available on this account's current plan tier — which has flipped
// on and off over time — fetchIndexWithProxy falls back to an ETF proxy
// quote (SPY/ONEQ/VIXY) instead of silently dropping that item from the
// ticker. MSCI World still has no real free index feed, so it stays on
// its ETF tracker (URTH).
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Alpha Vantage returns rate-limit errors as HTTP 200 with an
// {"error": {...}} body, not a non-2xx status, so res.ok alone can't
// detect them. Retries once after a pause since these are transient
// per-second burst blips, not persistent failures.
async function fetchJson(params, attempt = 1) {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  const res = await fetch(`${ALPHA_VANTAGE_URL}?${params}&apikey=${apiKey}`);
  const payload = res.ok ? await res.json() : null;
  const isRateLimited = !res.ok || payload.error || payload.Note || payload.Information;
  if (isRateLimited) {
    if (attempt < 2) {
      await sleep(1000);
      return fetchJson(params, attempt + 1);
    }
    throw new Error(`Failed after retries for ${params}: ${payload ? JSON.stringify(payload).slice(0, 150) : `HTTP ${res.status}`}`);
  }
  return payload;
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

// INDEX_DATA needs a higher Alpha Vantage plan tier than this account
// currently has ("not yet entitled to index data access" — confirmed live,
// not a transient rate-limit blip like the burst-pattern errors fetchJson
// already retries). Rather than silently dropping S&P 500/NASDAQ/VIX from
// the ticker whenever that's the case, fall back to an ETF proxy quote via
// the GLOBAL_QUOTE endpoint this key does have access to (same proxies
// used before this ticker had real index data — see git history).
async function fetchIndexWithProxy(symbol, label, proxySymbol, proxyLabel) {
  try {
    return await fetchIndex(symbol, label);
  } catch (err) {
    return await fetchQuote(proxySymbol, proxyLabel);
  }
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

// Firing all ~23 calls at once trips Alpha Vantage's per-second burst
// limit even on the premium key (confirmed empirically - 5 concurrent
// succeeded, 17 concurrent had roughly half fail). Batching in groups of
// 5 with a short pause between batches stays under that ceiling.
//
// Each task is wrapped so a single failing symbol (delisted ticker,
// transient API hiccup, or an endpoint the current key isn't entitled to
// — e.g. INDEX_DATA) drops just that item instead of failing the whole
// batch: 23 independent quotes have nothing to do with each other, and
// one bad one shouldn't blank out the other 22.
async function batched(tasks, batchSize, delayMs) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize).map((fn) =>
      fn().catch((err) => ({ __failed: true, message: err.message }))
    );
    results.push(...(await Promise.all(batch)));
    if (i + batchSize < tasks.length) await sleep(delayMs);
  }
  return results;
}

exports.handler = async () => {
  try {
    if (!process.env.ALPHAVANTAGE_API_KEY) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const tasks = [
      () => fetchIndexWithProxy("SPX", "S&P 500", "SPY", "S&P 500 (SPY proxy)"),
      () => fetchIndexWithProxy("COMP", "NASDAQ Composite", "ONEQ", "NASDAQ Composite (ONEQ proxy)"),
      () => fetchIndexWithProxy("VIX", "VIX", "VIXY", "VIX (VIXY proxy)"),
      () => fetchFedFunds(),
      () => fetchQuote("URTH", "MSCI World Index (URTH)"),
      () => fetchWti(),
      ...STOCKS.map((s) => () => fetchQuote(s, s)),
    ];

    const results = await batched(tasks, 5, 800);
    const items = results.filter((r) => !r.__failed);
    const warnings = results.filter((r) => r.__failed).map((r) => r.message);

    if (!items.length) {
      throw new Error("All ticker items failed to load" + (warnings.length ? ": " + warnings.join("; ") : ""));
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ items, warnings }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
