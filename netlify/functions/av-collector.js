// Shared runner for the Alpha Vantage collector jobs (scheduled-overview-,
// earnings-, cashflow-, estimates-, income- and balance-collector-
// background.js). Each
// collector calls runCollector() with one endpoint and a pick() function
// that keeps only the fields the site's jobs read, and this file does the
// rest: one call per S&P 500 stock, paced for the rate limit, with the
// same save-and-resume safeguards the other long sweeps use.
//
// A sweep of ~503 calls at ~1.3s each takes about 11 minutes, close to the
// 15-minute background limit, so a run stops fetching at RUN_BUDGET_MS and
// saves progress; the next run resumes. Only a finished sweep replaces the
// published snapshot (see av-collector-store.js), so a partial or failed run
// never degrades the data other jobs read. Failures are recorded with their
// reason because Netlify captures no console output for background functions.

const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { getCollectedStore, publishedKey, progressKey } = require("./av-collector-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CALL_SLEEP_MS = 1050;
const RUN_BUDGET_MS = 12 * 60 * 1000;
const PROGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Alpha Vantage reports rate limits as HTTP 200 with a Note/Information/
// error body, so res.ok alone can't detect them.
async function fetchPayload(fn, symbol, apiKey) {
  await recordAvCall();
  const res = await fetch(`${ALPHA_VANTAGE_URL}?function=${fn}&symbol=${symbol}&apikey=${apiKey}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  return payload;
}

// kind: "overview" | "earnings" | "cashflow" | "estimates" | "income" | "balance" (names the blobs)
// fn:   the Alpha Vantage function
// pick: (payload) => slim object to store, or null when the symbol has no
//       data; throw to have the symbol retried as a failure.
async function runCollector({ kind, fn, pick }) {
  const tag = `scheduled-${kind}-collector-background`;
  console.log(`${tag}: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const startedAtMs = Date.now();
    const outOfTime = () => Date.now() - startedAtMs > RUN_BUDGET_MS;
    const store = getCollectedStore();
    const saved = await store.get(progressKey(kind), { type: "json" });
    const resume = !!(saved && !saved.complete && Date.now() - Date.parse(saved.startedAt) < PROGRESS_MAX_AGE_MS);
    const cycleStartedAt = resume ? saved.startedAt : new Date().toISOString();
    const done = new Set(resume ? saved.done : []);
    const data = resume ? saved.data : {};
    const failed = resume ? { ...saved.failed } : {};
    if (resume) console.log(`${tag}: resuming with ${done.size} ticker(s) already fetched`);

    const saveProgress = (complete) =>
      store.setJSON(progressKey(kind), { startedAt: cycleStartedAt, complete, done: [...done], data, failed });

    let todo = BREADTH_CONSTITUENTS.filter((s) => !done.has(s));
    let stoppedForTime = false;
    let sinceCheckpoint = 0;
    for (let pass = 0; pass < 2 && todo.length && !stoppedForTime; pass++) {
      if (pass > 0) {
        console.log(`${tag}: retry pass for ${todo.length} ticker(s)`);
        await sleep(45000);
      }
      const missed = [];
      for (const symbol of todo) {
        if (outOfTime()) { stoppedForTime = true; break; }
        try {
          const slim = pick(await fetchPayload(fn, symbol, apiKey));
          done.add(symbol);
          delete failed[symbol];
          if (slim) data[symbol] = slim;
          if (++sinceCheckpoint >= CHECKPOINT_EVERY) { await saveProgress(false); sinceCheckpoint = 0; }
        } catch (err) {
          console.error(`${tag}: ${symbol} failed: ${err.message}`);
          failed[symbol] = String(err.message).slice(0, 200);
          missed.push(symbol);
          if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        }
        await sleep(CALL_SLEEP_MS);
      }
      todo = missed;
    }

    const complete = !stoppedForTime;
    await saveProgress(complete);
    if (!complete) {
      console.log(`${tag}: out of time with ${done.size}/${BREADTH_CONSTITUENTS.length} fetched, run again to finish`);
      return { statusCode: 200, body: JSON.stringify({ ok: true, complete: false, fetched: done.size }) };
    }
    if (!Object.keys(data).length) throw new Error("Every ticker failed, refusing to publish an empty snapshot");

    await store.setJSON(publishedKey(kind), {
      generated_at_utc: new Date().toISOString(),
      kind,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: Object.keys(data).length,
      unresolvedCount: BREADTH_CONSTITUENTS.length - done.size,
      data,
    });
    console.log(`${tag}: published ${Object.keys(data).length} tickers (${Object.keys(failed).length} unresolved)`);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, complete: true, loaded: Object.keys(data).length, unresolved: Object.keys(failed).length }),
    };
  } catch (err) {
    console.error(`${tag}: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
}

// Copies only `keys` from obj (keys absent from obj stay absent).
function pickFields(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = { runCollector, pickFields };
