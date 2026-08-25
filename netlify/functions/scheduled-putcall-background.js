// Scheduled function (see [functions."scheduled-putcall-background"] in
// netlify.toml) that fetches SPY's full-chain equity put/call ratio for
// the last PUTCALL_FETCH_DAYS trading days and writes it to Netlify
// Blobs for data.js to serve.
//
// Alpha Vantage's HISTORICAL_PUT_CALL_RATIO has no bulk historical
// endpoint — one HTTP call per date — so this used to run live inside
// data.js on every page load (~40 sequential calls). That had two
// problems: it pushed data.js's total runtime close to Netlify's
// function timeout (a wider window briefly tried there, 30 days, tipped
// it over into an outright 502), and Alpha Vantage's burst limiter was
// silently dropping a different subset of dates on each run, so the
// factor's score visibly flip-flopped between near-simultaneous page
// loads even with nothing actually changing. Moving the fetch here,
// once a day, fixes both: the per-page-load cost disappears, and a
// single day dropped by rate-limiting gets a same-run retry pass (same
// pattern as scheduled-sectors-background.js) rather than silently
// skewing whatever a live user happened to trigger.
//
// Runs once daily after the close, alongside the other scheduled jobs.
// Re-fetches the full window from scratch each time rather than
// incrementally appending — simpler and self-healing, same rationale as
// scheduled-breadth-background.js.

const { getPutCallStore, BLOB_KEY } = require("./putcall-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Fetches more trading days than PUTCALL_SCORE_WINDOW in data.js needs
// (30) so the percentile ranking has a real sample to rank against, not
// just enough for a single moving average.
const PUTCALL_FETCH_DAYS = 90;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchRecentTradingDates(apiKey, symbol, count) {
  const payload = await fetchJson(`${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY&symbol=${symbol}&outputsize=compact&apikey=${apiKey}`);
  const series = payload["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      `Alpha Vantage TIME_SERIES_DAILY missing data for ${symbol}: ` + (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 200))
    );
  }
  return Object.keys(series).sort().slice(-count);
}

async function fetchPutCallRatio(apiKey, symbol, dateStr) {
  const payload = await fetchJson(`${ALPHA_VANTAGE_URL}?function=HISTORICAL_PUT_CALL_RATIO&symbol=${symbol}&date=${dateStr}&apikey=${apiKey}`);
  const value = parseFloat(payload.put_call_ratio_full_chain);
  if (Number.isNaN(value)) throw new Error(`no put_call_ratio_full_chain for ${dateStr}`);
  return value;
}

exports.handler = async () => {
  console.log("scheduled-putcall-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const tradingDates = await fetchRecentTradingDates(apiKey, "SPY", PUTCALL_FETCH_DAYS);

    const values = new Map();

    // 5 concurrent calls per batch, 800ms between batches — same pacing
    // as the old live version in data.js.
    for (let i = 0; i < tradingDates.length; i += 5) {
      const batch = tradingDates.slice(i, i + 5);
      await Promise.all(
        batch.map(async (dateStr) => {
          try {
            values.set(dateStr, await fetchPutCallRatio(apiKey, "SPY", dateStr));
          } catch (err) {
            console.error(`scheduled-putcall-background: ${dateStr} failed: ${err.message}`);
          }
        })
      );
      if (i + 5 < tradingDates.length) await sleep(800);
    }

    // Retry pass: any date that failed above gets one more attempt after
    // the rest of the batch has had time to clear the rate-limit window.
    const missing = tradingDates.filter((d) => !values.has(d));
    if (missing.length) {
      console.log(`scheduled-putcall-background: retrying ${missing.length} failed date(s)`);
      await sleep(2000);
      for (let i = 0; i < missing.length; i += 5) {
        const batch = missing.slice(i, i + 5);
        await Promise.all(
          batch.map(async (dateStr) => {
            try {
              values.set(dateStr, await fetchPutCallRatio(apiKey, "SPY", dateStr));
            } catch (err) {
              console.error(`scheduled-putcall-background: ${dateStr} retry failed: ${err.message}`);
            }
          })
        );
        if (i + 5 < missing.length) await sleep(800);
      }
    }

    console.log(`scheduled-putcall-background: fetched ${values.size}/${tradingDates.length} dates`);

    if (!values.size) throw new Error("Every date failed to load — leaving the existing blob in place");

    const points = tradingDates
      .filter((d) => values.has(d))
      .map((d) => ({ date: d, value: Math.round(values.get(d) * 10000) / 10000 }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      points,
    };

    const store = getPutCallStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-putcall-background: wrote ${points.length} points to blob`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, points: points.length }) };
  } catch (err) {
    console.error(`scheduled-putcall-background: failed: ${err.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
