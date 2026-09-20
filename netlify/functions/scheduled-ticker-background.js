// Scheduled function (see [functions."scheduled-ticker-background"] in
// netlify.toml) that refreshes the homepage ticker tape's data and writes
// it to Netlify Blobs for ticker.js to serve.
//
// Every quote comes from Yahoo Finance's batched spark endpoint (20 symbols
// per call, see yahoo-client.js): the indices (S&P 500, NASDAQ Composite,
// VIX, MSCI World), WTI crude, and the 20-stock watchlist (see
// ticker-constituents.js), so one refresh is two calls. Only the Fed Funds
// rate still comes from Alpha Vantage (Yahoo has no equivalent series), and
// since it barely moves intraday it is refreshed at most every
// SLOW_ITEM_TTL_MS and otherwise carried over from the previous blob.
//
// Runs every 2 minutes during US market hours on weekdays (see the cron
// schedule in netlify.toml, and the overlap lock right below).

const { TICKER_CONSTITUENTS } = require("./ticker-constituents");
const { getTickerStore, BLOB_KEY } = require("./ticker-blob-store");
const { recordAvCall } = require("./av-call-counter");
const { fetchQuotes } = require("./yahoo-client");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

// Runs are now fast (seconds), but the lock is kept so a slow Yahoo retry
// pass can't be raced by the next 2-minute trigger.
const LOCK_KEY = "lock.json";
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const SLOW_ITEM_TTL_MS = 30 * 60 * 1000;
const SLOW_LABELS = ["Fed Funds Rate"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Alpha Vantage returns rate-limit errors as HTTP 200 with an
// {"error": {...}} body, not a non-2xx status, so res.ok alone can't
// detect them. Retries once after a pause since these are transient
// per-second burst blips, not persistent failures.
async function fetchJson(params, attempt = 1) {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  await recordAvCall();
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

// Yahoo symbols for the non-stock tiles. CL=F is the front-month WTI
// futures contract, which is what Yahoo quotes as "WTI crude".
const INDEXES = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^IXIC", label: "NASDAQ Composite" },
  { symbol: "^VIX", label: "VIX" },
];
const MSCI_WORLD = { symbol: "^990100-USD-STRD", label: "MSCI World Index" };
const WTI = { symbol: "CL=F", label: "WTI Crude Oil" };

function quoteItem(label, q) {
  return {
    label,
    value: round(q.price, 2),
    changePercent: round((q.price / q.prevClose - 1) * 100, 2),
  };
}

exports.handler = async () => {
  const store = getTickerStore();

  const existingLock = await store.get(LOCK_KEY, { type: "json" });
  if (existingLock && Date.now() - Date.parse(existingLock.startedAt) < LOCK_TIMEOUT_MS) {
    console.log("scheduled-ticker-background: a run is already in flight, skipping this trigger");
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }
  await store.setJSON(LOCK_KEY, { startedAt: new Date().toISOString() });

  console.log(`scheduled-ticker-background: starting, ${TICKER_CONSTITUENTS.length} constituents`);
  try {
    const existing = await store.get(BLOB_KEY, { type: "json" });
    const slowFresh =
      existing && existing.slowFetchedAt && Date.now() - Date.parse(existing.slowFetchedAt) < SLOW_ITEM_TTL_MS;
    const previousSlow = ((existing && existing.items) || []).filter((i) => SLOW_LABELS.includes(i.label));
    let slowItems = previousSlow;
    let slowFetchedAt = existing && existing.slowFetchedAt;
    const warnings = [];

    if (!slowFresh) {
      if (!process.env.ALPHAVANTAGE_API_KEY) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");
      const slow = await Promise.all([fetchFedFunds()].map((p) => p.catch((err) => ({ __failed: true, message: err.message }))));
      const fetched = slow.filter((r) => !r.__failed);
      warnings.push(...slow.filter((r) => r.__failed).map((r) => r.message));
      // A failed series falls back to its last good value; the timestamp
      // only advances on a full success so the next run retries.
      slowItems = [...fetched, ...previousSlow.filter((p) => !fetched.some((f) => f.label === p.label))];
      if (!warnings.length) slowFetchedAt = new Date().toISOString();
    }
    const slowByLabel = new Map(slowItems.map((i) => [i.label, i]));

    const symbols = [...INDEXES.map((i) => i.symbol), MSCI_WORLD.symbol, WTI.symbol, ...TICKER_CONSTITUENTS];
    const quotes = await fetchQuotes(symbols);
    const fromQuote = (label, symbol) => {
      const q = quotes.get(symbol);
      if (!q) {
        warnings.push(`Incomplete Yahoo quote for ${symbol}`);
        return { __failed: true };
      }
      return quoteItem(label, q);
    };

    // Same order the tape has always shown: indices, Fed Funds, MSCI World, WTI, stocks.
    const results = [
      ...INDEXES.map((i) => fromQuote(i.label, i.symbol)),
      slowByLabel.get("Fed Funds Rate") || { __failed: true },
      fromQuote(MSCI_WORLD.label, MSCI_WORLD.symbol),
      fromQuote(WTI.label, WTI.symbol),
      ...TICKER_CONSTITUENTS.map((s) => fromQuote(s, s)),
    ];
    const items = results.filter((r) => !r.__failed);
    const tasks = results;

    if (!items.length) {
      throw new Error("All ticker items failed to load" + (warnings.length ? ": " + warnings.join("; ") : ""));
    }

    console.log(`scheduled-ticker-background: ${items.length}/${tasks.length} items loaded, ${warnings.length} failed`);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      slowFetchedAt,
      items,
      warnings,
    };

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
  } finally {
    await store.delete(LOCK_KEY);
  }
};
