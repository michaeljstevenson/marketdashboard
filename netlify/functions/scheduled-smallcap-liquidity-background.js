// Scheduled Background Function (see [functions."scheduled-smallcap-
// liquidity-background"] in netlify.toml) for the Small-Cap Liquidity &
// Volume Trends page. Measures trading depth and transaction-cost proxies
// for every Russell 2000 member, by size fifth and sector, against the
// S&P 500 members, and tests whether the Russell 2000 / S&P 500 liquidity
// gap widens in weeks when small caps lag.
//
// Membership comes from TradingView's public screener (index group
// TVC:RUT), because iShares, BlackRock, Vanguard and FTSE Russell all
// refuse scripted downloads of their holdings files. Prices are ~13 months
// of daily OHLCV from Yahoo for ~1,930 members, the S&P 500 list in
// breadth-constituents.js, SPY and IWM: about 2,450 requests.
//
// Measured locally (2026-10-07) the sweep takes about 3.5 minutes with 4
// workers. Each run still stops fetching at RUN_BUDGET_MS and checkpoints
// per-stock summaries, so a slow or rate-limited Yahoo day finishes on the
// backup Saturday firing instead of being killed at Netlify's 15-minute
// limit. A firing that finds this week's sweep already complete exits at
// once.

const { getSmallcapLiquidityStore, LATEST_KEY, CHECKPOINT_KEY } = require("./smallcap-liquidity-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { TICKER_EXCHANGE } = require("./tv-exchange-map");
const { fetchDailyBars, sleep } = require("./yahoo-client");

const SCANNER_URL = "https://scanner.tradingview.com/america/scan";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
// TradingView's index group also lists OTC shells of bankrupt members (e.g.
// OTC:TSEOQ at $0.01) that the index itself has dropped.
const KEEP_EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "NYSE ARCA", "ARCA"]);

const WORKERS = 4;
const WORKER_GAP_MS = 200;
const RUN_BUDGET_MS = 10 * 60 * 1000;
const CHECKPOINT_EVERY = 400;
// Saturday's firings are 15 minutes apart. A checkpoint older than this is
// last week's, so the run starts a fresh sweep.
const CHECKPOINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_RUNS_PER_SWEEP = 3;
const MAX_ATTEMPTS = 2;

const LONG = 63;
const SHORT = 21;
const AMIHUD_SCALE = 1e6;
// A member whose latest Yahoo bar is older than this many sessions has
// stopped trading (halted, delisted or acquired) and is left out.
const STALE_SESSIONS = 5;
const MIN_VALUES = 5;
const MIN_COVERAGE = 0.8;
const MIN_WEEK_DAYS = 3;
const MIN_MONTH_DAYS = 10;
const NW_LAG = 4;
const MIN_OBS_FOR_T = 12;

const CS_K = 3 - 2 * Math.SQRT2;

function sig(v, d = 4) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toPrecision(d));
}
function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mean(arr) {
  const a = arr.filter(Number.isFinite);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

function etParts(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

// Friday of the date's Monday-to-Friday week, so a weekend date maps to the
// week just finished (Saturday) or the one ahead (Sunday).
function weekKey(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 6 ? -1 : 5 - dow));
  return d.toISOString().slice(0, 10);
}

const toYahoo = (ticker) => ticker.replace(/\./g, "-");

async function tvScan(body) {
  const res = await fetch(SCANNER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, Referer: "https://www.tradingview.com/" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TradingView scanner HTTP ${res.status}`);
  const payload = await res.json();
  return { rows: payload.data || [], totalCount: payload.totalCount };
}

const TV_COLUMNS = ["name", "close", "market_cap_basic", "sector", "total_shares_outstanding", "description"];
function tvRow(r) {
  const [name, close, mcap, sector, shares, description] = r.d;
  const [exchange, ticker] = r.s.split(":");
  const sh = Number.isFinite(shares) && shares > 0 ? shares : Number.isFinite(mcap) && close > 0 ? mcap / close : null;
  return { tv: r.s, exchange, ticker, name: description || name, close, mcap: Number.isFinite(mcap) ? mcap : null, sector: sector || null, shares: sh };
}

async function fetchRussellList() {
  const { rows, totalCount } = await tvScan({
    filter: [],
    symbols: { query: { types: [] }, tickers: [], groups: [{ type: "index", values: ["TVC:RUT"] }] },
    columns: TV_COLUMNS,
    range: [0, 2500],
  });
  if (rows.length < 1500) throw new Error(`TradingView returned only ${rows.length} Russell 2000 members`);
  return { totalCount, rows: rows.map(tvRow) };
}

// Market cap, shares and the same TradingView sector names for the S&P 500,
// so the large-cap side of every comparison uses the same definitions.
// breadth-constituents.js spells share classes BRK-B while tv-exchange-map.js
// and TradingView use BRK.B.
async function fetchSp500Meta() {
  const tvTicker = (s) => s.replace(/-/g, ".");
  const bySpelling = new Map(BREADTH_CONSTITUENTS.map((s) => [tvTicker(s), s]));
  const tickers = BREADTH_CONSTITUENTS.filter((s) => TICKER_EXCHANGE[tvTicker(s)]).map((s) => `${TICKER_EXCHANGE[tvTicker(s)]}:${tvTicker(s)}`);
  let { rows } = await tvScan({ symbols: { tickers, query: { types: [] } }, columns: TV_COLUMNS });
  // The batched request drops a few tickers at random (see
  // scheduled-ath-tradingview.js); one follow-up request recovers them.
  const got = new Set(rows.map((r) => r.s));
  const missing = tickers.filter((t) => !got.has(t));
  if (missing.length) {
    try { rows = rows.concat((await tvScan({ symbols: { tickers: missing, query: { types: [] } }, columns: TV_COLUMNS })).rows); } catch {}
  }
  const meta = {};
  for (const r of rows) { const m = tvRow(r); if (bySpelling.has(m.ticker)) meta[bySpelling.get(m.ticker)] = m; }
  return meta;
}

function buildCalendar(dates, todayEt) {
  const months = [], monthDays = {}, weeks = [], weekDays = {};
  for (const d of dates) {
    const m = d.slice(0, 7);
    if (!monthDays[m]) { monthDays[m] = 0; months.push(m); }
    monthDays[m]++;
    const w = weekKey(d);
    if (!weekDays[w]) { weekDays[w] = 0; weeks.push(w); }
    weekDays[w]++;
  }
  return {
    dates,
    months: months.map((m) => ({ key: m, days: monthDays[m], partial: m === todayEt.slice(0, 7) })),
    weeks: weeks.map((w) => ({ key: w, days: weekDays[w], complete: w < todayEt })),
  };
}

// Corwin & Schultz (2012) two-day high-low spread estimator with the
// paper's two standard adjustments: day t+1's range is shifted by any
// overnight gap from day t's close, and negative two-day estimates are set
// to zero before averaging.
function corwinSchultz(b0, b1) {
  let H0 = b0.high, L0 = b0.low, H1 = b1.high, L1 = b1.low;
  const C0 = b0.close;
  if (![H0, L0, H1, L1, C0].every((v) => Number.isFinite(v) && v > 0) || H0 < L0 || H1 < L1) return null;
  if (L1 > C0) { const g = L1 - C0; H1 -= g; L1 -= g; }
  else if (H1 < C0) { const g = C0 - H1; H1 += g; L1 += g; }
  const beta = Math.log(H0 / L0) ** 2 + Math.log(H1 / L1) ** 2;
  const gamma = Math.log(Math.max(H0, H1) / Math.min(L0, L1)) ** 2;
  const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / CS_K - Math.sqrt(gamma / CS_K);
  const s = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
  return Number.isFinite(s) ? Math.max(s, 0) : null;
}

// Reduces one stock's bars to what the aggregation needs, aligned to the
// SPY trading calendar: window measures, monthly and weekly values. Kept
// compact because ~2,450 of these sit in the checkpoint between runs.
function summarize(bars, cal) {
  const byDate = new Map(bars.map((b) => [b.date, b]));
  const n = cal.dates.length;
  const traded = (b) => b && Number.isFinite(b.volume) && b.volume > 0 && b.close > 0;
  const dv = new Array(n).fill(null), vol = new Array(n).fill(null), amihud = new Array(n).fill(null), cs = new Array(n).fill(null);
  const has = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const b = byDate.get(cal.dates[i]);
    has[i] = !!(b && b.close > 0);
    if (!traded(b)) continue;
    dv[i] = b.close * b.volume;
    vol[i] = b.volume;
    const p = i > 0 ? byDate.get(cal.dates[i - 1]) : null;
    if (!traded(p)) continue;
    if (p.adjClose > 0 && b.adjClose > 0) amihud[i] = (Math.abs(b.adjClose / p.adjClose - 1) / dv[i]) * AMIHUD_SCALE;
    cs[i] = corwinSchultz(p, b);
  }

  const firstDate = bars[0].date, lastDate = bars[bars.length - 1].date;
  const live = n >= STALE_SESSIONS && lastDate >= cal.dates[n - STALE_SESSIONS];
  function windowStats(len) {
    const start = n - len;
    if (!live || start < 0 || firstDate > cal.dates[start]) return null;
    const pick = (arr) => arr.slice(start).filter((v) => v !== null);
    const dvs = pick(dv), vols = pick(vol), ams = pick(amihud), css = pick(cs);
    // A session with no Yahoo bar at all is a gap in Yahoo's data rather than
    // a day without trades, so it counts toward neither side of the
    // zero-volume share. Too many gaps and the stock is left out.
    const sessions = has.slice(start).filter(Boolean).length;
    if (!dvs.length || sessions < len * MIN_COVERAGE) return null;
    return {
      dv: sig(median(dvs)),
      vol: sig(median(vols)),
      am: ams.length >= MIN_VALUES ? sig(mean(ams)) : null,
      cs: css.length >= MIN_VALUES ? sig(mean(css)) : null,
      z: round(((sessions - dvs.length) / sessions) * 100, 1),
    };
  }

  const monthly = { dv: [], cs: [] };
  let i0 = 0;
  for (const m of cal.months) {
    const idx = [];
    while (i0 < n && cal.dates[i0].slice(0, 7) === m.key) idx.push(i0++);
    const dvs = idx.map((i) => dv[i]).filter((v) => v !== null);
    const css = idx.map((i) => cs[i]).filter((v) => v !== null);
    monthly.dv.push(dvs.length >= MIN_VALUES ? sig(median(dvs)) : null);
    monthly.cs.push(css.length >= MIN_VALUES ? sig(mean(css)) : null);
  }
  const weekly = [];
  i0 = 0;
  for (const w of cal.weeks) {
    const ams = [];
    while (i0 < n && weekKey(cal.dates[i0]) === w.key) { if (amihud[i0] !== null) ams.push(amihud[i0]); i0++; }
    weekly.push(ams.length >= 2 ? sig(mean(ams)) : null);
  }
  return { first: firstDate, last: lastDate, w63: windowStats(LONG), w21: windowStats(SHORT), m: monthly, wk: weekly };
}

// Last total-return close of each calendar week, for the IWM/SPY relative
// return.
function weeklyCloses(bars, cal) {
  const byDate = new Map(bars.map((b) => [b.date, b.adjClose]));
  const out = {};
  for (const d of cal.dates) if (byDate.has(d)) out[weekKey(d)] = byDate.get(d);
  return cal.weeks.map((w) => (w.key in out ? out[w.key] : null));
}

// Newey-West (1987) standard error of a series mean, copied from
// scheduled-putcall-study-background.js.
function neweyWest(series, lag) {
  const x = series.filter(Number.isFinite);
  const n = x.length;
  if (n < MIN_OBS_FOR_T) return { mean: mean(x), se: null, t: null, n };
  const m = mean(x);
  const d = x.map((v) => v - m);
  let s = d.reduce((acc, v) => acc + v * v, 0) / n;
  for (let l = 1; l <= Math.min(lag, n - 1); l++) {
    let c = 0;
    for (let i = l; i < n; i++) c += d[i] * d[i - l];
    s += 2 * (1 - l / (lag + 1)) * (c / n);
  }
  const se = Math.sqrt(Math.max(s, 0) / n);
  return { mean: m, se, t: se > 0 ? m / se : null, n };
}

function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + (x < 0 ? -y : y));
}

// OLS slope with a Newey-West standard error: the slope's sampling error is
// the mean of x_dev * residual divided by mean(x_dev^2), so the HAC error of
// that mean carries straight through.
function olsNeweyWest(xs, ys, lag) {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  const xd = xs.map((x) => x - mx);
  const sxx = xd.reduce((s, v) => s + v * v, 0);
  const sxy = xd.reduce((s, v, i) => s + v * (ys[i] - my), 0);
  const syy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const g = xd.map((v, i) => v * (ys[i] - intercept - slope * xs[i]));
  const nw = neweyWest(g, lag);
  const se = nw.se === null ? null : nw.se / (sxx / n);
  const t = se ? slope / se : null;
  return { n, r: round(r, 4), r2: round(r * r, 4), slope: sig(slope), intercept: sig(intercept), seNW: sig(se), tNW: round(t, 2), p: t === null ? null : sig(2 * (1 - normalCdf(Math.abs(t))), 3) };
}

function ranks(arr) {
  const idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]);
  const out = new Array(arr.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && arr[idx[j + 1]] === arr[idx[i]]) j++;
    for (let k = i; k <= j; k++) out[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

function measures(list, win) {
  const rows = list.map((x) => ({ s: x.sum[win], shares: x.shares })).filter((x) => x.s);
  return {
    n: rows.length,
    dv: sig(median(rows.map((x) => x.s.dv))),
    turnover: sig(median(rows.map((x) => (x.shares > 0 ? (x.s.vol / x.shares) * 100 : null)))),
    amihud: sig(median(rows.map((x) => x.s.am))),
    cs: sig(median(rows.map((x) => x.s.cs))),
    zeroPct: round(mean(rows.map((x) => x.s.z)), 2),
    anyZeroPct: rows.length ? round((rows.filter((x) => x.s.z > 0).length / rows.length) * 100, 1) : null,
  };
}

function aggregate(cp, finishedAll) {
  const cal = buildCalendar(cp.calendar, cp.todayEt);
  const withSum = (list) => list.filter((m) => cp.results[m.key] && cp.results[m.key].sum).map((m) => ({ ...m, sum: cp.results[m.key].sum }));
  const r2k = withSum(cp.members.map((m) => ({ ...m, key: m.yahoo })));
  const spx = withSum(BREADTH_CONSTITUENTS.map((s) => {
    const m = cp.spMeta[s] || {};
    return { key: toYahoo(s), ticker: s, sector: m.sector || null, mcap: m.mcap || null, shares: m.shares || null };
  }));
  const r2kLive = r2k.filter((m) => m.sum.w63);
  const spxLive = spx.filter((m) => m.sum.w63);
  const noRecentPrice = cp.members.filter((m) => cp.results[m.yahoo] && cp.results[m.yahoo].noPrice).map((m) => m.ticker);

  const compare = {
    r2000: { w63: measures(r2k, "w63"), w21: measures(r2k, "w21") },
    sp500: { w63: measures(spx, "w63"), w21: measures(spx, "w21") },
  };

  const bySize = r2kLive.filter((m) => m.mcap > 0).sort((a, b) => a.mcap - b.mcap);
  if (bySize.length < 50) throw new Error(`only ${bySize.length} Russell 2000 members have prices and market caps`);
  const fifthOf = new Map();
  bySize.forEach((m, i) => fifthOf.set(m.ticker, Math.floor((i * 5) / bySize.length) + 1));
  const sizeFifths = [1, 2, 3, 4, 5].map((f) => {
    const g = bySize.filter((m) => fifthOf.get(m.ticker) === f);
    return { fifth: f, mcapMin: sig(g[0].mcap, 3), mcapMax: sig(g[g.length - 1].mcap, 3), mcapMedian: sig(median(g.map((m) => m.mcap)), 3), ...measures(g, "w63") };
  });

  const sectorNames = [...new Set(r2kLive.map((m) => m.sector).filter(Boolean))];
  const sectors = sectorNames
    .map((sector) => ({
      sector,
      r2000: measures(r2kLive.filter((m) => m.sector === sector), "w63"),
      sp500: measures(spxLive.filter((m) => m.sector === sector), "w63"),
    }))
    .sort((a, b) => (b.r2000.cs || 0) - (a.r2000.cs || 0));

  const monthIdx = cal.months.map((m, i) => (m.days >= MIN_MONTH_DAYS ? i : -1)).filter((i) => i >= 0);
  const monthMed = (list, field, i) => sig(median(list.map((m) => m.sum.m[field][i])));
  const monthly = {
    months: monthIdx.map((i) => cal.months[i].key),
    partial: monthIdx.map((i) => cal.months[i].partial),
    r2000: { dv: monthIdx.map((i) => monthMed(r2k, "dv", i)), cs: monthIdx.map((i) => monthMed(r2k, "cs", i)) },
    sp500: { dv: monthIdx.map((i) => monthMed(spx, "dv", i)), cs: monthIdx.map((i) => monthMed(spx, "cs", i)) },
  };

  const iwm = cp.etf.IWM, spy = cp.etf.SPY;
  const weekIdx = cal.weeks.map((w, i) => (w.complete && w.days >= MIN_WEEK_DAYS ? i : -1)).filter((i) => i >= 0);
  const weekly = { weeks: [], r2000Amihud: [], sp500Amihud: [], gap: [], relReturnPct: [], gapChangePct: [] };
  let prev = null;
  for (const i of weekIdx) {
    const a = median(r2k.map((m) => m.sum.wk[i])), b = median(spx.map((m) => m.sum.wk[i]));
    const gap = a > 0 && b > 0 ? a / b : null;
    let rel = null, dGap = null;
    if (prev !== null && prev.i === i - 1) {
      if (iwm[i] && iwm[i - 1] && spy[i] && spy[i - 1]) rel = ((iwm[i] / iwm[i - 1]) / (spy[i] / spy[i - 1]) - 1) * 100;
      if (gap && prev.gap) dGap = Math.log(gap / prev.gap) * 100;
    }
    weekly.weeks.push(cal.weeks[i].key);
    weekly.r2000Amihud.push(sig(a));
    weekly.sp500Amihud.push(sig(b));
    weekly.gap.push(round(gap, 2));
    weekly.relReturnPct.push(round(rel, 3));
    weekly.gapChangePct.push(round(dGap, 2));
    prev = { i, gap };
  }
  const pairs = weekly.weeks.map((w, k) => ({ week: w, x: weekly.relReturnPct[k], y: weekly.gapChangePct[k] })).filter((p) => p.x !== null && p.y !== null);
  const gapTest = pairs.length >= 3
    ? {
        n: pairs.length,
        lag: NW_LAG,
        pearson: olsNeweyWest(pairs.map((p) => p.x), pairs.map((p) => p.y), NW_LAG),
        spearman: olsNeweyWest(ranks(pairs.map((p) => p.x)), ranks(pairs.map((p) => p.y)), NW_LAG),
        pairs,
      }
    : null;

  const members = r2kLive
    .map((m) => {
      const s = m.sum.w63, s21 = m.sum.w21;
      return {
        symbol: m.ticker, name: m.name, sector: m.sector, mcap: sig(m.mcap, 4), fifth: fifthOf.get(m.ticker) || null,
        dv: s.dv, turnover: m.shares > 0 ? sig((s.vol / m.shares) * 100, 3) : null, amihud: s.am, cs: s.cs, zeroPct: s.z,
        dv21: s21 ? s21.dv : null, cs21: s21 ? s21.cs : null,
      };
    })
    .sort((a, b) => (b.mcap || 0) - (a.mcap || 0));

  const universe = cp.members.length + BREADTH_CONSTITUENTS.length;
  const loaded = r2k.length + spx.length;
  return {
    generated_at_utc: new Date().toISOString(),
    asOfDate: cal.dates[cal.dates.length - 1],
    partial: !finishedAll,
    universeSize: universe,
    loadedCount: loaded,
    failedTickers: Object.keys(cp.failed).slice(0, 40),
    index: {
      source: "TradingView screener, index group TVC:RUT",
      listed: cp.listTotal,
      droppedExchange: cp.droppedExchange,
      droppedNoPrice: noRecentPrice,
      members: r2kLive.length,
      tooRecentFor63: r2k.length - r2kLive.length,
      sp500Overlap: cp.members.filter((m) => BREADTH_CONSTITUENTS.some((s) => toYahoo(s) === m.yahoo)).map((m) => m.ticker),
      sp500Members: spxLive.length,
    },
    windows: { long: LONG, short: SHORT, longStart: cal.dates[cal.dates.length - LONG], shortStart: cal.dates[cal.dates.length - SHORT] },
    compare,
    sizeFifths,
    sectors,
    monthly,
    weekly,
    gapTest,
    members,
  };
}

exports.handler = async () => {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
  console.log("scheduled-smallcap-liquidity-background: starting");
  try {
    const store = getSmallcapLiquidityStore();
    const saved = await store.get(CHECKPOINT_KEY, { type: "json" });
    const fresh = saved && Date.now() - Date.parse(saved.startedAt) < CHECKPOINT_MAX_AGE_MS;
    if (fresh && saved.complete) {
      console.log("scheduled-smallcap-liquidity-background: this week's sweep is already complete, exiting");
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "already complete" }) };
    }

    const now = etParts();
    let cp;
    if (fresh) {
      cp = saved;
      cp.runs++;
      console.log(`scheduled-smallcap-liquidity-background: resuming run ${cp.runs} with ${Object.keys(cp.results).length} symbol(s) done`);
    } else {
      const sinceDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 13, 1));
      const sinceUnix = Math.floor(sinceDate.getTime() / 1000);
      const dropPartialToday = (bars) => {
        const last = bars[bars.length - 1];
        return last && last.date === now.date && now.minutes < 16 * 60 + 30 ? bars.slice(0, -1) : bars;
      };
      const spyBars = dropPartialToday(await fetchDailyBars("SPY", { sinceUnix }));
      const iwmBars = dropPartialToday(await fetchDailyBars("IWM", { sinceUnix }));
      const calendar = spyBars.map((b) => b.date);
      const cal = buildCalendar(calendar, now.date);

      const list = await fetchRussellList();
      const droppedExchange = list.rows.filter((r) => !KEEP_EXCHANGES.has(r.exchange)).map((r) => r.tv);
      const members = list.rows
        .filter((r) => KEEP_EXCHANGES.has(r.exchange))
        .map((r) => ({ ticker: r.ticker, yahoo: toYahoo(r.ticker), name: r.name, sector: r.sector, mcap: r.mcap, shares: r.shares }));
      const spMeta = await fetchSp500Meta();
      console.log(`scheduled-smallcap-liquidity-background: ${list.totalCount} listed, ${members.length} on main exchanges, ${Object.keys(spMeta).length} S&P 500 metas`);

      cp = {
        startedAt: new Date().toISOString(), runs: 1, complete: false, todayEt: now.date, sinceUnix,
        calendar, listTotal: list.totalCount, droppedExchange, members, spMeta,
        etf: { SPY: weeklyCloses(spyBars, cal), IWM: weeklyCloses(iwmBars, cal) },
        results: {}, attempts: {}, failed: {},
      };
    }

    const cal = buildCalendar(cp.calendar, cp.todayEt);
    const symbols = [...new Set([...cp.members.map((m) => m.yahoo), ...BREADTH_CONSTITUENTS.map(toYahoo)])];
    const pending = () => symbols.filter((s) => !cp.results[s] && (cp.attempts[s] || 0) < MAX_ATTEMPTS);
    const saveCheckpoint = () => store.setJSON(CHECKPOINT_KEY, cp);
    console.log(`scheduled-smallcap-liquidity-background: ${pending().length} of ${symbols.length} symbol(s) to fetch`);

    let sinceCheckpoint = 0, stoppedForTime = false;
    async function sweep(todo) {
      let next = 0;
      async function worker(id) {
        await sleep(id * (WORKER_GAP_MS / WORKERS));
        while (next < todo.length) {
          if (outOfTime()) { stoppedForTime = true; return; }
          const symbol = todo[next++];
          cp.attempts[symbol] = (cp.attempts[symbol] || 0) + 1;
          try {
            const bars = (await fetchDailyBars(symbol, { sinceUnix: cp.sinceUnix })).filter((b) => b.date <= cp.calendar[cp.calendar.length - 1]);
            const sum = bars.length ? summarize(bars, cal) : null;
            cp.results[symbol] = sum && sum.w21 ? { sum } : { noPrice: true, last: bars.length ? bars[bars.length - 1].date : null };
            delete cp.failed[symbol];
          } catch (err) {
            // Yahoo answers 404 for symbols it doesn't carry, so retrying is pointless.
            if (/HTTP 404|no closes|no data/i.test(err.message)) { cp.results[symbol] = { noPrice: true, last: null }; delete cp.failed[symbol]; }
            else cp.failed[symbol] = String(err.message).slice(0, 160);
          }
          if (++sinceCheckpoint >= CHECKPOINT_EVERY) { sinceCheckpoint = 0; await saveCheckpoint(); }
          await sleep(WORKER_GAP_MS);
        }
      }
      await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
    }
    await sweep(pending());
    if (!stoppedForTime && pending().length) {
      console.log(`scheduled-smallcap-liquidity-background: retry pass for ${pending().length} symbol(s)`);
      await sleep(30000);
      await sweep(pending());
    }

    const remaining = pending();
    const finishedAll = !stoppedForTime && remaining.length === 0;
    const lastChance = cp.runs >= MAX_RUNS_PER_SWEEP;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    console.log(`scheduled-smallcap-liquidity-background: run ${cp.runs} fetched for ${secs}s, ${Object.keys(cp.results).length}/${symbols.length} done, ${remaining.length} remaining`);

    if (!finishedAll && !lastChance) {
      await saveCheckpoint();
      return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, remaining: remaining.length }) };
    }

    const payload = aggregate(cp, finishedAll);
    if (payload.index.members < 1000 || payload.index.sp500Members < 300) {
      throw new Error(`insufficient data: ${payload.index.members} Russell 2000 / ${payload.index.sp500Members} S&P 500 members with prices`);
    }
    payload.runSeconds = secs;
    payload.runs = cp.runs;
    await store.setJSON(LATEST_KEY, payload);
    // The per-stock summaries are only needed while a sweep is unfinished.
    await store.setJSON(CHECKPOINT_KEY, { startedAt: cp.startedAt, runs: cp.runs, complete: true });
    console.log(`scheduled-smallcap-liquidity-background: wrote ${payload.members.length} members, ${payload.index.sp500Members} S&P 500`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, members: payload.members.length }) };
  } catch (err) {
    console.error(`scheduled-smallcap-liquidity-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};

