#!/usr/bin/env node
// CLI front-end for the odd-stats streak scanner. The engine itself lives in
// netlify/functions/oddstats-engine.js (shared with the daily background job).
//
//   node scripts/oddstats-detect.js                 # live streaks, rarest first
//   node scripts/oddstats-detect.js --no-sectors    # S&P index conditions only
//   node scripts/oddstats-detect.js --json          # detect() output as JSON
//   node scripts/oddstats-detect.js --dump          # full board (feeds build-dashboard.js)
//   node scripts/oddstats-detect.js path/to/spx.csv # use a local CSV instead of Yahoo
//
// CSV: a header row plus Date,Open,High,Low,Close[,Adj Close]. Yahoo Finance
// and Stooq exports both work; Adj Close is used when present.

"use strict";

const {
  loadUniverse,
  detect,
  snapshot,
  HORIZONS,
  hzLabel,
} = require("../netlify/functions/oddstats-engine");

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const signedPct = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

function printHit(h) {
  console.log(`\n■ ${h.text}  [${h.group}]`);
  const rec = h.atRecord
    ? "longest on record"
    : `record ${h.histMaxRun}${h.histMaxDate ? " (" + h.histMaxDate.slice(0, 7) + ")" : ""}`;
  console.log(
    `  rarer than ${pct(h.rarity)} of past runs · ${rec} · ${h.analogCount} analogs · last ${h.lastOccurrence}`
  );
  for (const hz of HORIZONS) {
    const s = h.summary[hz];
    if (!s) continue;
    console.log(
      `  ${hzLabel(hz).padEnd(3)} median ${signedPct(s.medianRet)}  ` +
        `up ${pct(s.pctPositive)}  ` +
        `worst ${signedPct(s.worstRet)}  best ${signedPct(s.bestRet)}  ` +
        `${pct(s.pctWith3pctDrawdown)} saw a -3% dip  (n=${s.n})`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const noSectors = args.includes("--no-sectors");
  const mi = args.indexOf("--min-analogs");
  const minAnalogs = mi !== -1 ? parseInt(args[mi + 1], 10) : 5;
  const file = args.find((a, i) => !a.startsWith("--") && i !== mi + 1);

  if (!asJson) {
    console.error(
      (file ? `Loading ${file}` : "Fetching ^GSPC history from Yahoo") +
        (noSectors ? " ..." : " + sector ETFs + megacaps ...")
    );
  }
  const universe = await loadUniverse(file, { sectors: !noSectors });
  const rows = universe.primary.rows;

  if (args.includes("--dump")) {
    console.log(JSON.stringify(snapshot(universe)));
    return;
  }

  const { scanned, hits } = detect(universe, { minAnalogs });

  if (asJson) {
    console.log(JSON.stringify({ asOf: rows[rows.length - 1].date, scanned, hits }, null, 2));
    return;
  }

  console.log(
    `\nAs of ${rows[rows.length - 1].date} · S&P back to ${rows[0].date} · ` +
      `${universe.sectors.length} sector ETFs · ${scanned} conditions scanned`
  );
  if (!hits.length) {
    console.log("\nNo streak currently past its floor with enough analogs.");
    return;
  }
  console.log(`${hits.length} live streak${hits.length === 1 ? "" : "s"}, rarest first:`);
  hits.forEach(printHit);
  console.log("");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
