// Scheduled Background Function (see [functions."scheduled-volatility-background"]
// in netlify.toml) for the Implied vs. Realized Volatility page. Fetches the
// full daily history of the S&P 500 and the VIX family from Yahoo Finance
// once after the close and precomputes every series and summary the page
// draws, so a page load reads one blob (via volatility.js) instead of
// recomputing 36 years of rolling windows per request.
//
// Textbook definitions, deliberately different from the ATR-based "Realized
// Volatility" factor in the sentiment index: this page is meant to read as a
// recognizable comparison to anyone with finance training.
//   - Realized volatility: sample standard deviation of 20 daily log returns
//     of the S&P 500 close, x sqrt(252) x 100.
//   - Forward realized volatility: the same estimator over the 21 trading
//     days after each close, the trading-day equivalent of the 30 calendar
//     days the VIX prices.
//   - The VIX needs no transform: it is already an annualized 30-day
//     volatility in percent.
// Unadjusted closes throughout. The indices have no splits, and the forward
// S&P 500 returns are meant as price returns.

const { getVolatilityStore, BLOB_KEY } = require("./volatility-blob-store");
const { fetchDailyHistory, sleep } = require("./yahoo-client");

const SYMBOLS = [
  { key: "spx", symbol: "^GSPC", required: true },
  { key: "vix", symbol: "^VIX", required: true },
  { key: "vix3m", symbol: "^VIX3M" },
  { key: "vix6m", symbol: "^VIX6M" },
  { key: "vix9d", symbol: "^VIX9D" },
];

const HISTORY_START = "1990-01-02"; // first ^VIX close
const RV_WINDOW = 20;
const FORWARD_WINDOW = 21;
const PERCENTILE_WINDOW = 252;
const RETURN_HORIZONS = [21, 63, 252];
const TRADING_DAYS_PER_YEAR = 252;

// A close exactly on a boundary belongs to the higher bucket.
const VIX_BUCKETS = [
  { key: "lt15", label: "Under 15", lo: null, hi: 15 },
  { key: "15-20", label: "15 to 20", lo: 15, hi: 20 },
  { key: "20-25", label: "20 to 25", lo: 20, hi: 25 },
  { key: "25-30", label: "25 to 30", lo: 25, hi: 30 },
  { key: "30-40", label: "30 to 40", lo: 30, hi: 40 },
  { key: "40+", label: "40 and above", lo: 40, hi: null },
];

// Calendar-day horizons Cboe targets for each index. They only space the
// points along the curve's x-axis.
const TERM_POINTS = [
  { key: "vix9d", symbol: "VIX9D", days: 9 },
  { key: "vix", symbol: "VIX", days: 30 },
  { key: "vix3m", symbol: "VIX3M", days: 93 },
  { key: "vix6m", symbol: "VIX6M", days: 184 },
];

// Forward risk premium histogram, in vol points. Days beyond the range
// collect in the two open-ended end bins so a handful of crash days
// (2008, 2020) don't stretch the axis.
const HIST_BIN = 2;
const HIST_MIN = -20;
const HIST_MAX = 20;

function round(v, d) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Linear interpolation between closest ranks, the same rule the page's
// strip charts use for their boxes, so the table and the chart agree.
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(values, digits) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n: 0, median: null, p25: null, p75: null, mean: null, pctPositive: null };
  return {
    n,
    median: round(quantile(sorted, 0.5), digits),
    p25: round(quantile(sorted, 0.25), digits),
    p75: round(quantile(sorted, 0.75), digits),
    mean: round(sorted.reduce((s, v) => s + v, 0) / n, digits),
    pctPositive: round((sorted.filter((v) => v > 0).length / n) * 100, 1),
  };
}

// Sample standard deviation (n - 1) of logReturns[end - window + 1 .. end],
// annualized and in percent.
function realizedVol(logReturns, end, window) {
  let mean = 0;
  for (let j = end - window + 1; j <= end; j++) mean += logReturns[j];
  mean /= window;
  let ss = 0;
  for (let j = end - window + 1; j <= end; j++) ss += (logReturns[j] - mean) ** 2;
  return Math.sqrt(ss / (window - 1)) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

function bucketIndex(vix) {
  return VIX_BUCKETS.findIndex((b) => (b.lo === null || vix >= b.lo) && (b.hi === null || vix < b.hi));
}

function closesByDate(rows) {
  return new Map((rows || []).map((r) => [r.date, round(r.close, 2)]));
}

function etStamp(now) {
  return now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " ET";
}

// raw: { spx, vix, vix3m?, vix6m?, vix9d? }, each [{ date, close }] ascending
// as fetchDailyHistory returns them. Pure, so it can be run against saved
// data without Netlify.
function buildVolatilityPayload(raw, now = new Date()) {
  // Yahoo serves index closes as float32 values (17.239999771118164);
  // rounding restores the published two-decimal close before any
  // comparison against a bucket boundary or 1.0.
  const spx = raw.spx.map((r) => ({ date: r.date, close: round(r.close, 2) })).filter((r) => r.close > 0);
  const vixByDate = closesByDate(raw.vix);
  const termMaps = { vix3m: closesByDate(raw.vix3m), vix6m: closesByDate(raw.vix6m), vix9d: closesByDate(raw.vix9d) };

  const logReturns = [null];
  for (let k = 1; k < spx.length; k++) logReturns.push(Math.log(spx[k].close / spx[k - 1].close));
  const last = spx.length - 1;

  // One row per S&P 500 session since the VIX began. Yahoo also carries a
  // few VIX bars on exchange holidays (05/25/2026, 09/07/2026), which the
  // S&P 500 calendar drops.
  const rows = [];
  for (let k = RV_WINDOW; k <= last; k++) {
    const date = spx[k].date;
    if (date < HISTORY_START || !vixByDate.has(date)) continue;
    const vix = vixByDate.get(date);
    const vix3m = termMaps.vix3m.get(date) ?? null;
    rows.push({
      date,
      spx: spx[k].close,
      vix,
      bucket: bucketIndex(vix),
      realized: realizedVol(logReturns, k, RV_WINDOW),
      fwdRealized: k + FORWARD_WINDOW <= last ? realizedVol(logReturns, k + FORWARD_WINDOW, FORWARD_WINDOW) : null,
      ratio: vix3m ? vix / vix3m : null,
    });
  }
  if (rows.length < PERCENTILE_WINDOW + FORWARD_WINDOW) throw new Error(`Only ${rows.length} joined S&P 500 / VIX rows, expected thousands`);
  const n = rows.length;
  // Counted in rows (the same sessions the page indexes) so the page's
  // per-day dots and these summaries come from one definition.
  rows.forEach((r, i) => {
    r.fwdReturns = RETURN_HORIZONS.map((h) => (i + h < n ? (rows[i + h].spx / r.spx - 1) * 100 : null));
  });

  // Share of the previous 252 sessions that closed below the day's VIX, so
  // 100 means the highest close of the past year.
  const pct1y = rows.map((r, i) => {
    if (i < PERCENTILE_WINDOW) return null;
    let below = 0;
    for (let j = i - PERCENTILE_WINDOW; j < i; j++) if (rows[j].vix < r.vix) below++;
    return (below / PERCENTILE_WINDOW) * 100;
  });

  const latestRow = rows[n - 1];
  let belowAll = 0;
  for (let j = 0; j < n - 1; j++) if (rows[j].vix < latestRow.vix) belowAll++;
  const pctSince1990 = (belowAll / (n - 1)) * 100;

  const fwdRows = rows.filter((r) => r.fwdRealized !== null);
  const vrp = fwdRows.map((r) => r.vix - r.fwdRealized);
  const vrpSummary = summarize(vrp, 2);
  const binCount = (HIST_MAX - HIST_MIN) / HIST_BIN;
  const bins = [{ lo: null, hi: HIST_MIN, count: 0 }];
  for (let b = 0; b < binCount; b++) bins.push({ lo: HIST_MIN + b * HIST_BIN, hi: HIST_MIN + (b + 1) * HIST_BIN, count: 0 });
  bins.push({ lo: HIST_MAX, hi: null, count: 0 });
  for (const v of vrp) {
    if (v < HIST_MIN) bins[0].count++;
    else if (v >= HIST_MAX) bins[bins.length - 1].count++;
    else bins[1 + Math.floor((v - HIST_MIN) / HIST_BIN)].count++;
  }

  const ratioRows = rows.filter((r) => r.ratio !== null);
  const invertedDays = ratioRows.filter((r) => r.ratio > 1).length;

  const termDays = rows.filter((r) => TERM_POINTS.every((p) => p.key === "vix" || termMaps[p.key].has(r.date)));
  const termValue = (r, key) => (key === "vix" ? r.vix : termMaps[key].get(r.date));
  const termLatest = termDays.length ? termDays[termDays.length - 1] : null;
  const median = (values) => quantile(values.slice().sort((a, b) => a - b), 0.5);

  const buckets = VIX_BUCKETS.map((b, bi) => ({ ...b, days: rows.filter((r) => r.bucket === bi).length, stats: {} }));
  const allDays = {};
  RETURN_HORIZONS.forEach((h, hi) => {
    const byBucket = VIX_BUCKETS.map(() => []);
    for (const r of rows) {
      const v = r.fwdReturns[hi];
      if (v !== null) byBucket[r.bucket].push(v);
    }
    byBucket.forEach((values, bi) => { buckets[bi].stats[h] = summarize(values, 2); });
    allDays[h] = summarize(byBucket.flat(), 2);
  });

  const allVix = rows.map((r) => r.vix);
  const latestTerm = (key) => {
    const v = key === "vix" ? latestRow.vix : termMaps[key].get(latestRow.date);
    return v === undefined ? null : v;
  };

  return {
    generated_at_utc: now.toISOString(),
    timestamp: etStamp(now),
    asOfDate: latestRow.date,
    window: RV_WINDOW,
    forwardWindow: FORWARD_WINDOW,
    percentileWindow: PERCENTILE_WINDOW,
    latest: {
      date: latestRow.date,
      realized: round(latestRow.realized, 2),
      implied: latestRow.vix,
      spread: round(latestRow.vix - latestRow.realized, 2),
      vix9d: latestTerm("vix9d"),
      vix3m: latestTerm("vix3m"),
      vix6m: latestTerm("vix6m"),
      ratio: round(latestRow.ratio, 3),
      pctSince1990: round(pctSince1990, 1),
      pct1y: round(pct1y[n - 1], 1),
      bucket: VIX_BUCKETS[latestRow.bucket].key,
    },
    vixLevels: {
      start: rows[0].date,
      days: n,
      median: round(median(allVix), 2),
      mean: round(allVix.reduce((s, v) => s + v, 0) / n, 2),
    },
    forwardVrp: {
      start: fwdRows[0].date,
      end: fwdRows[fwdRows.length - 1].date,
      days: vrp.length,
      positiveDays: vrp.filter((v) => v > 0).length,
      pctPositive: vrpSummary.pctPositive,
      median: vrpSummary.median,
      mean: vrpSummary.mean,
      p25: vrpSummary.p25,
      p75: vrpSummary.p75,
      binWidth: HIST_BIN,
      bins,
    },
    ratio: ratioRows.length
      ? {
          start: ratioRows[0].date,
          end: ratioRows[ratioRows.length - 1].date,
          days: ratioRows.length,
          invertedDays,
          pctInverted: round((invertedDays / ratioRows.length) * 100, 1),
          median: round(median(ratioRows.map((r) => r.ratio)), 3),
        }
      : null,
    termStructure: termLatest
      ? {
          date: termLatest.date,
          points: TERM_POINTS.map((p) => ({ symbol: p.symbol, days: p.days, value: termValue(termLatest, p.key) })),
          median: {
            start: termDays[0].date,
            days: termDays.length,
            points: TERM_POINTS.map((p) => ({ symbol: p.symbol, days: p.days, value: round(median(termDays.map((r) => termValue(r, p.key))), 2) })),
          },
        }
      : null,
    forwardReturns: {
      start: rows[0].date,
      horizons: RETURN_HORIZONS,
      latestBucket: VIX_BUCKETS[latestRow.bucket].key,
      buckets: buckets.map((b) => ({ key: b.key, label: b.label, lo: b.lo, hi: b.hi, days: b.days, stats: b.stats })),
      all: { days: n, stats: allDays },
    },
    // Columnar, one entry per session since HISTORY_START. The page derives
    // the trailing and forward risk premiums (vix minus realized) and the
    // forward S&P 500 returns from these.
    series: {
      dates: rows.map((r) => r.date),
      spx: rows.map((r) => r.spx),
      vix: rows.map((r) => r.vix),
      realized: rows.map((r) => round(r.realized, 2)),
      fwdRealized: rows.map((r) => round(r.fwdRealized, 2)),
      ratio: rows.map((r) => round(r.ratio, 3)),
      pct1y: pct1y.map((v) => round(v, 0)),
    },
  };
}

exports.handler = async () => {
  console.log(`scheduled-volatility-background: starting, ${SYMBOLS.length} symbols`);
  try {
    const raw = {};
    const fetchInto = async ({ key, symbol }) => {
      try {
        raw[key] = await fetchDailyHistory(symbol, { adjusted: false });
      } catch (err) {
        console.error(`scheduled-volatility-background: ${symbol} failed: ${err.message}`);
      }
      await sleep(300);
    };
    for (const s of SYMBOLS) await fetchInto(s);
    const missed = SYMBOLS.filter((s) => !raw[s.key]);
    if (missed.length) {
      console.log(`scheduled-volatility-background: retrying ${missed.map((s) => s.symbol).join(", ")}`);
      await sleep(2000);
      for (const s of missed) await fetchInto(s);
    }

    const stillMissing = SYMBOLS.filter((s) => !raw[s.key]);
    const requiredMissing = stillMissing.filter((s) => s.required);
    if (requiredMissing.length) {
      throw new Error(`${requiredMissing.map((s) => s.symbol).join(", ")} failed twice, keeping the previous blob`);
    }

    const payload = buildVolatilityPayload(raw);
    if (stillMissing.length) payload.warnings = stillMissing.map((s) => `${s.symbol} unavailable this run`);

    const json = JSON.stringify(payload);
    console.log(
      `scheduled-volatility-background: ${payload.series.dates.length} sessions ${payload.series.dates[0]} to ${payload.asOfDate}, ` +
      `VIX ${payload.latest.implied}, realized ${payload.latest.realized}, ${Math.round(json.length / 1024)} KB`
    );

    await getVolatilityStore().setJSON(BLOB_KEY, payload);
    console.log("scheduled-volatility-background: wrote blob");

    return { statusCode: 200, body: JSON.stringify({ ok: true, sessions: payload.series.dates.length, asOfDate: payload.asOfDate }) };
  } catch (err) {
    console.error(`scheduled-volatility-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};

exports.buildVolatilityPayload = buildVolatilityPayload;
