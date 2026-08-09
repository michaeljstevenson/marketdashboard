// Scheduled function (see [functions."scheduled-ticker-background"] in
// netlify.toml) that refreshes the homepage ticker tape's data and writes
// it to Netlify Blobs for ticker.js to serve.
//
// This used to be fetched live on every /api/ticker request (23 Alpha
// Vantage calls, edge-cached 60s). Expanding the stock watchlist to the
// ~150 largest US companies by market cap (see ticker-constituents.js,
// per request) made that no longer viable live: ~156 upstream calls per
// refresh, and even edge caching only decouples call volume from visitor
// traffic down to "at least once per cache window" — at 60s that's
// ~156 calls/min sustained, blowing well past the premium key's 75
// calls/minute cap. Named with the "-background" suffix so Netlify runs
// it as a Background Function (up to 15 minutes) rather than a standard
// function, matching scheduled-breadth-background.js's reasoning — this
// job deliberately paces itself to ~2.5 minutes (see the batched() call
// below) to stay under that same per-minute cap, well past what a
// standard function's much tighter timeout would allow.
//
// Runs every 15 minutes during US market hours on weekdays (see the cron
// schedule in netlify.toml) — frequent enough to feel current, and with
// ~2.5 minutes of actual runtime per call, still a small fraction of each
// 15-minute window.

const { TICKER_CONSTITUENTS } = require("./ticker-constituents");
const { getTickerStore, BLOB_KEY } = require("./ticker-blob-store");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

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

async function fetchQuote(symbol, label) {
  const payload = await fetchJson(`function=GLOBAL_QUOTE&symbol=${symbol}&entitlement=delayed`);
  const q = payload["Global Quote - DATA DELAYED BY 15 MINUTES"] || payload["Global Quote"];
  if (!q || !q["05. price"] || !q["10. change percent"]) {
    throw new Error(`Incomplete GLOBAL_QUOTE for ${symbol}: ${JSON.stringify(payload).slice(0, 150)}`);
  }
  return {
    label,
    value: round(parseFloat(q["05. price"]), 2),
    changePercent: round(parseFloat(q["10. change percent"].replace("%", "")), 2),
  };
}

// INDEX_DATA needs a higher Alpha Vantage plan tier than this account
// currently has ("not yet entitled to index data access" — confirmed
// live). Rather than dropping S&P 500/NASDAQ/VIX whenever that's the
// case, fall back to a GLOBAL_QUOTE-based ETF proxy this key does have
// access to.
async function fetchIndexWithProxy(symbol, label, proxySymbol, proxyLabel) {
  try {
    return await fetchIndex(symbol, label);
  } catch (err) {
    return await fetchQuote(proxySymbol, proxyLabel);
  }
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

// Firing everything at once trips Alpha Vantage's per-second burst limit
// even on the premium key (confirmed empirically). ticker.js's old live
// fetch used 5-per-800ms for its ~23 calls, which finished well inside a
// minute so the *per-minute* cap (75/min on this plan) never came into
// play — but that pacing is ~375 calls/min sustained, and with ~156
// calls here that's fast enough to burn through the whole per-minute
// quota before the run is even a quarter done (confirmed: an earlier run
// at 800ms got the first ~130 through, then every later call failed with
// "Minute-level rate limit exceed"). 5-per-4500ms keeps sustained
// throughput to ~67/min, comfortably under the cap, at the cost of the
// full run taking ~2.5 minutes instead of ~25 seconds — acceptable here
// since this always runs as a background job, never on the request path.
//
// Each task is wrapped so a single failing symbol (delisted ticker,
// transient API hiccup) drops just that item instead of failing the
// whole batch.
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
  console.log(`scheduled-ticker-background: starting, ${TICKER_CONSTITUENTS.length} constituents`);
  try {
    if (!process.env.ALPHAVANTAGE_API_KEY) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const tasks = [
      () => fetchIndexWithProxy("SPX", "S&P 500", "SPY", "S&P 500 (SPY proxy)"),
      () => fetchIndexWithProxy("COMP", "NASDAQ Composite", "ONEQ", "NASDAQ Composite (ONEQ proxy)"),
      () => fetchIndexWithProxy("VIX", "VIX", "VIXY", "VIX (VIXY proxy)"),
      () => fetchFedFunds(),
      () => fetchQuote("URTH", "MSCI World Index (URTH)"),
      () => fetchWti(),
      ...TICKER_CONSTITUENTS.map((s) => () => fetchQuote(s, s)),
    ];

    const results = await batched(tasks, 5, 4500);
    const items = results.filter((r) => !r.__failed);
    const warnings = results.filter((r) => r.__failed).map((r) => r.message);

    if (!items.length) {
      throw new Error("All ticker items failed to load" + (warnings.length ? ": " + warnings.join("; ") : ""));
    }

    console.log(`scheduled-ticker-background: ${items.length}/${tasks.length} items loaded, ${warnings.length} failed`);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      items,
      warnings,
    };

    const store = getTickerStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-ticker-background: wrote ${items.length} items to blob`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, items: items.length, warnings: warnings.length }),
    };
  } catch (err) {
    console.error(`scheduled-ticker-background: FAILED: ${err.message}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
