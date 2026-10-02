// Scheduled Background Function (see [functions."scheduled-overnight-
// background"] in netlify.toml) behind /overnight-vs-intraday.html. Splits
// the total return of SPY, QQQ and IWM into its two halves — the
// "overnight" leg (prior close -> today's open) and the "intraday" leg
// (today's open -> today's close) — and tests whether the two earn
// different returns. Everything is computed here, once a day, and written
// to Netlify Blobs for overnight.js to serve.
//
// Only 3 Alpha Vantage calls (full-history TIME_SERIES_DAILY_ADJUSTED), so
// no heavy pacing is needed.
//
// Dividend/split handling: the raw open is rescaled by that day's
// adjusted-close/close factor, then compared with the PRIOR day's adjusted
// close. Without this, every ex-dividend morning would show up as a small
// artificial overnight loss (the price drops by the dividend at the open),
// biasing the overnight leg downward by roughly the dividend yield.

const { getOvernightStore, BLOB_KEY } = require("./overnight-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SYMBOLS = [
  { symbol: "SPY", label: "S&P 500 (SPY)" },
  { symbol: "QQQ", label: "Nasdaq-100 (QQQ)" },
  { symbol: "IWM", label: "Russell 2000 (IWM)" },
];
const TRADING_DAYS = 252;
// A single-leg move beyond this is a bad print (a stale open, a missing
// split adjustment), not a real session — no index ETF has gapped or run
// intraday 20% in its history.
const MAX_ABS_LOG_LEG = Math.log(1.2);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const round = (n, d) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

async function fetchJson(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error_message) {
    throw new Error(payload.Note || payload.Information || payload.error_message);
  }
  return payload;
}

async function fetchDailyOhlc(apiKey, symbol) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${apiKey}`
  );
  const series = payload["Time Series (Daily)"];
  if (!series) throw new Error(`TIME_SERIES_DAILY_ADJUSTED missing for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  return Object.entries(series)
    .map(([date, r]) => ({
      date,
      open: parseFloat(r["1. open"]),
      close: parseFloat(r["4. close"]),
      adjClose: parseFloat(r["5. adjusted close"]),
    }))
    .filter((r) => r.open > 0 && r.close > 0 && r.adjClose > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Per-day log returns for each leg. Day 0 has no prior close, so it is
// skipped. Returns the kept days plus a count of bad prints dropped.
function legReturns(rows) {
  const days = [];
  let dropped = 0;
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i];
    const adjOpen = cur.open * (cur.adjClose / cur.close);
    const ro = Math.log(adjOpen / rows[i - 1].adjClose);
    const ri = Math.log(cur.adjClose / adjOpen);
    if (!Number.isFinite(ro) || !Number.isFinite(ri) || Math.abs(ro) > MAX_ABS_LOG_LEG || Math.abs(ri) > MAX_ABS_LOG_LEG) {
      dropped++;
      continue;
    }
    days.push({ date: cur.date, ro, ri });
  }
  return { days, dropped };
}

function mean(a) {
  return a.reduce((s, v) => s + v, 0) / a.length;
}
function sd(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

// Daily returns have far more observations than any t-distribution
// tail-correction would matter for, so a normal tail is used for p-values.
function tTest(values) {
  const n = values.length;
  const m = mean(values);
  const t = m / (sd(values) / Math.sqrt(n));
  return { n, mean: m, t, p: 2 * (1 - normalCdf(Math.abs(t))) };
}

// Annualized compounded return (%) from a sum of daily log returns.
const annReturn = (sumLog, n) => (Math.exp((sumLog * TRADING_DAYS) / n) - 1) * 100;

function summarize(days) {
  const ro = days.map((d) => d.ro);
  const ri = days.map((d) => d.ri);
  const diff = days.map((d) => d.ro - d.ri);
  const n = days.length;
  const sumO = ro.reduce((s, v) => s + v, 0);
  const sumI = ri.reduce((s, v) => s + v, 0);
  const tOvernight = tTest(ro);
  const tIntraday = tTest(ri);
  const tDiff = tTest(diff);
  return {
    start: days[0].date,
    end: days[n - 1].date,
    n,
    annOvernight: round(annReturn(sumO, n), 2),
    annIntraday: round(annReturn(sumI, n), 2),
    annTotal: round(annReturn(sumO + sumI, n), 2),
    volOvernight: round(sd(ro) * Math.sqrt(TRADING_DAYS) * 100, 2),
    volIntraday: round(sd(ri) * Math.sqrt(TRADING_DAYS) * 100, 2),
    meanOvernightBp: round(tOvernight.mean * 1e4, 3),
    meanIntradayBp: round(tIntraday.mean * 1e4, 3),
    tOvernight: round(tOvernight.t, 2),
    tIntraday: round(tIntraday.t, 2),
    meanDiffBp: round(tDiff.mean * 1e4, 3),
    tDiff: round(tDiff.t, 2),
    pDiff: round(tDiff.p, 4),
    // Share of total log return earned overnight; unstable (and not
    // reported) when the total is near zero or the two legs have opposite sign.
    overnightShare: Math.abs(sumO + sumI) > 0.02 && sumO * (sumO + sumI) > 0 ? round(sumO / (sumO + sumI), 3) : null,
  };
}

function monthEndSample(days, valueFn) {
  const out = { dates: [], values: [] };
  for (let i = 0; i < days.length; i++) {
    const last = i === days.length - 1 || days[i].date.slice(0, 7) !== days[i + 1].date.slice(0, 7);
    if (!last) continue;
    out.dates.push(days[i].date);
    out.values.push(valueFn(i));
  }
  return out;
}

function analyze(days) {
  // Cumulative growth of 100, three ways: overnight only, intraday only,
  // and buy-and-hold (both legs).
  const cumO = [];
  const cumI = [];
  let so = 0;
  let si = 0;
  for (const d of days) {
    so += d.ro;
    si += d.ri;
    cumO.push(so);
    cumI.push(si);
  }
  const cum = monthEndSample(days, (i) => ({
    o: round(100 * Math.exp(cumO[i]), 2),
    i: round(100 * Math.exp(cumI[i]), 2),
    b: round(100 * Math.exp(cumO[i] + cumI[i]), 2),
  }));
  const cumulative = {
    dates: cum.dates,
    overnight: cum.values.map((v) => v.o),
    intraday: cum.values.map((v) => v.i),
    total: cum.values.map((v) => v.b),
  };

  const rolling = monthEndSample(days, (i) =>
    i < TRADING_DAYS
      ? null
      : {
          o: round((Math.exp(cumO[i] - cumO[i - TRADING_DAYS]) - 1) * 100, 2),
          i: round((Math.exp(cumI[i] - cumI[i - TRADING_DAYS]) - 1) * 100, 2),
        }
  );
  const firstRoll = rolling.values.findIndex((v) => v !== null);
  const rollingOut = {
    dates: rolling.dates.slice(firstRoll),
    overnight: rolling.values.slice(firstRoll).map((v) => v.o),
    intraday: rolling.values.slice(firstRoll).map((v) => v.i),
  };

  const byYear = new Map();
  for (const d of days) {
    const y = d.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, { o: 0, i: 0, n: 0 });
    const a = byYear.get(y);
    a.o += d.ro;
    a.i += d.ri;
    a.n++;
  }
  const lastYear = days[days.length - 1].date.slice(0, 4);
  const annual = [...byYear.entries()]
    // Skip stub years (the inception year's partial coverage); flag the
    // current year as year-to-date rather than hiding it.
    .filter(([, a]) => a.n >= 60)
    .map(([year, a]) => ({
      year,
      ytd: year === lastYear,
      overnight: round((Math.exp(a.o) - 1) * 100, 2),
      intraday: round((Math.exp(a.i) - 1) * 100, 2),
      days: a.n,
    }));

  const periods = [];
  const decades = [[2000, 2009], [2010, 2019], [2020, 2099]];
  for (const [a, b] of decades) {
    const slice = days.filter((d) => +d.date.slice(0, 4) >= a && +d.date.slice(0, 4) <= b);
    if (slice.length < 120) continue;
    const label = a === 2020 ? "2020s" : `${a}s`;
    periods.push({ label, ...summarize(slice) });
  }
  const mid = Math.floor(days.length / 2);
  const halves = [
    { label: "First half of sample", ...summarize(days.slice(0, mid)) },
    { label: "Second half of sample", ...summarize(days.slice(mid)) },
  ];

  return { full: summarize(days), periods, halves, cumulative, rolling: rollingOut, annual };
}

// Does a big overnight gap tend to fade or extend during the session?
// Quintile means of same-day intraday return, sorted by that day's
// overnight return; paired daily arrays (basis points) are included so the
// page can run its own Pearson/Spearman regression.
function gapFade(days) {
  const sorted = days.slice().sort((a, b) => a.ro - b.ro);
  const q = 5;
  const buckets = [];
  for (let k = 0; k < q; k++) {
    const slice = sorted.slice(Math.floor((k * sorted.length) / q), Math.floor(((k + 1) * sorted.length) / q));
    buckets.push({
      n: slice.length,
      avgOvernightBp: round(mean(slice.map((d) => d.ro)) * 1e4, 1),
      avgIntradayBp: round(mean(slice.map((d) => d.ri)) * 1e4, 1),
    });
  }
  return {
    buckets,
    overnightBp: days.map((d) => Math.round(d.ro * 1e4)),
    intradayBp: days.map((d) => Math.round(d.ri * 1e4)),
  };
}

async function buildPayload(apiKey) {
  const symbols = {};
  let latest = null;
  let first = true;
  for (const { symbol, label } of SYMBOLS) {
    if (!first) await sleep(900);
    first = false;
    const rows = await fetchDailyOhlc(apiKey, symbol);
    const { days, dropped } = legReturns(rows);
    if (days.length < TRADING_DAYS * 3) throw new Error(`${symbol}: only ${days.length} usable days`);
    symbols[symbol] = { label, droppedBadPrints: dropped, ...analyze(days) };
    if (symbol === "SPY") symbols[symbol].gapFade = gapFade(days);
    const end = days[days.length - 1].date;
    if (!latest || end > latest) latest = end;
  }
  return { generated_at_utc: new Date().toISOString(), asOfDate: latest, symbols };
}

exports.handler = async () => {
  console.log("scheduled-overnight-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");
    const payload = await buildPayload(apiKey);
    await getOvernightStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-overnight-background: wrote ${Object.keys(payload.symbols).length} symbols, as of ${payload.asOfDate}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, asOfDate: payload.asOfDate }) };
  } catch (err) {
    console.error(`scheduled-overnight-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
