// Odd-stats streak-scanner engine. Scans run-length "odd stat" conditions
// over the S&P 500 (Yahoo ^GSPC, 1927+), the 11 SPDR sector ETFs, SPY, and
// the 10 largest S&P constituents: directional / volatility / trend / RSI
// streaks, sector streaks and relative strength vs SPY, all-sector breadth,
// and every S&P x sector, sector x sector and S&P x megacap pair for daily
// divergence, co-movement, and 1-month performance convergence.
//
// Shared by scripts/oddstats-detect.js (CLI + `--dump`) and
// netlify/functions/scheduled-oddstats-background.js (daily blob refresh).
// No CLI here — see scripts/oddstats-detect.js for that.
// Adj Close is used when present. Rows may be in either date order.

"use strict";

const fs = require("fs");
const path = require("path");

// Forward-return horizons, in trading days (~1w, ~2w, ~1m, ~3m).
const HORIZONS = [5, 21, 63, 126, 252];
const HORIZON_LABEL = { 5: "5d", 21: "1m", 63: "3m", 126: "6m", 252: "12m" };
const hzLabel = (h) => HORIZON_LABEL[h] || `${h}d`;

// Minimum trading days between two analog triggers, so that one long run near
// the high (days 20, 21, 22 ...) counts as a single event, not twenty.
const ANALOG_GAP = 21;

// ---------------------------------------------------------------------------
// CSV loading
// ---------------------------------------------------------------------------

function loadCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const iDate = col("date");
  const iOpen = col("open");
  const iHigh = col("high");
  const iLow = col("low");
  const iClose = col("close");
  const iAdj = header.indexOf("adj close") !== -1 ? header.indexOf("adj close") : col("adjclose");

  if (iDate === -1 || iClose === -1) {
    throw new Error("CSV needs at least Date and Close columns");
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 2) continue;
    const close = parseFloat(p[iClose]);
    if (!isFinite(close)) continue;
    const adj = iAdj !== -1 ? parseFloat(p[iAdj]) : NaN;
    rows.push({
      date: p[iDate].trim(),
      open: iOpen !== -1 ? parseFloat(p[iOpen]) : close,
      high: iHigh !== -1 ? parseFloat(p[iHigh]) : close,
      low: iLow !== -1 ? parseFloat(p[iLow]) : close,
      close,
      // Use adjusted close for every return / streak calculation so splits
      // and dividends don't create phantom moves.
      px: isFinite(adj) && adj > 0 ? adj : close,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // If only a raw close is available, scale H/L/O by the adj/close ratio so
  // "within 1% of the high" style tests stay on one consistent price basis.
  for (const r of rows) {
    const k = r.px / r.close;
    r.high *= k;
    r.low *= k;
    r.open *= k;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Yahoo Finance loader (^GSPC, full daily history from 1927)
// ---------------------------------------------------------------------------
//
// Mirrors scheduled-seasonality-background.js: bare "Mozilla/5.0" UA (a full
// Chrome UA reliably 429s on multi-year ranges), ~20-year chunks, and a short
// retry backoff on the intermittent 429s. Yahoo gives adjusted close as its
// own array; pre-1962 bars carry no intraday high/low, which loadRows handles.

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YAHOO_UA = "Mozilla/5.0";
const YAHOO_BOUNDARIES = [-2208988800, -631152000, 0, 631152000, 1262304000];
// Sector ETFs (and SPY) only list from the late '90s, so a shorter boundary
// set keeps them to ~2 chunks instead of firing four mostly-empty requests.
const ETF_BOUNDARIES = [852076800, 1262304000];

// The 11 SPDR sector ETFs, same set as scheduled-sectors-background.js.
const SECTORS = [
  { ticker: "XLK", name: "Tech" },
  { ticker: "XLF", name: "Financials" },
  { ticker: "XLV", name: "Health Care" },
  { ticker: "XLE", name: "Energy" },
  { ticker: "XLI", name: "Industrials" },
  { ticker: "XLY", name: "Discretionary" },
  { ticker: "XLP", name: "Staples" },
  { ticker: "XLU", name: "Utilities" },
  { ticker: "XLB", name: "Materials" },
  { ticker: "XLRE", name: "Real Estate" },
  { ticker: "XLC", name: "Comm Services" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchYahooChunk(symbol, period1, period2, attempt = 1) {
  const url = `${YAHOO_BASE}${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": YAHOO_UA } });
  if (res.status === 429 && attempt < 4) {
    await sleep(attempt * 1500);
    return fetchYahooChunk(symbol, period1, period2, attempt + 1);
  }
  // Yahoo 400s a range that predates the symbol's listing (e.g. XLRE before
  // 2015); treat that as "no bars here" rather than a hard failure.
  if (res.status === 400 || res.status === 404) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${symbol} (${period1}-${period2})`);
  const payload = await res.json();
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) throw new Error("Yahoo chart response missing result");
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const adj =
    (result.indicators &&
      result.indicators.adjclose &&
      result.indicators.adjclose[0] &&
      result.indicators.adjclose[0].adjclose) ||
    [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close ? q.close[i] : null;
    if (close == null) continue;
    const px = adj[i] != null ? adj[i] : close;
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open && q.open[i] != null ? q.open[i] : close,
      high: q.high && q.high[i] != null ? q.high[i] : close,
      low: q.low && q.low[i] != null ? q.low[i] : close,
      close,
      px,
    });
  }
  return bars;
}

async function fetchYahoo(symbol = "^GSPC", boundaryList = YAHOO_BOUNDARIES) {
  const now = Math.floor(Date.now() / 1000);
  const bounds = [...boundaryList, now];
  const byDate = new Map();
  for (let i = 0; i < bounds.length - 1; i++) {
    if (i > 0) await sleep(400);
    for (const bar of await fetchYahooChunk(symbol, bounds[i], bounds[i + 1])) byDate.set(bar.date, bar);
  }
  const rows = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const r of rows) {
    const k = r.px / r.close;
    r.high *= k;
    r.low *= k;
    r.open *= k;
  }
  return rows;
}

// The ten largest S&P 500 companies by market cap. Hand-maintained — refresh
// the list (and order) as the leaderboard changes; the engine only needs the
// Yahoo ticker and a display name.
const MEGACAPS = [
  { ticker: "NVDA", name: "Nvidia" },
  { ticker: "AAPL", name: "Apple" },
  { ticker: "MSFT", name: "Microsoft" },
  { ticker: "GOOGL", name: "Alphabet" },
  { ticker: "AMZN", name: "Amazon" },
  { ticker: "META", name: "Meta" },
  { ticker: "AVGO", name: "Broadcom" },
  { ticker: "TSLA", name: "Tesla" },
  { ticker: "BRK-B", name: "Berkshire" },
  { ticker: "JPM", name: "JPMorgan" },
];

// A daily-rebalanced equal-weight basket of whichever megacaps have data that
// day, as a synthetic price series (date -> level). Used for the "S&P vs the
// top 10 together" relationship stats.
function buildMega10Basket(megacaps) {
  const retMaps = megacaps.map((m) => {
    const r = new Map();
    for (let i = 1; i < m.rows.length; i++) r.set(m.rows[i].date, m.rows[i].px / m.rows[i - 1].px - 1);
    return r;
  });
  const dates = [...new Set(megacaps.flatMap((m) => m.rows.map((r) => r.date)))].sort();
  const px = new Map();
  let level = 100;
  let started = false;
  for (const d of dates) {
    const rs = retMaps.map((rm) => rm.get(d)).filter((x) => x != null && isFinite(x));
    if (rs.length < 5) continue; // wait for a meaningful basket
    if (started) level *= 1 + rs.reduce((a, b) => a + b, 0) / rs.length;
    started = true;
    px.set(d, level);
  }
  return px;
}

// The full data set the engine runs over: the S&P 500 index plus (unless
// --no-sectors) the sector ETFs, SPY, and the ten largest S&P constituents,
// fetched sequentially so Yahoo's intermittent throttle stays quiet.
async function loadUniverse(file, opts = {}) {
  const spx = file ? loadCsv(path.resolve(file)) : await fetchYahoo();
  const universe = { primary: { label: "SPX", rows: spx }, sectors: [], megacaps: [] };
  if (opts.sectors === false) return universe;
  universe.spy = await fetchYahoo("SPY", ETF_BOUNDARIES);
  for (const s of SECTORS) {
    await sleep(300);
    const rows = await fetchYahoo(s.ticker, ETF_BOUNDARIES);
    if (rows.length > 260) universe.sectors.push({ ...s, rows });
  }
  for (const m of MEGACAPS) {
    await sleep(300);
    const rows = await fetchYahoo(m.ticker, ETF_BOUNDARIES);
    if (rows.length > 260) universe.megacaps.push({ ...m, rows });
  }
  if (universe.megacaps.length >= 5) {
    universe.mega10 = buildMega10Basket(universe.megacaps);
  }
  return universe;
}

// Back-compat: a bare row series (SPX only).
async function loadRows(file) {
  return file ? loadCsv(path.resolve(file)) : fetchYahoo();
}

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------

const pctChange = (rows) => rows.map((r, i) => (i === 0 ? 0 : r.px / rows[i - 1].px - 1));

function sma(vals, n) {
  const out = new Array(vals.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Wilder RSI.
function rsi(px, n = 14) {
  const out = new Array(px.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < px.length; i++) {
    const ch = px[i] - px[i - 1];
    const gain = Math.max(ch, 0);
    const loss = Math.max(-ch, 0);
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i === n) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

// Rolling max of `field` over the trailing `n` bars (inclusive).
function rollingMax(rows, field, n) {
  const out = new Array(rows.length).fill(NaN);
  for (let i = 0; i < rows.length; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, rows[j][field]);
    out[i] = m;
  }
  return out;
}

// Running all-time high of the close up to and including each bar.
function runningHigh(rows) {
  const out = new Array(rows.length).fill(NaN);
  let m = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    m = Math.max(m, rows[i].px);
    out[i] = m;
  }
  return out;
}

const median = (arr) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const signedPct = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

// Wilder ATR as a fraction of price (average true range / close).
function atrPct(rows, n = 14) {
  const out = new Array(rows.length).fill(NaN);
  let a = 0;
  for (let i = 1; i < rows.length; i++) {
    const tr = Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].px),
      Math.abs(rows[i].low - rows[i - 1].px)
    );
    a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a / rows[i].px;
  }
  return out;
}

// Daily indices that fall on the last trading day of each week / month.
function periodEndIdx(rows, unit) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = new Date(rows[i].date + "T00:00:00Z");
    const nxt = i + 1 < rows.length ? new Date(rows[i + 1].date + "T00:00:00Z") : null;
    let boundary = !nxt;
    if (nxt) {
      boundary =
        unit === "M"
          ? nxt.getUTCMonth() !== cur.getUTCMonth() || nxt.getUTCFullYear() !== cur.getUTCFullYear()
          : nxt.getUTCDay() <= cur.getUTCDay() || nxt - cur > 4 * 864e5;
    }
    if (boundary) out.push(i);
  }
  return out;
}

// Turn a per-period predicate into the {i (daily index), on} points the streak
// engine consumes. `onFn(thisClose, prevClose)` decides each period.
function periodPoints(rows, unit, onFn) {
  const ends = periodEndIdx(rows, unit);
  return ends.map((i, k) => ({
    i,
    on: k > 0 ? onFn(rows[i].px, rows[ends[k - 1]].px) : false,
  }));
}

// ---------------------------------------------------------------------------
// Predicate library
// ---------------------------------------------------------------------------
//
// Each predicate is a daily boolean array `flag[]` (true on every bar where the
// raw condition holds) OR, for weekly/monthly stats, a `points` list from
// periodPoints(). The streak engine does the "for N straight periods" and
// analog work generically, so adding an odd-stat is usually one entry here.
//
// `hasOHLC` guards anything that needs a real intraday range: Yahoo's ^GSPC
// bars before ~1962 carry only a close (high == low == open == close), which
// would otherwise make every range/gap/inside-day streak run forever.

function buildPredicates(rows) {
  const ch = pctChange(rows);
  const px = rows.map((r) => r.px);
  const ath = runningHigh(rows);
  const hi52 = rollingMax(rows, "high", 252);
  const sma20 = sma(px, 20);
  const sma50 = sma(px, 50);
  const sma100 = sma(px, 100);
  const sma200 = sma(px, 200);
  const r = rsi(px, 14);
  const atr = atrPct(rows, 14);
  const isAth = rows.map((_, i) => px[i] >= ath[i] - 1e-9);
  const hasOHLC = rows.map((row) => row.high > row.low + 1e-9);
  const range = rows.map((row, i) => (i === 0 ? 0 : (row.high - row.low) / rows[i - 1].px));

  const near = (frac) => rows.map((_, i) => isFinite(hi52[i]) && px[i] >= hi52[i] * (1 - frac));
  const quiet = rows.map((_, i) => Math.abs(ch[i]) < 0.01);
  const up = ch.map((c) => c > 0);
  const down = ch.map((c) => c < 0);
  const aboveMA = (ma) => rows.map((_, i) => isFinite(ma[i]) && px[i] > ma[i]);
  const belowMA = (ma) => rows.map((_, i) => isFinite(ma[i]) && px[i] < ma[i]);

  return [
    // --- direction streaks ---
    { id: "up-streak", floor: 5, flag: up, phrase: (n) => `has closed higher ${n} days in a row` },
    { id: "down-streak", floor: 4, flag: down, phrase: (n) => `has closed lower ${n} days in a row` },
    {
      id: "higher-highs",
      floor: 5,
      flag: rows.map((row, i) => i > 0 && hasOHLC[i] && hasOHLC[i - 1] && row.high > rows[i - 1].high),
      phrase: (n) => `has printed a higher intraday high ${n} days in a row`,
    },
    {
      id: "lower-lows",
      floor: 5,
      flag: rows.map((row, i) => i > 0 && hasOHLC[i] && hasOHLC[i - 1] && row.low < rows[i - 1].low),
      phrase: (n) => `has printed a lower intraday low ${n} days in a row`,
    },
    {
      id: "close-above-open",
      floor: 5,
      flag: rows.map((row, i) => hasOHLC[i] && row.px > row.open),
      phrase: (n) => `has closed above its open ${n} sessions in a row`,
    },
    {
      id: "close-below-open",
      floor: 4,
      flag: rows.map((row, i) => hasOHLC[i] && row.px < row.open),
      phrase: (n) => `has closed below its open ${n} sessions in a row`,
    },
    {
      id: "above-prior-high",
      floor: 3,
      flag: rows.map((row, i) => i > 0 && hasOHLC[i - 1] && row.px > rows[i - 1].high),
      phrase: (n) => `has closed above the prior day's high ${n} days running`,
    },

    // --- new-high / drought streaks ---
    {
      id: "ath-streak",
      floor: 3,
      flag: isAth,
      phrase: (n) => `has closed at a record high ${n} days in a row`,
    },
    {
      id: "near-1pct-high",
      floor: 6,
      flag: near(0.01),
      phrase: (n) => `has closed within 1% of its 52-week high for ${n} straight days`,
    },
    {
      id: "near-2pct-high",
      floor: 8,
      flag: near(0.02),
      phrase: (n) => `has closed within 2% of its 52-week high for ${n} straight days`,
    },
    {
      id: "ath-drought-after-run",
      floor: 6,
      flag: rows.map((_, i) => {
        if (isAth[i]) return false;
        let recentAth = 0;
        for (let j = Math.max(0, i - 40); j < i; j++) if (isAth[j]) recentAth++;
        return recentAth >= 3;
      }),
      phrase: (n) =>
        `has gone ${n} days without a new all-time high after setting several in the prior weeks`,
    },

    // --- volatility / range streaks ---
    {
      id: "quiet-tape",
      floor: 5,
      flag: quiet,
      phrase: (n) => `has gone ${n} straight days without a +/- 1% close`,
    },
    {
      id: "no-down-1pct",
      floor: 8,
      flag: ch.map((c) => c > -0.01),
      phrase: (n) => `has gone ${n} sessions without a 1% down day`,
    },
    {
      id: "flat-close",
      floor: 4,
      flag: ch.map((c) => Math.abs(c) < 0.0025),
      phrase: (n) => `has moved less than 0.25% on the close ${n} days in a row`,
    },
    {
      id: "tight-range",
      floor: 5,
      flag: rows.map((_, i) => hasOHLC[i] && range[i] < 0.006),
      phrase: (n) => `has held a sub-0.6% intraday range ${n} days in a row`,
    },
    {
      id: "wide-range",
      floor: 3,
      flag: rows.map((_, i) => hasOHLC[i] && range[i] > 0.02),
      phrase: (n) => `has swung more than 2% intraday ${n} days in a row`,
    },
    {
      id: "atr-compressed",
      floor: 6,
      flag: atr.map((v) => isFinite(v) && v < 0.008),
      phrase: (n) => `has had 14-day ATR below 0.8% for ${n} straight sessions`,
    },
    {
      id: "gap-up",
      floor: 3,
      flag: rows.map((row, i) => i > 0 && hasOHLC[i] && row.open > rows[i - 1].px),
      phrase: (n) => `has opened above the prior close ${n} days in a row`,
    },
    {
      id: "gap-down",
      floor: 3,
      flag: rows.map((row, i) => i > 0 && hasOHLC[i] && row.open < rows[i - 1].px),
      phrase: (n) => `has opened below the prior close ${n} days in a row`,
    },
    {
      id: "inside-days",
      floor: 3,
      flag: rows.map((row, i) =>
        i > 0 && hasOHLC[i] && hasOHLC[i - 1] && row.high <= rows[i - 1].high && row.low >= rows[i - 1].low
      ),
      phrase: (n) => `has printed an inside day ${n} sessions in a row`,
    },

    // --- trend / moving-average streaks ---
    { id: "above-20dma", floor: 10, flag: aboveMA(sma20), phrase: (n) => `has closed above its 20-day average ${n} sessions running` },
    { id: "above-50dma", floor: 15, flag: aboveMA(sma50), phrase: (n) => `has closed above its 50-day average ${n} sessions running` },
    { id: "above-200dma", floor: 25, flag: aboveMA(sma200), phrase: (n) => `has held above its 200-day average for ${n} straight sessions` },
    { id: "below-50dma", floor: 15, flag: belowMA(sma50), phrase: (n) => `has closed below its 50-day average ${n} sessions running` },
    { id: "below-200dma", floor: 10, flag: belowMA(sma200), phrase: (n) => `has stayed below its 200-day average for ${n} straight sessions` },
    {
      id: "stacked-mas",
      floor: 10,
      flag: rows.map((_, i) =>
        isFinite(sma200[i]) && px[i] > sma50[i] && sma50[i] > sma100[i] && sma100[i] > sma200[i]
      ),
      phrase: (n) => `has held a fully stacked 50>100>200 moving-average alignment ${n} days running`,
    },
    {
      id: "overbought-extended",
      floor: 5,
      flag: rows.map((_, i) => isFinite(sma200[i]) && px[i] > sma200[i] * 1.1),
      phrase: (n) => `has closed more than 10% above its 200-day average ${n} days in a row`,
    },
    {
      id: "oversold-extended",
      floor: 5,
      flag: rows.map((_, i) => isFinite(sma200[i]) && px[i] < sma200[i] * 0.95),
      phrase: (n) => `has closed more than 5% below its 200-day average ${n} days in a row`,
    },
    {
      id: "positive-momentum",
      floor: 20,
      flag: rows.map((_, i) => i >= 20 && px[i] > px[i - 20]),
      phrase: (n) => `has been above its level of a month earlier for ${n} straight sessions`,
    },

    // --- RSI streaks ---
    { id: "rsi-hot", floor: 3, flag: r.map((v) => isFinite(v) && v > 70), phrase: (n) => `has had a 14-day RSI above 70 for ${n} straight days` },
    { id: "rsi-cold", floor: 3, flag: r.map((v) => isFinite(v) && v < 30), phrase: (n) => `has had a 14-day RSI below 30 for ${n} straight days` },

    // --- combos ---
    {
      id: "quiet-and-ath",
      floor: 4,
      flag: rows.map((_, i) => Math.abs(ch[i]) < 0.01 && isAth[i]),
      phrase: (n) =>
        `has gone ${n} straight days without a +/- 1% close while still closing at a record high`,
    },
    {
      id: "quiet-and-rising",
      floor: 5,
      flag: rows.map((_, i) => Math.abs(ch[i]) < 0.01 && isFinite(sma20[i]) && px[i] > sma20[i]),
      phrase: (n) => `has gone ${n} days without a +/- 1% close while holding above its 20-day average`,
    },
    {
      id: "down-but-near-high",
      floor: 4,
      flag: rows.map((_, i) => ch[i] < 0 && isFinite(hi52[i]) && px[i] >= hi52[i] * 0.97),
      phrase: (n) => `has closed lower ${n} days in a row yet is still within 3% of its high`,
    },
    {
      id: "up-but-below-50dma",
      floor: 4,
      flag: rows.map((_, i) => ch[i] > 0 && isFinite(sma50[i]) && px[i] < sma50[i]),
      phrase: (n) => `has risen ${n} days in a row but is still below its 50-day average`,
    },

    // --- weekly streaks ---
    {
      id: "weekly-up",
      series: "weekly",
      floor: 4,
      points: periodPoints(rows, "W", (c, p) => c > p),
      phrase: (n) => `has closed higher ${n} weeks in a row`,
    },
    {
      id: "weekly-down",
      series: "weekly",
      floor: 3,
      points: periodPoints(rows, "W", (c, p) => c < p),
      phrase: (n) => `has closed lower ${n} weeks in a row`,
    },

    // --- monthly streaks ---
    {
      id: "monthly-up",
      series: "monthly",
      floor: 4,
      points: periodPoints(rows, "M", (c, p) => c > p),
      phrase: (n) => `has closed higher ${n} months in a row`,
    },
    {
      id: "monthly-down",
      series: "monthly",
      floor: 3,
      points: periodPoints(rows, "M", (c, p) => c < p),
      phrase: (n) => `has closed lower ${n} months in a row`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Per-instrument streak predicates — the same streak vocabulary applied to
// each SPDR sector ETF and each of the ten largest S&P constituents: up/down
// streaks, 52-week highs/lows, RSI extremes, and relative-strength-vs-SPY
// streaks. Forward returns for each stat are measured on that instrument's
// own series. (Index-wide "all sectors" breadth lives in buildCrossSector.)
// ---------------------------------------------------------------------------

function buildInstrumentPredicates(instruments, spyPx, group, relGroup) {
  const out = [];
  for (const inst of instruments) {
    const rows = inst.rows;
    const t = inst.ticker;
    const label = `${inst.name} (${t})`;
    const px = rows.map((r) => r.px);
    const ch = pctChange(rows);
    const r = rsi(px, 14);
    const hi = rollingMax(rows, "px", 252);
    const lo = rows.map((_, i) => {
      let m = Infinity;
      for (let j = Math.max(0, i - 251); j <= i; j++) m = Math.min(m, rows[j].px);
      return m;
    });
    // Daily return minus SPY's return on the same date; NaN when unaligned.
    const rel = rows.map((row, i) => {
      if (i === 0) return NaN;
      const s0 = spyPx.get(rows[i - 1].date);
      const s1 = spyPx.get(row.date);
      return s0 && s1 ? ch[i] - (s1 / s0 - 1) : NaN;
    });

    out.push(
      { id: `${t}-up-streak`, rows, label, floor: 5, group, flag: ch.map((c) => c > 0), phrase: (n) => `has closed higher ${n} days in a row` },
      { id: `${t}-down-streak`, rows, label, floor: 5, group, flag: ch.map((c) => c < 0), phrase: (n) => `has closed lower ${n} days in a row` },
      { id: `${t}-52w-high`, rows, label, floor: 3, group, flag: rows.map((_, i) => i >= 60 && px[i] >= hi[i] - 1e-9), phrase: (n) => `has closed at a 52-week high ${n} days running` },
      { id: `${t}-52w-low`, rows, label, floor: 3, group, flag: rows.map((_, i) => i >= 60 && px[i] <= lo[i] + 1e-9), phrase: (n) => `has closed at a 52-week low ${n} days running` },
      { id: `${t}-rsi-hot`, rows, label, floor: 4, group, flag: r.map((v) => isFinite(v) && v > 70), phrase: (n) => `has held a 14-day RSI above 70 for ${n} straight days` },
      { id: `${t}-rsi-cold`, rows, label, floor: 4, group, flag: r.map((v) => isFinite(v) && v < 30), phrase: (n) => `has held a 14-day RSI below 30 for ${n} straight days` },
      { id: `${t}-beat-spy`, rows, label, floor: 6, group: relGroup, flag: rel.map((v) => isFinite(v) && v > 0), phrase: (n) => `has outpaced the S&P 500 ${n} sessions in a row` },
      { id: `${t}-lag-spy`, rows, label, floor: 6, group: relGroup, flag: rel.map((v) => isFinite(v) && v < 0), phrase: (n) => `has lagged the S&P 500 ${n} sessions in a row` }
    );
  }
  return out;
}

function buildSectorPredicates(universe) {
  const spyPx = new Map((universe.spy || []).map((r) => [r.date, r.px]));
  return buildInstrumentPredicates(universe.sectors, spyPx, "sector", "sector-rel");
}

function buildMegacapPredicates(universe) {
  if (!universe.megacaps || !universe.megacaps.length) return [];
  const spyPx = new Map((universe.spy || []).map((r) => [r.date, r.px]));
  return buildInstrumentPredicates(universe.megacaps, spyPx, "megacap", "megacap");
}

function buildCrossSectorPredicates(universe) {
  if (universe.sectors.length < 8) return [];
  const spx = universe.primary.rows;
  // Each sector's daily return keyed by date, so we can ask "were all sectors
  // green?" on every S&P trading day regardless of minor calendar mismatches.
  const secRet = universe.sectors.map((sec) => {
    const m = new Map();
    for (let i = 1; i < sec.rows.length; i++) {
      m.set(sec.rows[i].date, sec.rows[i].px / sec.rows[i - 1].px - 1);
    }
    return m;
  });
  const readyFrom = spx.findIndex((row) => secRet.every((m) => m.has(row.date)));
  const allGreen = spx.map((row, i) => i >= readyFrom && readyFrom !== -1 && secRet.every((m) => (m.get(row.date) ?? -1) > 0));
  const allRed = spx.map((row, i) => i >= readyFrom && readyFrom !== -1 && secRet.every((m) => (m.get(row.date) ?? 1) < 0));

  return [
    { id: "all-sectors-up", rows: spx, label: "All 11 sectors", floor: 3, group: "breadth", flag: allGreen, phrase: (n) => `have closed green together ${n} days in a row` },
    { id: "all-sectors-down", rows: spx, label: "All 11 sectors", floor: 3, group: "breadth", flag: allRed, phrase: (n) => `have closed red together ${n} days in a row` },
  ];
}

// Cross-series pair streaks over every S&P × sector and sector × sector
// combination: daily divergence (opposite closes), daily co-movement (same
// close), and performance convergence (the trailing 1-month return gap
// narrowing). Forward returns are measured on the S&P throughout — the
// question is what each pattern tends to precede for the market.
function buildRelationshipPredicates(universe) {
  if (universe.sectors.length < 8) return [];
  const spx = universe.primary.rows;
  const N = spx.length;

  // Align every series onto the S&P's trading-day axis: price on day i, the
  // daily return, and the trailing 21-session return. null before inception.
  function alignSeries(rowsOrMap) {
    const pxOn = new Array(N).fill(null);
    if (Array.isArray(rowsOrMap)) {
      for (let i = 0; i < N; i++) pxOn[i] = rowsOrMap[i].px;
    } else {
      for (let i = 0; i < N; i++) if (rowsOrMap.has(spx[i].date)) pxOn[i] = rowsOrMap.get(spx[i].date);
    }
    const ret = new Array(N).fill(NaN);
    const r21 = new Array(N).fill(NaN);
    for (let i = 1; i < N; i++) if (pxOn[i] != null && pxOn[i - 1] != null) ret[i] = pxOn[i] / pxOn[i - 1] - 1;
    for (let i = 21; i < N; i++) if (pxOn[i] != null && pxOn[i - 21] != null) r21[i] = pxOn[i] / pxOn[i - 21] - 1;
    return { ret, r21 };
  }

  const mapOf = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.date, r.px);
    return m;
  };

  const series = { SPX: alignSeries(spx) };
  for (const sec of universe.sectors) series[sec.ticker] = alignSeries(mapOf(sec.rows));
  for (const mc of universe.megacaps || []) series[mc.ticker] = alignSeries(mapOf(mc.rows));
  if (universe.mega10) series.MEGA10 = alignSeries(universe.mega10);

  const out = [];
  const pairPreds = (A, B, aName, bName) => {
    const sa = series[A];
    const sb = series[B];
    const label = `${A} · ${B}`;
    const both = (i) =>
      Number.isFinite(sa.ret[i]) && Number.isFinite(sb.ret[i]) && sa.ret[i] !== 0 && sb.ret[i] !== 0;
    return [
      {
        id: `${A}-${B}-diverge`,
        rows: spx,
        label,
        floor: 3,
        group: "diverge",
        flag: spx.map((_, i) => both(i) && Math.sign(sa.ret[i]) !== Math.sign(sb.ret[i])),
        phrase: (n) => `${aName} and ${bName} have closed opposite ways ${n} days in a row`,
      },
      {
        id: `${A}-${B}-together`,
        rows: spx,
        label,
        floor: 5,
        group: "together",
        flag: spx.map((_, i) => both(i) && Math.sign(sa.ret[i]) === Math.sign(sb.ret[i])),
        phrase: (n) => `${aName} and ${bName} have closed the same way ${n} days in a row`,
      },
      {
        id: `${A}-${B}-converge`,
        rows: spx,
        label,
        floor: 5,
        group: "converge",
        flag: spx.map((_, i) => {
          const s0 = Math.abs(sa.r21[i - 1] - sb.r21[i - 1]);
          const s1 = Math.abs(sa.r21[i] - sb.r21[i]);
          return Number.isFinite(s0) && Number.isFinite(s1) && s1 < s0;
        }),
        phrase: (n) =>
          `the 1-month performance gap between ${aName} and ${bName} has narrowed ${n} days in a row`,
      },
    ];
  };

  // S&P × sector and sector × sector.
  const secKeys = ["SPX", ...universe.sectors.map((s) => s.ticker)];
  for (let a = 0; a < secKeys.length; a++) {
    for (let b = a + 1; b < secKeys.length; b++) {
      out.push(...pairPreds(secKeys[a], secKeys[b], secKeys[a], secKeys[b]));
    }
  }

  // S&P × each of the ten largest constituents, and × the basket of all ten.
  for (const mc of universe.megacaps || []) {
    out.push(...pairPreds("SPX", mc.ticker, "the S&P 500", mc.name));
  }
  if (universe.mega10) {
    out.push(...pairPreds("SPX", "MEGA10", "the S&P 500", "its ten largest companies"));
  }

  return out;
}

function buildAll(universe) {
  const spx = universe.primary.rows;
  const idx = buildPredicates(spx).map((p) => ({ ...p, rows: spx, label: "SPX", group: "index" }));
  return [
    ...idx,
    ...buildSectorPredicates(universe),
    ...buildMegacapPredicates(universe),
    ...buildCrossSectorPredicates(universe),
    ...buildRelationshipPredicates(universe),
  ];
}

// ---------------------------------------------------------------------------
// Streak engine: current state + historical analogs + forward returns
// ---------------------------------------------------------------------------

// Points the streak engine walks: {i: daily bar index, on: condition holds}.
// Daily predicates map one-to-one onto bars; weekly/monthly ones carry only
// their period-end bars but still measure forward returns on the daily series.
function predicatePoints(rows, pred) {
  return pred.points || pred.flag.map((on, i) => ({ i, on }));
}

function trailingRun(pts) {
  let n = 0;
  for (let k = pts.length - 1; k >= 0 && pts[k].on; k--) n++;
  return n;
}

function forwardStats(rows, entryIdx) {
  const p0 = rows[entryIdx].px;
  const res = { horizons: {} };
  let anyDrawdown3 = false;
  for (const h of HORIZONS) {
    const end = entryIdx + h;
    if (end >= rows.length) {
      res.horizons[h] = null;
      continue;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = entryIdx + 1; k <= end; k++) {
      lo = Math.min(lo, rows[k].px);
      hi = Math.max(hi, rows[k].px);
    }
    const ret = rows[end].px / p0 - 1;
    const maxDD = lo / p0 - 1;
    const maxUp = hi / p0 - 1;
    if (maxDD <= -0.03) anyDrawdown3 = true;
    res.horizons[h] = { ret, maxDD, maxUp };
  }
  res.anyDrawdown3 = anyDrawdown3;
  return res;
}

// Analyse a condition at a given run length. With no `analyzeAt`, uses the
// live current run; the dashboard passes max(currentRun, floor) so a condition
// that hasn't reached its floor yet still shows "the last N times it did".
function analyzePredicate(pred, { analyzeAt } = {}) {
  const rows = pred.rows;
  const pts = predicatePoints(rows, pred);
  const lastDailyIdx = rows.length - 1;
  const currentRun = trailingRun(pts);
  const runLength = analyzeAt || currentRun;
  if (runLength < 1) return null;

  // One long run near the high (days 20, 21, 22 ...) is one event, not twenty.
  // Weekly/monthly triggers are already spaced out, so widen the guard there.
  const gap = pred.series ? 126 : ANALOG_GAP;

  // Historical analogs: the point in each maximal true-run at which the run
  // first reaches `runLength`, i.e. prior times the streak got this deep.
  const analogs = [];
  let runStart = -1;
  for (let k = 0; k < pts.length; k++) {
    if (pts[k].on) {
      if (runStart === -1) runStart = k;
      const runLen = k - runStart + 1;
      if (runLen === runLength && pts[k].i !== lastDailyIdx) {
        if (!analogs.length || pts[k].i - analogs[analogs.length - 1].idx >= gap) {
          analogs.push({ idx: pts[k].i, date: rows[pts[k].i].date, fwd: forwardStats(rows, pts[k].i) });
        }
      }
    } else {
      runStart = -1;
    }
  }

  // Summarise each horizon across analogs that have a full forward window.
  const summary = {};
  for (const h of HORIZONS) {
    const rr = analogs.map((a) => a.fwd.horizons[h]).filter(Boolean);
    if (!rr.length) {
      summary[h] = null;
      continue;
    }
    const rets = rr.map((x) => x.ret);
    summary[h] = {
      n: rr.length,
      medianRet: median(rets),
      meanRet: rets.reduce((s, x) => s + x, 0) / rets.length,
      pctPositive: rets.filter((x) => x > 0).length / rets.length,
      worstRet: Math.min(...rets),
      bestRet: Math.max(...rets),
      medianMaxDD: median(rr.map((x) => x.maxDD)),
      pctWith3pctDrawdown: rr.filter((x) => x.maxDD <= -0.03).length / rr.length,
    };
  }

  // Every completed run of this condition (the still-open current one excluded),
  // with the daily index of its last bar so we can date the record.
  const runs = [];
  let cur = 0;
  for (let k = 0; k < pts.length; k++) {
    if (pts[k].on) cur++;
    else {
      if (cur) runs.push({ len: cur, endIdx: pts[k - 1].i });
      cur = 0;
    }
  }
  // Rarity is measured only against runs that also cleared the floor — i.e.
  // "among the times this streak got long enough to be a stat, how far into
  // the tail is today's run". A run sitting right at the floor scores ~0.
  const notable = runs.filter((r) => r.len >= pred.floor);
  const deeper = notable.filter((r) => r.len >= runLength).length;
  const rarity = notable.length ? 1 - deeper / notable.length : 0;
  const record = runs.reduce((m, r) => (r.len > m.len ? r : m), { len: 0, endIdx: -1 });
  const active = currentRun >= pred.floor;

  const last = analogs.length ? analogs[analogs.length - 1] : null;
  return {
    id: pred.id,
    group: pred.group,
    label: pred.label || "SPX",
    floor: pred.floor,
    currentRun,
    runLength,
    active,
    toGo: Math.max(0, pred.floor - currentRun),
    text: `${pred.label || "SPX"} ${pred.phrase(active ? currentRun : pred.floor)}.`,
    analogCount: analogs.length,
    lastOccurrence: last ? last.date : null,
    rarity,
    histMaxRun: Math.max(record.len, currentRun),
    histMaxDate: currentRun >= record.len || record.endIdx < 0 ? null : rows[record.endIdx].date,
    atRecord: currentRun >= record.len,
    summary,
    analogs: analogs.map((a) => ({ date: a.date, fwd: a.fwd })),
  };
}

function detect(universe, opts = {}) {
  const minAnalogs = opts.minAnalogs ?? 5;
  const preds = buildAll(universe);
  const hits = [];
  for (const pred of preds) {
    const res = analyzePredicate(pred);
    if (res && res.active && res.analogCount >= minAnalogs) hits.push(res);
  }
  // Rarest first; break ties toward more analogs (more trustworthy).
  hits.sort((a, b) => b.rarity - a.rarity || b.analogCount - a.analogCount);
  return { scanned: preds.length, hits };
}

// Full board: every tracked condition, whether or not it's currently on a
// streak. Active ones are analysed at their live run length; dormant ones at
// their floor, so each still shows "the last N times this did happen and how
// the next year went". Nothing is hidden behind a trigger.
function snapshot(universe) {
  const preds = buildAll(universe);
  const conditions = [];
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  for (const pred of preds) {
    const currentRun = trailingRun(predicatePoints(pred.rows, pred));
    const a = analyzePredicate(pred, { analyzeAt: Math.max(currentRun, pred.floor) });
    if (!a) continue;

    // For a live streak, the same analysis re-run at every length it has passed
    // through (floor .. currentRun), so the dashboard can show how the outlook
    // shifted as the streak deepened.
    let rungs = null;
    if (a.active) {
      rungs = [];
      for (let L = pred.floor; L <= currentRun; L++) {
        const ra = L === a.runLength ? a : analyzePredicate(pred, { analyzeAt: L });
        if (!ra) continue;
        rungs.push({
          len: L,
          n: ra.analogCount,
          rarity: r4(ra.rarity),
          med: HORIZONS.map((h) => (ra.summary[h] ? r4(ra.summary[h].medianRet) : null)),
          up: HORIZONS.map((h) => (ra.summary[h] ? r4(ra.summary[h].pctPositive) : null)),
        });
      }
    }

    conditions.push({
      rungs,
      id: a.id,
      group: a.group,
      label: a.label,
      unit: pred.series || "day",
      floor: a.floor,
      currentRun: a.currentRun,
      runLength: a.runLength,
      active: a.active,
      toGo: a.toGo,
      histMaxRun: a.histMaxRun,
      histMaxDate: a.histMaxDate,
      atRecord: a.active && a.atRecord,
      phrase: pred.phrase(a.runLength),
      rarity: a.rarity,
      analogCount: a.analogCount,
      lastOccurrence: a.lastOccurrence,
      summary: a.summary,
      // Just the +21d return of each analog, for the dashboard's swarm plot.
      dist: a.analogs
        .map((x) => x.fwd.horizons[21] && Math.round(x.fwd.horizons[21].ret * 1e4) / 1e4)
        .filter((v) => v != null),
    });
  }
  // Active first (rarest on top), then dormant by how close they are to the floor.
  conditions.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      (a.active ? b.rarity - a.rarity : b.currentRun / b.floor - a.currentRun / a.floor)
  );
  const spx = universe.primary.rows;
  return {
    asOf: spx[spx.length - 1].date,
    scanned: preds.length,
    live: conditions.filter((c) => c.active).length,
    sectorCount: universe.sectors.length,
    horizons: HORIZONS,
    horizonLabels: HORIZONS.map(hzLabel),
    conditions,
  };
}

module.exports = {
  loadCsv,
  loadRows,
  loadUniverse,
  fetchYahoo,
  buildPredicates,
  buildAll,
  detect,
  analyzePredicate,
  snapshot,
  HORIZONS,
  hzLabel,
};
