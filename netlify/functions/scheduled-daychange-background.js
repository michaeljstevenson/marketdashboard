// Scheduled function (see [functions."scheduled-daychange-background"] in
// netlify.toml) that refreshes the "1D" range of the "Day's change
// distribution" widget on market-breadth.html — median/mean % change
// across the S&P 500 constituent list (see breadth-constituents.js),
// up/down counts, and the full per-symbol list for the histogram — and
// writes it to Netlify Blobs for daychange.js to serve.
//
// The widget also supports 5D/MTD/QTD/YTD/5Y ranges, but those are
// computed by scheduled-breadth-background.js instead (see that file) —
// this job only owns "1D". Deliberately separate: that job fetches full
// daily history per symbol (expensive, ~500 heavy calls, only viable
// once a day after the close), and since it already has that history in
// memory, computing the longer ranges there costs nothing extra. This
// job only needs each symbol's current quote vs. its previous close,
// which GLOBAL_QUOTE gives directly — cheap enough to run hourly through
// the trading day so "1D" actually reflects where the market is right
// now, not last night's close, the way the longer ranges don't need to.
//
// Reads the existing blob first and only overwrites the "1D" key, so
// this job and the daily one (which owns the other five keys) don't
// clobber each other regardless of which one last wrote the blob.
//
// Runs hourly during US market hours on weekdays (see the cron schedule
// in netlify.toml). Uses entitlement=delayed, matching
// scheduled-ticker-background.js's GLOBAL_QUOTE calls (this account's
// plan doesn't include realtime bulk quotes — confirmed premium-gated
// when tested — so per-symbol delayed quotes are the working option).
//
// Named with the "-background" suffix so Netlify runs it as a Background
// Function (up to 15 minutes) rather than a standard function — same
// reasoning as scheduled-ticker-background.js: ~500 calls, batched to
// stay under Alpha Vantage's 75-calls/minute cap, takes ~7 minutes,
// comfortably past a standard function's ~30s timeout.

const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { getDayChangeStore, BLOB_KEY } = require("./daychange-blob-store");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Alpha Vantage returns rate-limit errors as HTTP 200 with an
// {"error"/"Note"/"Information": ...} body, not a non-2xx status, so
// res.ok alone can't detect them. Retries once after a pause since these
// are transient per-second burst blips, not persistent failures — same
// approach as scheduled-ticker-background.js.
async function fetchJson(params, attempt = 1) {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  const res = await fetch(`${ALPHA_VANTAGE_URL}?${params}&apikey=${apiKey}`);
  const payload = res.ok ? await res.json() : null;
  const isRateLimited = !res.ok || !payload || payload.error || payload.Note || payload.Information;
  if (isRateLimited) {
    if (attempt < 2) {
      await sleep(1000);
      return fetchJson(params, attempt + 1);
    }
    throw new Error(
      `Alpha Vantage error for ${params}: ` +
        (payload ? payload.Note || payload.Information || JSON.stringify(payload).slice(0, 150) : `HTTP ${res.status}`)
    );
  }
  return payload;
}

async function fetchQuote(symbol) {
  const payload = await fetchJson(`function=GLOBAL_QUOTE&symbol=${symbol}&entitlement=delayed`);
  const quote = payload["Global Quote"];
  const price = quote && parseFloat(quote["05. price"]);
  const prevClose = quote && parseFloat(quote["08. previous close"]);
  if (!quote || !Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose === 0) {
    throw new Error(`Incomplete GLOBAL_QUOTE for ${symbol}: ${JSON.stringify(payload).slice(0, 150)}`);
  }
  return { symbol, pctChange: Math.round(((price / prevClose - 1) * 100) * 100) / 100 };
}

// Same batching shape as scheduled-ticker-background.js: 5 calls, then a
// pause, keeping sustained throughput just under the 75-calls/minute cap
// (5 calls / 4.2s ≈ 71/min) rather than bursting and tripping it.
async function batched(tasks, batchSize, delayMs) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((task) => task()));
    results.push(...settled);
    if (i + batchSize < tasks.length) await sleep(delayMs);
  }
  return results;
}

exports.handler = async () => {
  console.log(`scheduled-daychange-background: starting, ${BREADTH_CONSTITUENTS.length} symbols`);
  try {
    if (!process.env.ALPHAVANTAGE_API_KEY) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const tasks = BREADTH_CONSTITUENTS.map((symbol) => () => fetchQuote(symbol));
    const settled = await batched(tasks, 5, 4200);

    const changes = [];
    let failures = 0;
    settled.forEach((result) => {
      if (result.status === "fulfilled") changes.push(result.value);
      else failures++;
    });
    if (failures) console.error(`scheduled-daychange-background: ${failures} symbol(s) failed`);
    if (!changes.length) throw new Error("No quotes fetched successfully");

    changes.sort((a, b) => a.pctChange - b.pctChange);
    const values = changes.map((c) => c.pctChange);
    const n = values.length;
    const median = n % 2 === 1 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
    const mean = values.reduce((sum, v) => sum + v, 0) / n;
    const up = changes.filter((c) => c.pctChange > 0).length;
    const down = changes.filter((c) => c.pctChange < 0).length;

    const oneDaySummary = {
      n,
      total: BREADTH_CONSTITUENTS.length,
      median: Math.round(median * 100) / 100,
      mean: Math.round(mean * 100) / 100,
      up,
      down,
      unchanged: n - up - down,
      changes,
    };

    const store = getDayChangeStore();
    const existing = (await store.get(BLOB_KEY, { type: "json" })) || {};
    const payload = {
      ...existing,
      generated_at_utc: new Date().toISOString(),
      ranges: { ...(existing.ranges || {}), "1D": oneDaySummary },
    };
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-daychange-background: wrote ${n}/${BREADTH_CONSTITUENTS.length} quotes (1D range) to blob`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, n }),
    };
  } catch (err) {
    console.error(`scheduled-daychange-background: FAILED: ${err.message}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
