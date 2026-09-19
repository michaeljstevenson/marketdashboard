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
// which Yahoo Finance's batched spark endpoint gives directly (20 symbols
// per call, ~26 calls for the whole index, see yahoo-client.js) — cheap
// enough to run hourly through the trading day so "1D" actually reflects
// where the market is right now, not last night's close, the way the
// longer ranges don't need to. This used to be ~500 paced Alpha Vantage
// GLOBAL_QUOTE calls (~7 minutes) per run.
//
// Reads the existing blob first and only overwrites the "1D" key, so
// this job and the daily one (which owns the other five keys) don't
// clobber each other regardless of which one last wrote the blob.
//
// Runs hourly during US market hours on weekdays (see the cron schedule
// in netlify.toml). Named with the "-background" suffix so Netlify runs it
// as a Background Function, matching its sibling jobs.

const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { getDayChangeStore, BLOB_KEY } = require("./daychange-blob-store");
const { fetchQuotes } = require("./yahoo-client");

// Symbols Yahoo has no two-bar history for (e.g. a ticker that just
// re-listed after a merger) are simply dropped, same as a failed per-symbol
// quote was before.
exports.handler = async () => {
  console.log(`scheduled-daychange-background: starting, ${BREADTH_CONSTITUENTS.length} symbols`);
  try {
    const quotes = await fetchQuotes(BREADTH_CONSTITUENTS);
    const changes = [];
    for (const symbol of BREADTH_CONSTITUENTS) {
      const q = quotes.get(symbol);
      if (!q || q.prevClose === 0) continue;
      changes.push({ symbol, pctChange: Math.round(((q.price / q.prevClose - 1) * 100) * 100) / 100 });
    }
    const failures = BREADTH_CONSTITUENTS.length - changes.length;
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
