// Scheduled function (see [functions."scheduled-seasonality-background"]
// in netlify.toml) that fetches full daily S&P 500 (^GSPC) history from
// Yahoo Finance, computes every statistic /seasonality.html shows (day of
// week, day of month, calendar month, quarter, election cycle, holiday
// effect, and the year-by-month heatmap) for each of the page's history
// windows, and writes the finished result to Netlify Blobs.
//
// This moves ALL of the seasonality math server-side, once a day, instead
// of recomputing it in the visitor's browser on every page load —
// seasonality-history.js just reads the pre-computed blob, so a page load
// is a single cheap JSON fetch with no client-side aggregation.
//
// Not an Alpha Vantage job (Yahoo has no daily quota here, unlike AV), so
// there's no rate-limit contention with the other scheduled-*-background
// jobs; still staggered after them out of habit, and named "-background"
// because retries on Yahoo's occasional 429s (see fetchChunk) can push a
// run past a standard function's ~10-26s budget.

const { getSeasonalityStore, BLOB_KEY } = require("./seasonality-blob-store");

const YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC";
// Deliberately a bare UA, not a full Chrome UA string like the rest of this
// project's fetchers use — Yahoo's chart endpoint reliably 429s a full
// browser-style UA on multi-year ranges but accepts this one every time.
const USER_AGENT = "Mozilla/5.0";

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const GLOBAL_RANGES = [
  { key: "Full", startYear: null },
  { key: "1950", startYear: 1950 },
  { key: "1980", startYear: 1980 },
  { key: "2000", startYear: 2000 },
];

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Yahoo's chart endpoint 429s intermittently on multi-year ranges even
// well under any documented quota — retrying the same request a moment
// later reliably succeeds, so this is a transient throttle rather than a
// hard block.
async function fetchChunk(period1, period2, attempt = 1) {
  const url = `${YAHOO_URL}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (res.status === 429 && attempt < 4) {
    await sleep(attempt * 1500);
    return fetchChunk(period1, period2, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching Yahoo chart data (${period1}-${period2})`);
  const payload = await res.json();
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) {
    throw new Error(
      "Yahoo chart response missing result: " +
        JSON.stringify((payload && payload.chart && payload.chart.error) || payload).slice(0, 200)
    );
  }
  const timestamps = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0].close) || [];
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null) continue;
    bars.push({ date: dateFormatter.format(new Date(timestamps[i] * 1000)), close: round(close, 2) });
  }
  return bars;
}

async function fetchAllBars() {
  // ~20-year chunks rather than one 1927-to-present request; chunking
  // isn't strictly required to dodge the 429s (that turned out to be the
  // User-Agent, see above) but keeps each response well under any
  // payload/duration limit for a ~24k-point series.
  const now = Math.floor(Date.now() / 1000);
  const boundaries = [-2208988800, -631152000, 0, 631152000, 1262304000, now];
  const byDate = new Map();
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (i > 0) await sleep(400);
    const chunk = await fetchChunk(boundaries[i], boundaries[i + 1]);
    chunk.forEach((bar) => byDate.set(bar.date, bar));
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

function parseUTC(dateStr) {
  return new Date(dateStr + "T00:00:00Z");
}

function mean(arr) {
  if (!arr.length) return null;
  return round(arr.reduce((a, b) => a + b, 0) / arr.length, 4);
}

function pctPositive(arr) {
  if (!arr.length) return null;
  return round((arr.filter((v) => v > 0).length / arr.length) * 100, 2);
}

function stdev(arr) {
  if (arr.length < 2) return null;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
  return round(Math.sqrt(v), 4);
}

function minMaxMedian(arr) {
  if (!arr.length) return { min: null, median: null, max: null };
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min: round(sorted[0], 3), median: round(median, 3), max: round(sorted[sorted.length - 1], 3) };
}

// Raw power sums (Σx, Σx², Σx³, Σx⁴), not central moments — these add
// linearly across rows, so the client can exactly recombine mean,
// variance, and (crucially) excess kurtosis for any subset of rows a
// visitor has filtered down to, without needing the raw per-day values.
// Kurtosis is what lets the distribution tab fit a Student's t-curve
// instead of a normal one: stock returns are famously fat-tailed
// (leptokurtic), so a normal reference curve understates real tail risk,
// and a t-distribution fit via method-of-moments on the sample's own
// excess kurtosis is the actual right-shaped model, not just a
// same-mean-and-stdev normal overlay.
function rawMoments(arr) {
  let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
  arr.forEach((x) => {
    m1 += x;
    m2 += x * x;
    m3 += x * x * x;
    m4 += x * x * x * x;
  });
  // Not rounded, unlike this file's other outputs — these get summed
  // across rows client-side to recompute exact combined moments, so
  // truncating precision here would compound into the fitted curve.
  return { n: arr.length, m1, m2, m3, m4 };
}

// Bin width is picked to land near `targetBins` bins across the sample's
// own min/max, rounded outward to a "nice" step (1, 2, 2.5, 5, 10, ...) so
// the histogram's x-axis reads in round numbers instead of fractions like
// 0.37%. Edges are computed once from the full (unfiltered) history and
// reused for every history-window range, so switching ranges on the page
// doesn't rescale the distribution's x-axis out from under the viewer.
const NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25];
function histogramEdges(values, targetBins) {
  const min = Math.min(...values), max = Math.max(...values);
  const rawStep = (max - min) / targetBins;
  const step = NICE_STEPS.find((s) => s >= rawStep) || Math.ceil(rawStep);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const edges = [];
  for (let v = start; v <= end + step / 2; v += step) edges.push(round(v, 3));
  return edges;
}

// Edges are evenly spaced, so the bin index is a direct calculation
// rather than a search; out-of-range values (a handful of extreme days
// like Oct 1987 can fall outside even a generous span) clamp into the
// first/last bin rather than being silently dropped.
function histogramCounts(values, edges) {
  const counts = new Array(edges.length - 1).fill(0);
  const step = edges[1] - edges[0];
  const min = edges[0], max = edges[edges.length - 1];
  values.forEach((v) => {
    const clamped = Math.min(Math.max(v, min), max - step / 1e6);
    let idx = Math.floor((clamped - min) / step);
    if (idx < 0) idx = 0;
    if (idx >= counts.length) idx = counts.length - 1;
    counts[idx]++;
  });
  return counts;
}

function dailyReturns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close, cur = bars[i].close;
    if (prev == null || cur == null || prev === 0) continue;
    out.push({ date: bars[i].date, ret: (cur / prev - 1) * 100 });
  }
  return out;
}

function groupMeanByDow(returns, edges) {
  const buckets = [1, 2, 3, 4, 5].map((dow) => ({ dow, label: DOW_NAMES[dow], vals: [] }));
  returns.forEach((r) => {
    const dow = parseUTC(r.date).getUTCDay();
    const b = buckets.find((x) => x.dow === dow);
    if (b) b.vals.push(r.ret);
  });
  return buckets.map((b) => ({
    label: b.label,
    mean: mean(b.vals),
    n: b.vals.length,
    pctPositive: pctPositive(b.vals),
    stdev: stdev(b.vals),
    histogram: histogramCounts(b.vals, edges),
    moments: rawMoments(b.vals),
    ...minMaxMedian(b.vals),
  }));
}

function groupMeanByDom(returns, edges) {
  const buckets = [];
  for (let d = 1; d <= 31; d++) buckets.push({ day: d, vals: [] });
  returns.forEach((r) => {
    const day = parseUTC(r.date).getUTCDate();
    buckets[day - 1].vals.push(r.ret);
  });
  return buckets.map((b) => ({
    label: String(b.day),
    mean: mean(b.vals),
    n: b.vals.length,
    pctPositive: pctPositive(b.vals),
    stdev: stdev(b.vals),
    histogram: histogramCounts(b.vals, edges),
    moments: rawMoments(b.vals),
    ...minMaxMedian(b.vals),
  }));
}

// Compounds daily returns within each calendar period (last close of the
// period vs last close of the prior period) rather than averaging daily
// returns that happen to fall in it — what "average April return" or
// "average Q4 return" normally means.
function periodReturns(bars, keyFn) {
  const periods = [];
  let curKey = null, curLastClose = null, prevClose = null;
  bars.forEach((b) => {
    const key = keyFn(parseUTC(b.date));
    if (key !== curKey) {
      if (curKey !== null && prevClose != null) {
        periods.push({ key: curKey, ret: (curLastClose / prevClose - 1) * 100 });
      }
      prevClose = curLastClose != null ? curLastClose : b.close;
      curKey = key;
    }
    curLastClose = b.close;
  });
  return periods;
}

function monthlyReturnsByCalendarMonth(bars, edges) {
  const periods = periodReturns(bars, (d) => d.getUTCFullYear() * 12 + d.getUTCMonth());
  const buckets = MONTH_NAMES.map((label, i) => ({ label, month: i, vals: [] }));
  periods.forEach((p) => {
    const m = ((p.key % 12) + 12) % 12;
    buckets[m].vals.push(p.ret);
  });
  return buckets.map((b) => ({
    label: b.label,
    mean: mean(b.vals),
    n: b.vals.length,
    pctPositive: pctPositive(b.vals),
    stdev: stdev(b.vals),
    histogram: histogramCounts(b.vals, edges),
    moments: rawMoments(b.vals),
    ...minMaxMedian(b.vals),
  }));
}

function quarterlyReturnsByCalendarQuarter(bars, edges) {
  const periods = periodReturns(bars, (d) => d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3));
  const buckets = [0, 1, 2, 3].map((q) => ({ label: "Q" + (q + 1), q, vals: [] }));
  periods.forEach((p) => {
    const q = ((p.key % 4) + 4) % 4;
    buckets[q].vals.push(p.ret);
  });
  return buckets.map((b) => ({
    label: b.label,
    mean: mean(b.vals),
    n: b.vals.length,
    pctPositive: pctPositive(b.vals),
    stdev: stdev(b.vals),
    histogram: histogramCounts(b.vals, edges),
    moments: rawMoments(b.vals),
    ...minMaxMedian(b.vals),
  }));
}

// Single-row "table" of full calendar-year returns — there's no natural
// sub-category to group years by (unlike weekday/day-of-month/month/
// quarter), so this is just the whole sample's year-by-year distribution:
// same stat/histogram/distribution machinery as the other four tables,
// applied to n≈1 bucket instead of 5/31/12/4.
function annualReturns(bars, edges) {
  const periods = periodReturns(bars, (d) => d.getUTCFullYear());
  const vals = periods.map((p) => p.ret);
  return [{
    label: "All Years",
    mean: mean(vals),
    n: vals.length,
    pctPositive: pctPositive(vals),
    stdev: stdev(vals),
    histogram: histogramCounts(vals, edges),
    moments: rawMoments(vals),
    ...minMaxMedian(vals),
  }];
}

// Cycle position derived from the calendar year itself (year % 4), not an
// explicit list of election dates — U.S. presidential elections fall in
// every year divisible by 4, so this generalizes across the whole sample
// without hardcoding a century of election dates.
function electionCycleReturns(bars) {
  const periods = periodReturns(bars, (d) => d.getUTCFullYear());
  const labels = ["Election Year", "Post-Election Year", "Midterm Year", "Pre-Election Year"];
  const buckets = labels.map((label) => ({ label, vals: [] }));
  periods.forEach((p) => {
    const pos = ((p.key % 4) + 4) % 4;
    buckets[pos].vals.push(p.ret);
  });
  return buckets.map((b) => ({ label: b.label, mean: mean(b.vals), n: b.vals.length, pctPositive: pctPositive(b.vals) }));
}

// A trading day is flagged as bordering a holiday when the calendar gap to
// its neighbor exceeds a normal weekend — this catches every U.S. market
// holiday generically (including one-offs like 9/11 or Hurricane Sandy
// closures) without maintaining a holiday calendar.
function holidayBucket(returns) {
  const sorted = returns.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const before = [], after = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const curDate = parseUTC(cur.date);
    const next = sorted[i + 1];
    if (next) {
      const gapDays = Math.round((parseUTC(next.date) - curDate) / 86400000);
      const dow = curDate.getUTCDay();
      if (dow === 5 ? gapDays > 3 : gapDays > 1) before.push(cur.ret);
    }
    const prev = sorted[i - 1];
    if (prev) {
      const prevDate = parseUTC(prev.date);
      const gapDays = Math.round((curDate - prevDate) / 86400000);
      const prevDow = prevDate.getUTCDay();
      if (prevDow === 5 ? gapDays > 3 : gapDays > 1) after.push(cur.ret);
    }
  }
  return { before, after, all: returns.map((r) => r.ret) };
}

function holidaySummary(returns) {
  const { before, after, all } = holidayBucket(returns);
  const summarize = (arr) => ({ mean: mean(arr), n: arr.length, pctPositive: pctPositive(arr) });
  return { all: summarize(all), before: summarize(before), after: summarize(after) };
}

function buildHeatmap(bars) {
  const periods = periodReturns(bars, (d) => d.getUTCFullYear() * 12 + d.getUTCMonth());
  const byYear = new Map();
  periods.forEach((p) => {
    const year = Math.floor(p.key / 12);
    const month = ((p.key % 12) + 12) % 12;
    if (!byYear.has(year)) byYear.set(year, {});
    byYear.get(year)[month] = round(p.ret, 3);
  });
  const years = Array.from(byYear.keys()).sort((a, b) => b - a);
  return years.map((year) => {
    const row = byYear.get(year);
    const months = [];
    let compound = 1, any = false;
    for (let m = 0; m < 12; m++) {
      const v = row[m] != null ? row[m] : null;
      months.push(v);
      if (v != null) {
        any = true;
        compound *= 1 + v / 100;
      }
    }
    return { year, months, total: any ? round((compound - 1) * 100, 3) : null };
  });
}

function computeRangeStats(bars, edges) {
  const returns = dailyReturns(bars);
  return {
    startDate: bars.length ? bars[0].date : null,
    endDate: bars.length ? bars[bars.length - 1].date : null,
    count: returns.length,
    pctPositive: pctPositive(returns.map((r) => r.ret)),
    dow: groupMeanByDow(returns, edges.daily),
    dom: groupMeanByDom(returns, edges.daily),
    month: monthlyReturnsByCalendarMonth(bars, edges.month),
    quarter: quarterlyReturnsByCalendarQuarter(bars, edges.quarter),
    year: annualReturns(bars, edges.annual),
    election: electionCycleReturns(bars),
    holiday: holidaySummary(returns),
    heatmap: buildHeatmap(bars),
  };
}

exports.handler = async () => {
  try {
    const allBars = await fetchAllBars();

    // Shared bin edges, computed once from the full unfiltered history so
    // every range (Full/1950/1980/2000) and every row within a table
    // plots on the same x-axis — necessary for the "distribution" tab to
    // sum multiple rows' histograms together (see renderDistribution in
    // seasonality.html) and for switching history windows not to rescale
    // the chart underneath the viewer.
    const edges = {
      daily: histogramEdges(dailyReturns(allBars).map((r) => r.ret), 60),
      month: histogramEdges(periodReturns(allBars, (d) => d.getUTCFullYear() * 12 + d.getUTCMonth()).map((p) => p.ret), 36),
      quarter: histogramEdges(periodReturns(allBars, (d) => d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3)).map((p) => p.ret), 32),
      annual: histogramEdges(periodReturns(allBars, (d) => d.getUTCFullYear()).map((p) => p.ret), 28),
    };

    const ranges = {};
    GLOBAL_RANGES.forEach((r) => {
      const bars = r.startYear ? allBars.filter((b) => parseUTC(b.date).getUTCFullYear() >= r.startYear) : allBars;
      ranges[r.key] = computeRangeStats(bars, edges);
    });

    const payload = {
      asOf: allBars.length ? allBars[allBars.length - 1].date : null,
      generatedAt: new Date().toISOString(),
      histogramEdges: edges,
      ranges,
    };

    const store = getSeasonalityStore();
    await store.setJSON(BLOB_KEY, payload);

    return { statusCode: 200, body: JSON.stringify({ ok: true, asOf: payload.asOf, bars: allBars.length }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
