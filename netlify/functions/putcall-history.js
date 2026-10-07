// Read-only progress of the put/call backfill (month-end stock snapshots and
// the index-ETF weekly years): which snapshots are
// complete and how many members each one loaded, so the backfill can be
// followed without Netlify's function logs.

const { getPutCallHistoryStore, PROGRESS_KEY, snapshotKey } = require("./putcall-history-blob-store");
const { DATES } = require("./putcall-history-plan");

exports.handler = async () => {
  try {
    const store = getPutCallHistoryStore();
    const progress = (await store.get(PROGRESS_KEY, { type: "json" })) || {};
    const done = progress.done || {};
    const keys = DATES.slice().reverse();
    if (progress.latestWeekly) keys.unshift(`weekly-${progress.latestWeekly}`);
    const snapshots = [];
    for (const key of keys) {
      const snap = await store.get(snapshotKey(key), { type: "json" });
      if (!snap) continue;
      const results = Object.values(snap.results || {});
      snapshots.push({
        key,
        members: snap.members,
        loaded: results.filter((r) => r.pc !== null).length,
        noOptions: results.filter((r) => r.pc === null).length,
        unavailable: Object.keys(snap.unavailable || {}).length,
        complete: !!snap.complete,
      });
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        monthEndsPlanned: DATES.length,
        monthEndsComplete: Object.keys(done).length,
        etfYearsComplete: Object.keys(progress.etfDone || {}).sort(),
        latestWeekly: progress.latestWeekly || null,
        lastRun: progress.lastRun || null,
        snapshots,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: err.message }) };
  }
};
