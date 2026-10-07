// Scheduled Background Function (see [functions."scheduled-putcall-history-
// background"] in netlify.toml): builds month-end put/call snapshots of every
// S&P 500 member for the put/call ratio page's forward-return study, plus one
// current snapshot of today's members each week.
//
// Alpha Vantage's HISTORICAL_PUT_CALL_RATIO takes one symbol and one date per
// call, so five years of month-ends is ~30,000 calls. The backfill is spread
// over many short runs: each run works for at most RUN_BUDGET_MS, saves its
// progress, and the next scheduled run picks up where it stopped. Runs are
// scheduled only between 00:00 and 06:59 UTC, when no other Alpha Vantage job
// on the site runs, and calls start at least MIN_CALL_GAP_MS apart (60 a
// minute, under the plan's 75).
//
// Historical ratios are filed under the ticker in use on that date (FB before
// June 2022), so membership comes from putcall-history-plan.js. Companies that
// no longer trade are rejected as invalid symbols; they're recorded as
// unavailable rather than retried, and the page reports the coverage this
// leaves.

const { getPutCallHistoryStore, PROGRESS_KEY, snapshotKey } = require("./putcall-history-blob-store");
const { BUILT_THROUGH, DATES, MEMBERS } = require("./putcall-history-plan");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { fetchDailyHistory } = require("./yahoo-client");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const RUN_BUDGET_MS = 12 * 60 * 1000;
const LOCK_MS = 14 * 60 * 1000;
const MIN_CALL_GAP_MS = 1000;
const SAVE_EVERY = 40;
const MAX_TRANSIENT_RETRIES = 3;
const RATE_LIMIT_PAUSE_MS = 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function num(v) {
  if (v === null || v === undefined || v === "" || v === "None") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// -> { ok: true, pc, twoSided, expirations } | { ok: false, permanent, reason, rateLimited }
async function fetchRatio(apiKey, symbol, date) {
  const url = `${ALPHA_VANTAGE_URL}?function=HISTORICAL_PUT_CALL_RATIO&symbol=${encodeURIComponent(symbol)}` +
    (date ? `&date=${date}` : "") + `&apikey=${apiKey}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ok: false, permanent: false, reason: `network: ${err.message}` };
  }
  if (!res.ok) return { ok: false, permanent: false, reason: `HTTP ${res.status}` };
  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    return { ok: false, permanent: false, reason: "unparseable response" };
  }
  const message = payload.Note || payload.Information ||
    (payload.error && (payload.error.message || payload.error)) || payload["Error Message"];
  if (message) {
    const text = String(message);
    // "Invalid symbol" (no longer listed) and "Invalid API call" both repeat
    // on every retry, so neither is worth spending more calls on.
    if (/invalid/i.test(text)) return { ok: false, permanent: true, reason: text.slice(0, 80) };
    const rateLimited = /frequency|rate limit|per minute|requests per|premium|thank you for using/i.test(text);
    return { ok: false, permanent: false, rateLimited, reason: text.slice(0, 160) };
  }
  const byExp = Array.isArray(payload.put_call_ratio_by_expiration) ? payload.put_call_ratio_by_expiration : [];
  const twoSided = byExp.filter((e) => { const v = num(e.value); return v !== null && v > 0; }).length;
  return { ok: true, pc: num(payload.put_call_ratio_full_chain), twoSided, expirations: byExp.length };
}

// Month-ends after the generated plan use today's constituents, since those
// months are processed right after they close.
async function workList() {
  const list = DATES.map((date) => ({ date, members: MEMBERS[date].split(","), kind: "month-end" }));
  const spy = await fetchDailyHistory("SPY", { adjusted: false });
  const trading = spy.map((r) => r.date);
  const lastMonth = trading[trading.length - 1].slice(0, 7);
  const monthEnds = new Map();
  for (const d of trading) monthEnds.set(d.slice(0, 7), d);
  for (const [month, date] of monthEnds) {
    if (date > BUILT_THROUGH && month < lastMonth) list.push({ date, members: BREADTH_CONSTITUENTS.slice(), kind: "month-end" });
  }
  // The weekly current snapshot: the last close of the most recent complete
  // week, so the extremes table refreshes once a week.
  const lastDate = trading[trading.length - 1];
  const weekStart = (d) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
  const thisWeek = weekStart(lastDate);
  const lastFullWeekClose = [...trading].reverse().find((d) => weekStart(d) < thisWeek);
  if (lastFullWeekClose) list.push({ date: lastFullWeekClose, members: BREADTH_CONSTITUENTS.slice(), kind: "weekly" });
  // Newest month-ends first so recent history fills in before older years.
  list.sort((a, b) => (a.kind === b.kind ? (a.date < b.date ? 1 : -1) : a.kind === "weekly" ? -1 : 1));
  return list;
}

exports.handler = async () => {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) {
    console.error("scheduled-putcall-history-background: ALPHAVANTAGE_API_KEY is not set");
    return { statusCode: 500 };
  }
  const store = getPutCallHistoryStore();
  const progress = (await store.get(PROGRESS_KEY, { type: "json" })) || {};
  if (progress.lockedUntil && Date.parse(progress.lockedUntil) > Date.now()) {
    console.log("scheduled-putcall-history-background: another run holds the lock, exiting");
    return { statusCode: 200 };
  }
  progress.lockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
  await store.setJSON(PROGRESS_KEY, progress);

  let calls = 0, unrecorded = 0, lastCallAt = 0;
  const done = progress.done || {};
  try {
    const list = await workList();
    for (const item of list) {
      if (outOfTime()) break;
      if (item.kind === "month-end" && done[item.date]) continue;
      const key = snapshotKey(item.kind === "weekly" ? `weekly-${item.date}` : item.date);
      const snap = (await store.get(key, { type: "json" })) ||
        { date: item.date, kind: item.kind, members: item.members.length, results: {}, unavailable: {}, retries: {} };
      if (snap.complete) { if (item.kind === "month-end") done[item.date] = true; continue; }
      const pending = item.members.filter((s) => !(s in snap.results) && !(s in snap.unavailable));
      let sinceSave = 0;
      for (const symbol of pending) {
        if (outOfTime()) break;
        const wait = MIN_CALL_GAP_MS - (Date.now() - lastCallAt);
        if (wait > 0) await sleep(wait);
        lastCallAt = Date.now();
        const r = await fetchRatio(apiKey, symbol, item.date);
        calls++; unrecorded++;
        if (r.ok) {
          snap.results[symbol] = { pc: r.pc, twoSided: r.twoSided };
        } else if (r.permanent) {
          snap.unavailable[symbol] = r.reason;
        } else {
          snap.retries[symbol] = (snap.retries[symbol] || 0) + 1;
          if (snap.retries[symbol] >= MAX_TRANSIENT_RETRIES) snap.unavailable[symbol] = r.reason;
          if (r.rateLimited) {
            console.warn(`scheduled-putcall-history-background: rate limited at ${symbol} ${item.date}: ${r.reason}`);
            await sleep(RATE_LIMIT_PAUSE_MS);
          }
        }
        if (++sinceSave >= SAVE_EVERY) {
          await store.setJSON(key, snap);
          await recordAvCall(unrecorded);
          unrecorded = 0; sinceSave = 0;
        }
      }
      snap.complete = item.members.every((s) => s in snap.results || s in snap.unavailable);
      snap.updatedAt = new Date().toISOString();
      await store.setJSON(key, snap);
      if (snap.complete && item.kind === "month-end") done[item.date] = true;
      if (snap.complete && item.kind === "weekly") progress.latestWeekly = item.date;
      console.log(`scheduled-putcall-history-background: ${item.kind} ${item.date}: ` +
        `${Object.keys(snap.results).length} loaded, ${Object.keys(snap.unavailable).length} unavailable of ${item.members.length}` +
        (snap.complete ? " (complete)" : ""));
    }
  } catch (err) {
    console.error(`scheduled-putcall-history-background: failed: ${err.message}`);
  } finally {
    if (unrecorded) await recordAvCall(unrecorded);
    progress.done = done;
    progress.lockedUntil = null;
    progress.lastRun = { at: new Date().toISOString(), calls, seconds: Math.round((Date.now() - startedAt) / 1000) };
    await store.setJSON(PROGRESS_KEY, progress);
  }
  console.log(`scheduled-putcall-history-background: ${calls} calls in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return { statusCode: 200 };
};

module.exports.fetchRatio = fetchRatio;
module.exports.workList = workList;
