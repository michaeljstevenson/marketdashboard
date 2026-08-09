// Scheduled function (see [functions."scheduled-ath-tradingview"]
// in netlify.toml) that determines which S&P 500 constituents are at a
// genuine all-time high, using TradingView's public screener data instead
// of Alpha Vantage.
//
// Why: the original ATH computation (scheduled-breadth-background.js,
// atHigh flag) used Alpha Vantage's "full" daily history, which turned out
// to be capped at ~26 years for every symbol tested (starts ~1999-2000
// regardless of how long the company's actually been listed) — not
// actually full. For long-listed names (3M, Amgen, Eaton, etc.) that
// understates the true all-time high and produces false positives: e.g.
// MMM showed as "at ATH" when its real all-time high (~$217, reached
// before 1999) is ~16% above its current price (~$183). Cross-checked
// against TradingView's own screener (which reported only 4 true S&P 500
// names at ATH on a specific date, vs. 14 from the old Alpha-Vantage-based
// method) confirmed the gap.
//
// TradingView's scanner exposes a "High.All" field — their own
// all-time-high figure, built from deeper history than Alpha Vantage
// provides on this plan. This hits TradingView's public (unauthenticated)
// screener backend, not an official documented API — there's no ToS-
// compliant alternative currently available at this data depth, so this
// is used deliberately sparingly: one batched request for all ~503
// tickers, once per weekday after the close, not per-symbol and not
// per-page-load.
//
// Unlike the other scheduled jobs here, this one is append-only: each run
// adds (or replaces, if re-run same day) exactly one day's snapshot to a
// growing history array, rather than recomputing everything from scratch,
// since TradingView's scanner only exposes a live current snapshot, not
// historical daily series.

const { TICKER_EXCHANGE } = require("./tv-exchange-map");
const { getTvAthStore, BLOB_KEY } = require("./tv-ath-blob-store");

const SCANNER_URL = "https://scanner.tradingview.com/america/scan";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Small tolerance so floating-point/rounding noise between "close" and
// "High.All" (which can be computed from slightly different underlying
// ticks) doesn't produce false negatives for a name that's genuinely
// closing at its all-time high.
const ATH_TOLERANCE = 0.0005; // 0.05%

function todayDateStr() {
  // Date as of US/Eastern, matching when this runs (after the close).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

exports.handler = async () => {
  console.log("scheduled-ath-tradingview: starting");
  try {
    const tickers = Object.entries(TICKER_EXCHANGE).map(([symbol, exchange]) => `${exchange}:${symbol}`);

    async function scanTickers(tickerList) {
      const res = await fetch(SCANNER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          Referer: "https://www.tradingview.com/",
        },
        body: JSON.stringify({
          symbols: { tickers: tickerList, query: { types: [] } },
          columns: ["name", "close", "High.All"],
        }),
      });
      if (!res.ok) throw new Error(`TradingView scanner HTTP ${res.status}`);
      const payload = await res.json();
      return payload.data || [];
    }

    let rows = await scanTickers(tickers);
    if (!rows.length) throw new Error("TradingView scanner returned no data");

    // The batched request silently drops a handful of tickers on some
    // runs (observed ~12/503 missing, seemingly at random — each of
    // those tickers resolves fine when queried individually, so this is
    // a quirk of the batch endpoint itself, not an invalid ticker). One
    // small follow-up request for exactly the missing tickers fixes it
    // without needing to understand the root cause.
    const gotSet = new Set(rows.map((r) => r.s));
    const missing = tickers.filter((t) => !gotSet.has(t));
    if (missing.length) {
      console.log(`scheduled-ath-tradingview: retrying ${missing.length} tickers dropped from the main batch`);
      try {
        const retryRows = await scanTickers(missing);
        rows = rows.concat(retryRows);
      } catch (err) {
        console.error(`scheduled-ath-tradingview: retry failed: ${err.message}`);
      }
    }

    const athTickers = [];
    let coverage = 0;
    for (const row of rows) {
      const [symbol, close, highAll] = row.d;
      if (close === null || highAll === null || highAll === undefined) continue;
      coverage++;
      if (close >= highAll * (1 - ATH_TOLERANCE)) athTickers.push(symbol);
    }
    athTickers.sort();

    console.log(
      `scheduled-ath-tradingview: ${coverage}/${tickers.length} symbols returned data, ${athTickers.length} at ATH`
    );

    const today = {
      date: todayDateStr(),
      total: coverage,
      count: athTickers.length,
      pct: coverage ? Math.round((athTickers.length / coverage) * 1000) / 10 : null,
      tickers: athTickers,
    };

    const store = getTvAthStore();
    const existing = (await store.get(BLOB_KEY, { type: "json" })) || { rows: [] };
    const rowsOut = (existing.rows || []).filter((r) => r.date !== today.date);
    rowsOut.push(today);
    rowsOut.sort((a, b) => (a.date < b.date ? -1 : 1));

    const out = {
      generated_at_utc: new Date().toISOString(),
      source: "TradingView scanner (High.All field)",
      rows: rowsOut,
    };
    await store.setJSON(BLOB_KEY, out);
    console.log(`scheduled-ath-tradingview: wrote ${rowsOut.length} total days to blob`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, today }),
    };
  } catch (err) {
    console.error(`scheduled-ath-tradingview: FAILED: ${err.message}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
