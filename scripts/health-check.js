#!/usr/bin/env node
// Daily health check for the live site. Reads data-pull-schedule.json from the
// deployed site (not the local repo) so it judges each endpoint against the
// schedules that are actually live, then flags endpoints that errored, went
// stale, or came back with only part of their universe loaded.
//
//   node scripts/health-check.js          human-readable report
//   node scripts/health-check.js --json   machine-readable
//
// Exit code 1 when anything is FAIL, so a scheduler can alert on it.

const fs = require("fs");
const path = require("path");

const SITE = process.env.HEALTH_SITE || "https://michaeljstevenson.co";
// A job that fired less than this long ago may still be running.
const GRACE_MIN = 30;
const MANUAL_STALE_DAYS = 45;
const LOW_COVERAGE = 0.9;
// Alpha Vantage live calls on every request; probing them would spend quota.
const SKIP_LIVE = new Set(["/api/momentum-history", "/api/backtest-prices"]);
// Password-protected admin endpoints answer 401 by design.
const PROTECTED = new Set(["/api/oddstats", "/api/oddstats-curation"]);

function parseField(f, min, max) {
  if (f === "*") return null;
  const out = new Set();
  for (const part of f.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS ? Number(stepS) : 1;
    let [a, b] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (b === undefined) b = stepS ? max : a;
    for (let v = a; v <= b; v += step) out.add(v === 7 && max === 6 ? 0 : v);
  }
  return out;
}

// Netlify schedules are UTC; walk back minute by minute (at most 8 days).
function lastFire(cron, before) {
  const [mi, h, dom, mo, dow] = cron.trim().split(/\s+/);
  const F = { mi: parseField(mi, 0, 59), h: parseField(h, 0, 23), dom: parseField(dom, 1, 31), mo: parseField(mo, 1, 12), dow: parseField(dow, 0, 6) };
  const t = new Date(before);
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const ok = (!F.mi || F.mi.has(t.getUTCMinutes())) && (!F.h || F.h.has(t.getUTCHours())) &&
      (!F.dom || F.dom.has(t.getUTCDate())) && (!F.mo || F.mo.has(t.getUTCMonth() + 1)) &&
      (!F.dow || F.dow.has(t.getUTCDay()));
    if (ok) return t;
    t.setUTCMinutes(t.getUTCMinutes() - 1);
  }
  return null;
}

const stamp = (j) => {
  const v = j && (j.generated_at_utc || j.generatedAt || j.fetched_at_utc);
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? d : null;
};

// Each page family names its coverage fields differently. universe_size vs
// universe_total is left out: it measures a deliberate filter (e.g. dividend
// payers only), not failed loads.
const COVERAGE_PAIRS = [
  ["loadedCount", "universeSize"],
  ["loadedTickerCount", "universeTickerCount"],
  ["volLoadedCount", "universeSize"],
  ["splitsLoadedCount", "universeSize"],
  ["priceLoadedCount", "priceUniverseSize"],
];

function contentIssues(j) {
  const issues = [];
  if (!j || typeof j !== "object") return issues;
  if (j.partial === true) issues.push(["WARN", "marked partial"]);
  for (const [got, of] of COVERAGE_PAIRS) {
    if (typeof j[got] !== "number" || typeof j[of] !== "number" || j[of] <= 0) continue;
    // Companies with no transcript to score are a known gap, not a failed load.
    const accounted = j[got] + (got === "loadedCount" && typeof j.noTranscriptCount === "number" ? j.noTranscriptCount : 0);
    if (accounted / j[of] < LOW_COVERAGE) issues.push(["WARN", `${got} ${j[got]} of ${j[of]} (${Math.round((100 * j[got]) / j[of])}%)`]);
  }
  if (Array.isArray(j.failedTickers) && j.failedTickers.length) issues.push(["INFO", `failed tickers: ${j.failedTickers.join(", ")}`]);
  if (Array.isArray(j.warnings) && j.warnings.length) issues.push(["WARN", `warnings: ${j.warnings.map((w) => (typeof w === "string" ? w : JSON.stringify(w))).join("; ").slice(0, 200)}`]);
  return issues;
}

async function get(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, error: err.message, ms: Date.now() - t0 };
  }
}

const ago = (d, now) => {
  const h = (now - d) / 36e5;
  return h < 48 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(0)}d ago`;
};

async function main() {
  const asJson = process.argv.includes("--json");
  const now = new Date();
  // HEALTH_MANIFEST=path reads a local manifest, e.g. before the first deploy that serves it.
  const readLocal = (p) => ({ status: 200, json: JSON.parse(fs.readFileSync(p, "utf8")) });
  let mRes = process.env.HEALTH_MANIFEST ? readLocal(process.env.HEALTH_MANIFEST) : await get(`${SITE}/data-pull-schedule.json`);
  if (mRes.status !== 200 || !mRes.json) {
    const local = path.join(__dirname, "..", "data-pull-schedule.json");
    if (!fs.existsSync(local)) {
      console.error(`Could not read ${SITE}/data-pull-schedule.json (HTTP ${mRes.status || mRes.error}) and no local copy exists.`);
      process.exit(2);
    }
    if (!asJson) console.log(`Note: live schedule manifest unavailable (HTTP ${mRes.status || mRes.error}); using the local copy, which may differ from what is deployed.`);
    mRes = readLocal(local);
  }
  const { jobs, onRequest } = mRes.json;

  // API -> scheduled jobs that write it, and the oldest of their latest fires.
  // An endpoint fed by a daily and a weekly job only carries one timestamp, so
  // requiring it to beat the earliest of them avoids false "stale" alarms.
  const cutoff = new Date(now - GRACE_MIN * 60e3);
  const apis = {};
  for (const j of jobs) {
    for (const a of j.apis) {
      const e = (apis[a] = apis[a] || { api: a, jobs: [], pages: new Set(), due: null, manual: true });
      e.jobs.push(j.name);
      j.pages.forEach((p) => e.pages.add(p));
      if (j.cron) {
        e.manual = false;
        const f = lastFire(j.cron, cutoff);
        if (f && (!e.due || f < e.due)) e.due = f;
      }
    }
  }
  for (const o of onRequest) apis[o.api] = apis[o.api] || { api: o.api, jobs: [], pages: new Set(o.pages), live: true };

  const pageSlugs = [...new Set(Object.values(apis).flatMap((e) => [...e.pages]))];
  const htmlPages = [...new Set(["index", ...pageSlugs, ...fs.readdirSync(path.join(__dirname, "..")).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5))])];

  const results = [];
  await Promise.all(Object.values(apis).map(async (e) => {
    const r = { api: e.api, jobs: e.jobs, pages: [...e.pages], issues: [] };
    results.push(r);
    if (SKIP_LIVE.has(e.api)) { r.issues.push(["SKIP", "live Alpha Vantage call, not probed"]); return; }
    const res = await get(SITE + e.api);
    r.ms = res.ms;
    if (PROTECTED.has(e.api) && res.status === 401) { r.issues.push(["SKIP", "password-protected"]); return; }
    if (res.status !== 200) {
      const msg = (res.json && res.json.error) || res.error || (res.text || "").slice(0, 120);
      r.issues.push(["FAIL", `HTTP ${res.status}: ${msg}`]);
      return;
    }
    if (res.json && res.json.error) r.issues.push(["FAIL", `error: ${res.json.error}`]);
    const ts = stamp(res.json);
    r.generated = ts && ts.toISOString();
    if (!e.live) {
      if (!ts) r.issues.push(["WARN", "no generated timestamp"]);
      else if (e.manual) {
        if ((now - ts) / 864e5 > MANUAL_STALE_DAYS) r.issues.push(["WARN", `manual job, last run ${ago(ts, now)}`]);
        else r.issues.push(["INFO", `manual job, last run ${ago(ts, now)}`]);
      } else if (e.due && ts < new Date(e.due - 2 * 60e3)) {
        r.issues.push(["FAIL", `stale: generated ${ago(ts, now)}, expected a run at ${e.due.toISOString().slice(0, 16)}Z`]);
      }
    }
    r.issues.push(...contentIssues(res.json));
  }));

  const pageResults = await Promise.all(htmlPages.map(async (slug) => {
    const res = await get(`${SITE}/${slug === "index" ? "" : slug + ".html"}`);
    return { page: slug, status: res.status, issues: res.status === 200 ? [] : [["FAIL", `HTTP ${res.status || res.error}`]] };
  }));

  const rank = { FAIL: 0, WARN: 1, INFO: 2, SKIP: 3 };
  const worst = (r) => Math.min(...r.issues.map(([lvl]) => rank[lvl]), 9);
  results.sort((a, b) => worst(a) - worst(b) || a.api.localeCompare(b.api));
  const counts = { FAIL: 0, WARN: 0 };
  for (const r of [...results, ...pageResults]) for (const [lvl] of r.issues) if (lvl in counts) counts[lvl]++;

  if (asJson) {
    console.log(JSON.stringify({ checkedAt: now.toISOString(), site: SITE, counts, endpoints: results, pages: pageResults }, null, 2));
  } else {
    console.log(`Health check ${now.toISOString().slice(0, 16)}Z  ${SITE}`);
    console.log(`${counts.FAIL} FAIL, ${counts.WARN} WARN across ${results.length} endpoints and ${pageResults.length} pages\n`);
    for (const p of pageResults.filter((p) => p.issues.length)) console.log(`FAIL  /${p.page}.html  ${p.issues[0][1]}`);
    for (const r of results) {
      const shown = r.issues.filter(([lvl]) => lvl !== "SKIP");
      if (!shown.length) continue;
      const pages = r.pages.length ? `  [${r.pages.join(", ")}]` : "";
      for (const [lvl, msg] of shown) console.log(`${lvl.padEnd(5)} ${r.api}  ${msg}${pages}`);
    }
    const ok = results.filter((r) => !r.issues.some(([lvl]) => lvl === "FAIL" || lvl === "WARN")).length;
    console.log(`\n${ok} endpoints OK; ${pageResults.filter((p) => !p.issues.length).length}/${pageResults.length} pages load.`);
  }
  process.exit(counts.FAIL ? 1 : 0);
}

main();
