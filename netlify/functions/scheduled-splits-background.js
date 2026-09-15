// Scheduled Background Function (see [functions."scheduled-splits-
// background"] in netlify.toml) that sweeps Alpha Vantage's SPLITS endpoint
// (full historical split record) across the full S&P 500, for the
// stock-splits.html page's "does splitting predict post-split
// performance?" test — the classic Ikenberry-style stock-split anomaly
// finding (forward splits tend to be followed by market-relative
// outperformance over the following year).
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than
// paying for a second ~503-call OVERVIEW sweep just for labels — same
// pattern as scheduled-share-count-background.js and
// scheduled-insider-transactions-background.js.
//
// Two-stage sweep:
//   1. SPLITS for all ~503 tickers (full 2-pass retry, 1050ms pacing —
//      same proven pattern as the site's other full-universe sweeps).
//   2. For the (much smaller) subset of tickers with a forward split in
//      the lookback window old enough to have a full 1-year forward
//      return, TIME_SERIES_DAILY_ADJUSTED (full history) — single pass,
//      no retry, since this is a supplementary enrichment step: a handful
//      of missed price histories just means those specific events ship
//      without a forward-return figure rather than failing the whole run.
//   Plus one SPY full-history call as the market benchmark for excess
//   (market-relative) returns.
//
// Weekly, not daily: split *events* are sparse (most companies never
// split in a given year), so a daily re-sweep would mostly refetch
// unchanged history.

const { getSplitsStore, BLOB_KEY } = require("./splits-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LOOKBACK_YEARS = 6; // how far back a split counts as "recent" for the frequency/leaderboard views
const MIN_AGE_DAYS_FOR_1Y_RETURN = 370; // need this much elapsed time to compute a real 1Y forward return
const SPY = "SPY";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

async function fetchJson(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error_message || payload.error) {
    throw new Error(payload.Note || payload.Information || payload.error_message || JSON.stringify(payload.error));
  }
  return payload;
}

async function fetchSplits(apiKey, symbol) {
  const payload = await fetchJson(`${ALPHA_VANTAGE_URL}?function=SPLITS&symbol=${symbol}&apikey=${apiKey}`);
  const rows = payload.data;
  if (!Array.isArray(rows)) throw new Error(`unexpected SPLITS shape: ${JSON.stringify(payload).slice(0, 160)}`);
  return rows
    .map((r) => ({ date: r.effective_date, factor: parseFloat(r.split_factor) }))
    .filter((r) => r.date && Number.isFinite(r.factor) && r.factor > 0 && r.factor !== 1);
}

async function fetchDailyAdjusted(apiKey, symbol) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${apiKey}`
  );
  const series = payload["Time Series (Daily)"];
  if (!series) throw new Error(`TIME_SERIES_DAILY_ADJUSTED missing for ${symbol}`);
  const rows = Object.entries(series)
    .map(([date, r]) => ({ date, close: parseFloat(r["5. adjusted close"]) }))
    .filter((r) => Number.isFinite(r.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { dates: rows.map((r) => r.date), closes: rows.map((r) => r.close) };
}

// First close on or after targetDate (dates ascending) — used to find the
// actual trading-day price closest to a split's effective date / forward
// anniversary, since effective_date itself may fall on a weekend/holiday.
function closeOnOrAfter(hist, targetDate) {
  const { dates, closes } = hist;
  let lo = 0;
  let hi = dates.length - 1;
  if (!dates.length || dates[dates.length - 1] < targetDate) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < targetDate) lo = mid + 1;
    else hi = mid;
  }
  return dates[lo] >= targetDate ? { date: dates[lo], close: closes[lo] } : null;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const HORIZONS = [
  { key: "1M", days: 30 },
  { key: "3M", days: 91 },
  { key: "6M", days: 182 },
  { key: "1Y", days: 365 },
];

// Forward excess return (stock minus SPY) over each horizon, anchored to
// the split's effective date. Null for a horizon if either series lacks a
// trading day that far forward yet.
function forwardExcessReturns(stockHist, spyHist, effectiveDate) {
  const base = closeOnOrAfter(stockHist, effectiveDate);
  const spyBase = closeOnOrAfter(spyHist, effectiveDate);
  if (!base || !spyBase) return null;
  const out = {};
  for (const h of HORIZONS) {
    const target = addDays(effectiveDate, h.days);
    const stockFwd = closeOnOrAfter(stockHist, target);
    const spyFwd = closeOnOrAfter(spyHist, target);
    if (!stockFwd || !spyFwd) {
      out[h.key] = null;
      continue;
    }
    const stockRet = (stockFwd.close / base.close - 1) * 100;
    const spyRet = (spyFwd.close / spyBase.close - 1) * 100;
    out[h.key] = round(stockRet - spyRet);
  }
  return out;
}

exports.handler = async () => {
  console.log(`scheduled-splits-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const cutoffDate = addDays(new Date().toISOString().slice(0, 10), -LOOKBACK_YEARS * 365);
    const results = new Map(); // symbol -> recent split events

    async function fetchInto(symbol) {
      try {
        const all = await fetchSplits(apiKey, symbol);
        const recent = all.filter((r) => r.date >= cutoffDate);
        results.set(symbol, recent);
        return true;
      } catch (err) {
        console.error(`scheduled-splits-background: ${symbol} SPLITS failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-splits-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(1050);
      }
      todo = missed;
    }
    console.log(`scheduled-splits-background: SPLITS resolved for ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed SPLITS — refusing to write an empty snapshot");

    // Flatten into events with sector/name, direction, and age.
    const todayStr = new Date().toISOString().slice(0, 10);
    const events = [];
    for (const [symbol, splits] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      for (const s of splits) {
        const ageDays = Math.round((new Date(todayStr) - new Date(s.date)) / 86400000);
        events.push({
          symbol,
          name: m.name || symbol,
          sector: m.sector,
          date: s.date,
          factor: s.factor,
          direction: s.factor > 1 ? "forward" : "reverse",
          ageDays,
        });
      }
    }
    events.sort((a, b) => (a.date < b.date ? 1 : -1)); // most recent first

    // Stage 2: fetch daily price history for symbols with an old-enough
    // forward split, to compute forward excess returns. Deliberately a
    // single pass (see header comment) — a handful of misses here just
    // ship without a performance figure, not an empty page.
    const needsPrice = [...new Set(
      events.filter((e) => e.direction === "forward" && e.ageDays >= MIN_AGE_DAYS_FOR_1Y_RETURN).map((e) => e.symbol)
    )];
    console.log(`scheduled-splits-background: fetching price history for ${needsPrice.length} split symbol(s)`);

    const priceHist = new Map();
    for (const symbol of needsPrice) {
      try {
        priceHist.set(symbol, await fetchDailyAdjusted(apiKey, symbol));
      } catch (err) {
        console.error(`scheduled-splits-background: ${symbol} price history failed: ${err.message}`);
      }
      await sleep(1050);
    }

    let spyHist = null;
    if (needsPrice.length) {
      try {
        spyHist = await fetchDailyAdjusted(apiKey, SPY);
      } catch (err) {
        console.error(`scheduled-splits-background: SPY price history failed: ${err.message}`);
      }
    }

    for (const e of events) {
      if (e.direction !== "forward" || e.ageDays < MIN_AGE_DAYS_FOR_1Y_RETURN) {
        e.excess = null;
        continue;
      }
      const hist = priceHist.get(e.symbol);
      e.excess = hist && spyHist ? forwardExcessReturns(hist, spyHist, e.date) : null;
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      lookbackYears: LOOKBACK_YEARS,
      minAgeDaysFor1Y: MIN_AGE_DAYS_FOR_1Y_RETURN,
      pricedSymbolCount: [...priceHist.keys()].length,
      events,
    };

    await getSplitsStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-splits-background: wrote ${events.length} split events (${needsPrice.length} priced)`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, events: events.length }) };
  } catch (err) {
    console.error(`scheduled-splits-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
