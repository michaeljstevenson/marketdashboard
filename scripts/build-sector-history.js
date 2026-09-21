#!/usr/bin/env node
// Writes sector-history.json: full inception-to-date daily closes for SPY and
// the 11 sector ETFs, column-oriented (one shared date axis, one array per
// ticker), served as a static file for the sector-analysis.html chart. Run
// daily by .github/workflows/sector-history.yml, which commits the result;
// the page also appends any closes newer than `through` from the live
// /api/sector-performance payload, so it stays current between runs.
//
//   node scripts/build-sector-history.js

const fs = require("fs");
const path = require("path");
const { fetchDailyHistory, sleep } = require("../netlify/functions/yahoo-client");

const TICKERS = ["SPY", "XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"];

(async () => {
  const all = {};
  for (const t of TICKERS) {
    all[t] = await fetchDailyHistory(t);
    console.log(t, all[t].length, all[t][0].date);
    await sleep(300);
  }
  const dates = [...new Set(Object.values(all).flatMap((c) => c.map((x) => x.date)))].sort();
  const index = new Map(dates.map((d, i) => [d, i]));
  const series = {};
  for (const t of TICKERS) {
    const col = new Array(dates.length).fill(null);
    for (const c of all[t]) col[index.get(c.date)] = Math.round(c.close * 100) / 100;
    series[t] = col;
  }
  const out = path.join(__dirname, "..", "sector-history.json");
  fs.writeFileSync(out, JSON.stringify({ through: dates[dates.length - 1], dates, series }));
  console.log("wrote", out, (fs.statSync(out).size / 1024).toFixed(0) + " KB,", dates.length, "dates");
})();
