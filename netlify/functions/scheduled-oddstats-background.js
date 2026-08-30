// Scheduled Background Function (see [functions."scheduled-oddstats-background"]
// in netlify.toml) that runs the whole streak-scanner engine once daily and
// writes the finished board to Netlify Blobs for oddstats.js to serve.
//
// Named "-background" for the same reason as scheduled-sectors-background.js:
// loadUniverse() makes ~38 sequential Yahoo fetches (^GSPC + SPY + 11 sector
// ETFs + 25 megacaps, spaced to stay under Yahoo's burst throttle) and
// snapshot() then re-runs ~360 analog scans over the full history — well past
// the ~26s a standard function gets, comfortably inside a Background
// Function's 15-minute window.
//
// Yahoo has no per-day quota here (unlike Alpha Vantage), so there's no
// rate-limit contention with the other scheduled-*-background jobs; it's
// staggered after them (21:10 UTC) just to keep the daily jobs in one block.
//
// Each run rebuilds everything from scratch — same self-healing rationale as
// the breadth/sectors jobs.

const { getOddstatsStore, BLOB_KEY } = require("./oddstats-blob-store");
const { loadUniverse, snapshot, mergeRecentlyEnded } = require("./oddstats-engine");

exports.handler = async () => {
  try {
    const store = getOddstatsStore();
    const prev = await store.get(BLOB_KEY, { type: "json" }).catch(() => null);

    const universe = await loadUniverse();
    const board = snapshot(universe);
    board.generatedAt = new Date().toISOString();
    // Feed of streaks that were notable and have since ended (see engine).
    board.recentlyEnded = mergeRecentlyEnded(prev, board);

    await store.setJSON(BLOB_KEY, board);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        asOf: board.asOf,
        conditions: board.scanned,
        live: board.live,
        sectors: board.sectorCount,
        recentlyEnded: board.recentlyEnded.length,
      }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
