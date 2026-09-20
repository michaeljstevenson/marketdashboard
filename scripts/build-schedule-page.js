#!/usr/bin/env node
// Regenerates data-pull-schedule.html from netlify.toml and the function
// source, so the page can't drift from what the jobs actually do. Runs as
// the Netlify build command (see [build] in netlify.toml) and can be run by
// hand. On any error it leaves the existing page in place and exits 0, so a
// problem here never blocks a deploy.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FN_DIR = path.join(ROOT, "netlify", "functions");
const OUT = path.join(ROOT, "data-pull-schedule.html");

const HOST_LABELS = {
  "scanner.tradingview.com": "TradingView",
  "www.tradingview.com": "TradingView",
  "data.sec.gov": "SEC EDGAR",
  "mba.tuck.dartmouth.edu": "Ken French Data Library",
  "cdn.finra.org": "FINRA",
};
const IGNORED_HOSTS = new Set(["www.alphavantage.co", "query1.finance.yahoo.com", "finance.yahoo.com", "www.w3.org"]);
const NOT_SOURCES = /(-blob-store|^breadth-constituents|^beeswarm-sectors|^av-call-counter|^yahoo-client)$/;

const read = (p) => fs.readFileSync(p, "utf8");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stem = (j) => j.replace(/^scheduled-/, "").replace(/-background$/, "");

function parseToml() {
  const sched = {};
  const redirects = [];
  let fnBlock = null;
  let redirect = null;
  for (const raw of read(path.join(ROOT, "netlify.toml")).split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    let m = t.match(/^\[functions\."([^"]+)"\]$/);
    if (m) { fnBlock = m[1]; redirect = null; continue; }
    if (t === "[[redirects]]") { redirect = {}; redirects.push(redirect); fnBlock = null; continue; }
    if (t.startsWith("[")) { fnBlock = null; redirect = null; continue; }
    m = t.match(/^schedule\s*=\s*"([^"]+)"/);
    if (m && fnBlock) sched[fnBlock] = m[1];
    m = t.match(/^(from|to)\s*=\s*"([^"]+)"/);
    if (m && redirect) redirect[m[1]] = m[2];
  }
  return { sched, redirects };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function dayText(dow) {
  if (dow === "*") return "Every day";
  if (dow === "1-5") return "Mon–Fri";
  const one = (d) => DAY_NAMES[Number(d) % 7];
  if (/^\d$/.test(dow)) return one(dow);
  if (/^\d(,\d)+$/.test(dow)) return dow.split(",").map((d) => one(d).slice(0, 3)).join(", ");
  if (/^\d-\d$/.test(dow)) return dow.split("-").map((d) => one(d).slice(0, 3)).join("–");
  return null;
}

function describeCron(cron) {
  if (!cron) return { group: "Manual", text: "Manual: run by hand", sort: [4, 0], dow: null };
  const raw = { group: "Other", text: `Schedule ${cron} (UTC)`, sort: [3.5, 0], dow: null };
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [min, hour, dom, month, dow] = parts;
  const day = dayText(dow);
  if (!day || dom !== "*" || month !== "*") return raw;
  const pad = (n) => String(n).padStart(2, "0");
  if (min.startsWith("*/") && /^\d+-\d+$/.test(hour)) {
    const step = parseInt(min.slice(2), 10);
    const [a, b] = hour.split("-").map(Number);
    return { group: "Intraday", text: `${day}, every ${step} min, ${pad(a)}:00–${pad(b)}:${pad(60 - step)} UTC`, sort: [0, a * 60], dow };
  }
  if (/^\d+$/.test(min) && /^\d+-\d+$/.test(hour)) {
    const [a, b] = hour.split("-").map(Number);
    return { group: "Intraday", text: `${day}, hourly at :${pad(min)}, ${pad(a)}:${pad(min)}–${pad(b)}:${pad(min)} UTC`, sort: [0, a * 60 + Number(min)], dow };
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const t = Number(hour) * 60 + Number(min);
    const group = dow === "1-5" ? "Weekdays" : dow === "*" ? "Daily" : "Weekly";
    const rank = { Weekdays: 1, Daily: 2, Weekly: 3 }[group];
    return { group, text: `${day} ${pad(Number(hour))}:${pad(Number(min))} UTC`, sort: [rank, t], dow };
  }
  return raw;
}

function main() {
  const NOTES = JSON.parse(read(path.join(__dirname, "schedule-notes.json")));
  const { sched, redirects } = parseToml();
  const files = fs.readdirSync(FN_DIR).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
  const jobs = files.filter((f) => f.startsWith("scheduled-"));
  const src = (n) => read(path.join(FN_DIR, n + ".js"));

  // API path -> function, and function -> API paths
  const fnOfApi = {};
  const apisOfFn = {};
  for (const r of redirects) {
    if (!r.from || !r.from.startsWith("/api/") || !r.to) continue;
    const fn = r.to.split("/").pop();
    fnOfApi[r.from] = fn;
    (apisOfFn[fn] = apisOfFn[fn] || []).push(r.from);
  }

  // Pages: title and the /api paths each page calls
  const titleOf = {};
  const pagesOfApi = {};
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith(".html") && x !== "data-pull-schedule.html")) {
    const html = read(path.join(ROOT, f));
    const slug = f.slice(0, -5);
    const t = html.match(/<title>([\s\S]*?)<\/title>/);
    titleOf[slug] = slug === "index" ? "Homepage" : (t ? t[1].replace(/\s+/g, " ").replace(/\s*[—-]\s*Michael J\. Stevenson.*$/, "").trim() : slug)
      .replace(/&amp;/g, "&");
    for (const a of new Set(html.match(/\/api\/[A-Za-z0-9_-]+/g) || [])) (pagesOfApi[a] = pagesOfApi[a] || []).push(slug);
  }

  // Blob stores: who writes, who reads
  const storeMods = files.filter((f) => f.endsWith("-blob-store"));
  const getterOf = {};
  for (const m of storeMods) {
    const g = src(m).match(/module\.exports\s*=\s*\{\s*(get\w+)/);
    if (g) getterOf[m] = g[1];
  }
  const requiredStores = (code) => [...new Set([...code.matchAll(/require\("\.\/([a-z0-9-]+-blob-store)"\)/g)].map((m) => m[1]))];
  // A job writes to a store when it calls setJSON with a key constant that it
  // imported from that store's module (variable names can't be trusted: one
  // job may hold a read store and a write store under the same name).
  const importedNames = (code, mod) => {
    const m = code.match(new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*require\\("\\./${mod}"\\)`));
    if (!m) return new Set();
    return new Set(m[1].split(",").map((x) => x.trim().split(":").pop().trim()).filter(Boolean));
  };
  const setJsonKeys = (code) => [...code.matchAll(/\.setJSON\(\s*([A-Za-z_]\w*)/g)].map((m) => m[1]);
  const writesStore = (code, mod) => {
    const g = getterOf[mod];
    if (!g) return false;
    const names = importedNames(code, mod);
    const keys = setJsonKeys(code);
    if (keys.some((k) => names.has(k) && k !== g)) return true;
    // No setJSON key traces back to any store module: fall back to the getter's variable
    const traced = requiredStores(code).some((m) => keys.some((k) => importedNames(code, m).has(k)));
    if (traced) return false;
    if (new RegExp(`${g}\\(\\)\\s*\\.setJSON`).test(code)) return true;
    for (const v of code.matchAll(new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*${g}\\(\\)`, "g"))) {
      if (new RegExp(`\\b${v[1]}\\.setJSON`).test(code)) return true;
    }
    return false;
  };
  const readers = {};
  for (const f of files) {
    if (f.startsWith("scheduled-") || f.endsWith("-blob-store")) continue;
    for (const m of requiredStores(src(f))) (readers[m] = readers[m] || new Set()).add(f);
  }

  // Sources: the job's own code plus the local modules it pulls in
  function scanSources(name, depth, seen) {
    if (seen.has(name) || !files.includes(name)) return { av: [], yahoo: false, hosts: [] };
    seen.add(name);
    const code = src(name);
    let av = [...code.matchAll(/function=([A-Z_]+)/g)].map((m) => m[1])
      .concat([...code.matchAll(/(?:fetchStatement|fetchAnnual)\([^)]*"([A-Z_]+)"/g)].map((m) => m[1]))
      .concat([...code.matchAll(/"(BALANCE_SHEET|INCOME_STATEMENT|CASH_FLOW|SPLITS)"/g)].map((m) => m[1]));
    let yahoo = /yahoo-client|finance\.yahoo\.com/.test(code);
    let hosts = [...code.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)].map((m) => m[1]).filter((h) => !IGNORED_HOSTS.has(h));
    if (depth < 1) {
      for (const m of code.matchAll(/require\("\.\/([a-z0-9-]+)"\)/g)) {
        if (NOT_SOURCES.test(m[1])) continue;
        const sub = scanSources(m[1], depth + 1, seen);
        av = av.concat(sub.av); yahoo = yahoo || sub.yahoo; hosts = hosts.concat(sub.hosts);
      }
    }
    return { av, yahoo, hosts };
  }

  const rows = jobs.map((job) => {
    const code = src(job);
    const s = scanSources(job, 0, new Set());
    const av = [...new Set(s.av)].sort();
    const stores = requiredStores(code);
    const writes = stores.filter((m) => writesStore(code, m));
    const reads = stores.filter((m) => !writes.includes(m));
    const apis = writes.flatMap((w) => [...(readers[w] || [])].flatMap((f) => apisOfFn[f] || []));
    const pages = [...new Set(apis.flatMap((a) => pagesOfApi[a] || []))];
    const sources = [];
    if (av.length) sources.push(`Alpha Vantage: ${av.join(", ")}`);
    if (s.yahoo) sources.push("Yahoo Finance");
    for (const label of new Set(s.hosts.map((h) => HOST_LABELS[h] || h))) sources.push(label);
    const dependsOn = reads.map((m) => m.replace(/-blob-store$/, "")).filter((m) => m !== "beeswarm");
    return { job, name: stem(job), cron: sched[job] || null, when: describeCron(sched[job]), sources, pages, writes, reads, dependsOn };
  });

  // Jobs with no page of their own feed the page of a job that reads their data
  for (const r of rows) {
    if (r.pages.length) continue;
    const down = rows.filter((k) => k.job !== r.job && k.reads.some((m) => r.writes.includes(m)));
    r.pages = [...new Set(down.flatMap((k) => k.pages))];
    r.via = r.pages.length > 0;
    if (!r.sources.length && r.reads.length) r.sources.push("Stored data: " + r.dependsOn.join(", "));
  }
  for (const r of rows) if (!r.sources.length && r.dependsOn.length) r.sources.push("Stored data: " + r.dependsOn.join(", "));

  // Endpoints that fetch live when a page asks, rather than on a schedule
  const onRequest = [];
  for (const [api, fn] of Object.entries(fnOfApi)) {
    if (!files.includes(fn) || fn.startsWith("scheduled-")) continue;
    const code = src(fn);
    if (requiredStores(code).length) continue;
    const s = scanSources(fn, 0, new Set());
    const av = [...new Set(s.av)].sort();
    if (!av.length && !s.yahoo) continue;
    const ages = [...code.matchAll(/max-age=(\d+)/g)].map((m) => Number(m[1]));
    const secs = ages.length ? Math.max(...ages) : 0;
    const cache = secs >= 3600 ? `${secs / 3600} hour${secs === 3600 ? "" : "s"}` : secs ? `${secs / 60} minutes` : "not cached";
    const sources = [];
    if (av.length) sources.push(`Alpha Vantage: ${av.join(", ")}`);
    if (s.yahoo) sources.push("Yahoo Finance");
    onRequest.push({ api, name: api, when: `Fetched live when the page asks; cached ${cache}`, sources, pages: pagesOfApi[api] || [], notes: NOTES[api.slice(5)] || "" });
  }

  rows.sort((a, b) => a.when.sort[0] - b.when.sort[0] || a.when.sort[1] - b.when.sort[1] || (titleOf[a.pages[0]] || a.name).localeCompare(titleOf[b.pages[0]] || b.name));

  const pageLinks = (slugs, via) =>
    (slugs.length ? slugs.map((s) => `<a href="${s === "index" ? "/" : "/" + esc(s) + ".html"}">${esc(titleOf[s] || s)}</a>`).join("<br>") : "—") +
    (via ? " <small>(via another job)</small>" : "");
  const cell = (r) => {
    const n = NOTES[r.name] || "";
    const dep = r.dependsOn.length && !r.sources.some((x) => x.startsWith("Stored data")) ? `Reads: ${r.dependsOn.join(", ")}` : "";
    return esc(n) + (n && dep ? "<br>" : "") + esc(dep);
  };
  const body = rows.map((r) => `<tr><td>${pageLinks(r.pages, r.via)}</td><td class="m">${esc(r.name)}</td><td>${esc(r.when.text)}</td><td>${r.sources.map(esc).join("<br>") || "—"}</td><td>${cell(r)}</td></tr>`)
    .concat(onRequest.map((o) => `<tr><td>${pageLinks(o.pages, false)}</td><td class="m">${esc(o.name)}</td><td>${esc(o.when)}</td><td>${o.sources.map(esc).join("<br>")}</td><td>${esc(o.notes)}</td></tr>`));

  const built = new Date().toISOString().slice(0, 10);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Data Pull Schedule</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:20px;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#14181c;color:#eae6da}th{background:#1c2127}th,td{border-color:#2b3138}a{color:#9db8d2}}
h1{font-size:22px;margin:0 0 6px}
p{margin:0 0 16px;max-width:75ch}
.w{overflow-x:auto}
table{border-collapse:collapse;min-width:900px;width:100%}
th,td{text-align:left;vertical-align:top;padding:7px 10px;border:1px solid #d8d8d8}
th{background:#f2f2f2;position:sticky;top:0}
.m{font-family:ui-monospace,Menlo,monospace;font-size:12px}
small{opacity:.7}
</style>
</head>
<body>
<h1>Data Pull Schedule</h1>
<p>Every job that fetches data for this site, what it pulls, and when. Times are UTC; New York is UTC−4 until November 1, then UTC−5. Manual jobs run only when triggered by hand. This page is regenerated from the site's configuration on every deploy (last built ${built}).</p>
<div class="w">
<table>
<thead><tr><th>Page</th><th>Job</th><th>When</th><th>Pulled from</th><th>Notes</th></tr></thead>
<tbody>
${body.join("\n")}
</tbody>
</table>
</div>
</body>
</html>
`;
  fs.writeFileSync(OUT, html);
  const sched30 = rows.filter((r) => r.cron).length;
  console.log(`data-pull-schedule.html: ${rows.length} jobs (${sched30} scheduled, ${rows.length - sched30} manual) + ${onRequest.length} on-request endpoints`);
}

try {
  main();
} catch (err) {
  console.error("data-pull-schedule.html NOT regenerated (existing page kept): " + err.message);
}
