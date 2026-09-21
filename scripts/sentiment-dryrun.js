#!/usr/bin/env node
// Runs the sentiment engine end-to-end against live Yahoo data and the
// deployed breadth feed, without writing anything. Prints a summary and
// writes the full result to the path given as argv[2] (default: stdout summary only).
const fs = require("fs");
const { fetchDailyBars, sleep } = require("../netlify/functions/yahoo-client");
const { buildIndex } = require("../netlify/functions/sentiment-engine");

(async () => {
  const get = async (sym) => { const r = await fetchDailyBars(sym); await sleep(300); return r; };
  const inputs = {
    spx: await get("^GSPC"), vix: await get("^VIX"), vix3m: await get("^VIX3M"), skew: await get("^SKEW"),
    rut: await get("^RUT"), ust: await get("VUSTX"), hyg: await get("HYG"), lqd: await get("LQD"),
    vwehx: await get("VWEHX"), vwesx: await get("VWESX"), rsp: await get("RSP"),
  };
  const b = await (await fetch("https://michaeljstevenson.co/api/breadth-internals")).json();
  inputs.breadth = b.rows; inputs.constituentCount = b.constituentCount;
  const out = buildIndex(inputs, { debug: true });
  console.log("composite", out.compositeExact, "asOf", out.asOfDate, "coverage", out.coverage, "missing", out.missing);
  console.log("history", out.history.length, out.history[0], out.history.at(-1));
  for (const c of out.components) console.log(c.id.padEnd(14), String(c.value).padStart(9), "z", String(c.z).padStart(6), "score", String(c.score).padStart(5), "w", c.weight, "contrib", c.contribution, "asOf", c.asOf, "hist", c.history.length);
  // pairwise correlation of factor scores, and each factor vs the composite of the others
  const ids = Object.keys(out.debug.scores);
  const S = out.debug.scores;
  const corr = (a, b) => { let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; for (let i = 0; i < a.length; i++) { if (a[i] == null || b[i] == null) continue; n++; sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; } const cov = sab / n - (sa / n) * (sb / n); return cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2)); };
  console.log("\ncorr with composite:");
  for (const id of ids) console.log(id.padEnd(14), corr(S[id], out.debug.composite).toFixed(2));
  console.log("\nfactor-factor corr (rows/cols):", ids.join(","));
  for (const a of ids) console.log(a.padEnd(14), ids.map((b) => corr(S[a], S[b]).toFixed(2)).join(" "));
  // 1-month forward SPY return by composite tercile (informational only)
  const dates = out.debug.dates, spy = inputs.spx.map((b) => b.close);
  const rows = []; for (let i = 0; i < dates.length - 21; i++) if (out.debug.composite[i] != null) rows.push([out.debug.composite[i], spy[i + 21] / spy[i] - 1]);
  rows.sort((x, y) => x[0] - y[0]); const t = Math.floor(rows.length / 3);
  const avg = (r) => (100 * r.reduce((a, x) => a + x[1], 0) / r.length).toFixed(2) + "%";
  console.log("\nfwd 21d SPY return: low tercile", avg(rows.slice(0, t)), "mid", avg(rows.slice(t, 2 * t)), "high", avg(rows.slice(2 * t)));
  const fwdCorr = corr(rows.map((r) => r[0]), rows.map((r) => r[1])); console.log("corr(composite, fwd21d)", fwdCorr.toFixed(3));
  if (process.argv[2]) { delete out.debug; fs.writeFileSync(process.argv[2], JSON.stringify(out)); }
})();
