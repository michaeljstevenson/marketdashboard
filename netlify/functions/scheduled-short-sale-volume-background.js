// Scheduled Background Function (see [functions."scheduled-short-sale-
// volume-background"] in netlify.toml) for the Short Sale Volume page.
//
// Backlog context: the "Short Interest Tracker" idea was investigated
// twice and skipped both times — FINRA's old anonymous short-interest
// (total shares held short, bi-monthly settlement dates) endpoint was
// deprecated in April 2021, and its replacement lives behind FINRA's API
// Console, requiring a registered account + OAuth credentials this
// environment can't self-serve. This page builds a genuinely different,
// but related and freely-available, metric instead: FINRA's Regulation
// SHO **Daily Short Sale Volume** files — the *flow* of short-sale
// trading activity as a share of total volume, not the *stock* of shares
// currently held short. No registration or API key needed; these are
// anonymous flat files FINRA has published daily since Nov 2009 at
// https://cdn.finra.org/equity/regsho/daily/CNMSshvol<YYYYMMDD>.txt (mirrored by Nasdaq
// Trader and Cboe). Short sale volume and short interest are related but
// distinct — see the page's methodology section for why this isn't a
// substitute for the still-unavailable short-interest number.
//
// The CNMS file covers one calendar day across ALL NMS-tape-eligible
// symbols (tens of thousands of rows) in one request — cheap and doesn't
// touch any API budget at all. We walk backward from "yesterday"
// (files post ~6pm ET same day, so today's may not exist yet) collecting
// valid trading days until we have WINDOW_TRADING_DAYS of them, discarding
// weekends/holidays (404s) along the way.
//
// Per-symbol short-sale-volume ratio (SVR = ShortVolume / TotalVolume) is
// computed for every S&P 500 constituent found in each day's file. That
// alone powers the sector/leaderboard/table views and the market-median
// trend line. The one price-dependent piece is the "does elevated
// short-selling predict weak forward returns" test: Yahoo Finance daily
// adjusted closes (last ~100 bars) for every constituent + SPY, split into
// two non-overlapping halves of the SAME window FINRA data covers — the
// older half's average SVR (the predictor) against the newer half's
// relative return vs SPY (the outcome) — avoiding the overlapping-window
// pitfall called out in scheduled-share-count-background.js and
// scheduled-relative-strength-background.js.
//
// Runtime budget: ~WINDOW_LOOKBACK_DAYS FINRA fetches (seconds) plus ~504 sequential Yahoo calls at 300ms with a retry pass —
// a few minutes end to end, with the FINRA phase adding well under a
// minute on top.

const { getShortSaleVolumeStore, LATEST_KEY } = require("./short-sale-volume-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { fetchDailyHistory } = require("./yahoo-client");
const COMPACT_DAYS = 100;

const FINRA_URL = (yyyymmdd) => `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd}.txt`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const WINDOW_TRADING_DAYS = 63; // ~3 months — matches this site's other 63-day lookbacks
const MAX_LOOKBACK_CALENDAR_DAYS = 130; // generous cushion for weekends + holidays
const MIN_TRADING_DAYS = 40; // below this, the window is too thin to trust
const RECENT_SNAPSHOT_DAYS = 21; // ~1 month, for the "current" leaderboards/table
const MIN_ROWS_FOR_VALID_FILE = 1000; // guards against a truncated/empty file masquerading as 200 OK
const LEADERBOARD_COUNT = 15;

// A handful of S&P 500 dual-share-class tickers use a dash in this site's
// own convention (BREADTH_CONSTITUENTS / Yahoo) but FINRA's tape
// data uses a dot — try the dot form as a fallback lookup, skip gracefully
// (see breadth-constituents.js's own file header) if neither matches.
const FINRA_SYMBOL_ALIAS = { "BRK-B": "BRK.B", "BF-B": "BF.B" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 4) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function toYyyymmdd(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}
function toIsoDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Parses one day's pipe-delimited FINRA file, keeping only rows whose
// Symbol is in `wanted` (a Set), and summing ShortVolume/TotalVolume
// across every "Market" row for that symbol (the file reports one row per
// participant venue per symbol per day).
function parseFinraFile(text, wanted) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < MIN_ROWS_FOR_VALID_FILE) return null;

  const header = lines[0].split("|").map((h) => h.trim().toLowerCase());
  const idx = {
    symbol: header.indexOf("symbol"),
    shortVolume: header.indexOf("shortvolume"),
    totalVolume: header.indexOf("totalvolume"),
  };
  if (idx.symbol < 0 || idx.shortVolume < 0 || idx.totalVolume < 0) return null;

  const bySymbol = new Map(); // symbol -> {shortVolume, totalVolume}
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("|");
    const symbol = cols[idx.symbol];
    if (!symbol || !wanted.has(symbol)) continue;
    const sv = parseFloat(cols[idx.shortVolume]);
    const tv = parseFloat(cols[idx.totalVolume]);
    if (!Number.isFinite(sv) || !Number.isFinite(tv)) continue;
    let bucket = bySymbol.get(symbol);
    if (!bucket) { bucket = { shortVolume: 0, totalVolume: 0 }; bySymbol.set(symbol, bucket); }
    bucket.shortVolume += sv;
    bucket.totalVolume += tv;
  }
  return bySymbol;
}

async function fetchFinraDay(yyyymmdd) {
  const res = await fetch(FINRA_URL(yyyymmdd), { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return null; // 404 on weekends/holidays — not an error, just no file
  const text = await res.text();
  return text;
}

// Walks backward from yesterday (UTC) collecting valid trading-day SVR
// data until WINDOW_TRADING_DAYS are found or the lookback cap is hit.
// Returns { dates: [oldest...newest], perSymbolByDate: Map<date, Map<symbol,{sv,tv}>> }.
async function collectFinraWindow(wantedFinraSymbols) {
  const perSymbolByDate = new Map();
  const dates = [];
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() - 1); // start at yesterday — today's file may not be posted yet

  let attempts = 0;
  while (dates.length < WINDOW_TRADING_DAYS && attempts < MAX_LOOKBACK_CALENDAR_DAYS) {
    const yyyymmdd = toYyyymmdd(cursor);
    attempts++;
    try {
      const text = await fetchFinraDay(yyyymmdd);
      if (text) {
        const bySymbol = parseFinraFile(text, wantedFinraSymbols);
        if (bySymbol && bySymbol.size > 0) {
          const iso = toIsoDate(yyyymmdd);
          perSymbolByDate.set(iso, bySymbol);
          dates.push(iso);
        }
      }
    } catch (err) {
      console.error(`scheduled-short-sale-volume-background: FINRA fetch failed for ${yyyymmdd}: ${err.message}`);
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    await sleep(150); // polite pacing, just courteous
  }

  dates.reverse(); // oldest -> newest
  return { dates, perSymbolByDate };
}

async function fetchDailyAdjustedCompact(symbol) {
  const rows = (await fetchDailyHistory(symbol)).slice(-COMPACT_DAYS);
  return new Map(rows.map((r) => [r.date, r.close]));
}

// Pearson + Spearman, matching /factor-analysis's two-method-check convention.
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
function rankOf(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avgRank;
    i = j + 1;
  }
  return ranks;
}
function spearman(xs, ys) {
  if (xs.length < 3) return null;
  return pearson(rankOf(xs), rankOf(ys));
}

exports.handler = async () => {
  console.log("scheduled-short-sale-volume-background: starting");
  try {

    const beeswarmStore = getBeeswarmStore();
    const meta = await beeswarmStore.get(META_KEY, { type: "json" });
    if (!meta || !meta.tickers) throw new Error("beeswarm meta.json not populated — scheduled-beeswarm-meta-background hasn't run yet");

    const symbols = Object.keys(meta.tickers).filter((s) => meta.tickers[s] && meta.tickers[s].sector);
    const finraLookup = new Map(); // finraSymbol -> ourSymbol
    for (const s of symbols) finraLookup.set(FINRA_SYMBOL_ALIAS[s] || s, s);
    const wantedFinraSymbols = new Set(finraLookup.keys());

    console.log(`scheduled-short-sale-volume-background: fetching FINRA Reg SHO daily files for ${wantedFinraSymbols.size} tickers`);
    const { dates, perSymbolByDate } = await collectFinraWindow(wantedFinraSymbols);
    console.log(`scheduled-short-sale-volume-background: collected ${dates.length} valid trading days`);
    if (dates.length < MIN_TRADING_DAYS) {
      throw new Error(`only ${dates.length} valid FINRA trading days found (need ${MIN_TRADING_DAYS}) — FINRA file layout or URL may have changed`);
    }

    // Per-ticker SVR series aligned to `dates` (null where a symbol didn't
    // appear in that day's file — e.g. no trading that day, or delisted).
    const svrByOurSymbol = new Map();
    for (const [finraSymbol, ourSymbol] of finraLookup.entries()) {
      const series = dates.map((d) => {
        const bucket = perSymbolByDate.get(d)?.get(finraSymbol);
        if (!bucket || !(bucket.totalVolume > 0)) return null;
        return bucket.shortVolume / bucket.totalVolume;
      });
      if (series.some((v) => v !== null)) svrByOurSymbol.set(ourSymbol, series);
    }
    console.log(`scheduled-short-sale-volume-background: ${svrByOurSymbol.size} tickers with at least one day of SVR data`);

    // Market-median SVR trend, one point per FINRA trading day.
    const trend = dates.map((d, i) => {
      const dayValues = [...svrByOurSymbol.values()].map((series) => series[i]).filter((v) => v !== null);
      return { date: d, medianSvr: round(median(dayValues), 4) };
    });

    // "Current" snapshot: average SVR over the most recent RECENT_SNAPSHOT_DAYS.
    const recentStart = Math.max(0, dates.length - RECENT_SNAPSHOT_DAYS);
    const recentSnapshot = new Map();
    for (const [symbol, series] of svrByOurSymbol.entries()) {
      const recent = series.slice(recentStart);
      const avg = mean(recent);
      if (avg !== null) recentSnapshot.set(symbol, avg);
    }

    // Non-overlapping-window predictive test: Period A = older half (SVR
    // predictor), Period B = newer half (forward relative return vs SPY).
    const mid = Math.floor(dates.length / 2);
    const periodADates = dates.slice(0, mid);
    const periodBDates = dates.slice(mid);
    const periodAAvgSvr = new Map();
    for (const [symbol, series] of svrByOurSymbol.entries()) {
      const avg = mean(series.slice(0, mid));
      if (avg !== null) periodAAvgSvr.set(symbol, avg);
    }

    console.log(`scheduled-short-sale-volume-background: fetching Yahoo daily prices for ${symbols.length} tickers + SPY`);
    const priceBySymbol = new Map();

    async function fetchInto(symbol) {
      try {
        const byDate = await fetchDailyAdjustedCompact(symbol);
        if (byDate.size < 5) return false;
        priceBySymbol.set(symbol, byDate);
        return true;
      } catch (err) {
        console.error(`scheduled-short-sale-volume-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...symbols, "SPY"];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-short-sale-volume-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got && !priceBySymbol.has(symbol)) missed.push(symbol);
        await sleep(300);
      }
      todo = missed;
    }
    console.log(`scheduled-short-sale-volume-background: fetched prices for ${priceBySymbol.size}/${symbols.length + 1} tickers`);

    const spyPrices = priceBySymbol.get("SPY");
    const periodBStartDate = periodBDates[0];
    const periodBEndDate = periodBDates[periodBDates.length - 1];
    const spyStart = spyPrices?.get(periodBStartDate);
    const spyEnd = spyPrices?.get(periodBEndDate);
    const spyReturn = Number.isFinite(spyStart) && Number.isFinite(spyEnd) && spyStart > 0 ? spyEnd / spyStart - 1 : null;

    const regressionPairs = [];
    if (spyReturn !== null) {
      for (const [symbol, svr] of periodAAvgSvr.entries()) {
        const prices = priceBySymbol.get(symbol);
        if (!prices) continue;
        const p0 = prices.get(periodBStartDate);
        const p1 = prices.get(periodBEndDate);
        if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0) continue;
        const relReturn = (p1 / p0 - 1) - spyReturn;
        regressionPairs.push({ symbol, svr: round(svr), relReturn: round(relReturn) });
      }
    }
    const pearsonR = regressionPairs.length >= 3 ? round(pearson(regressionPairs.map((p) => p.svr), regressionPairs.map((p) => p.relReturn)), 3) : null;
    const spearmanR = regressionPairs.length >= 3 ? round(spearman(regressionPairs.map((p) => p.svr), regressionPairs.map((p) => p.relReturn)), 3) : null;

    // Sector aggregation off the "current" recent snapshot.
    const sectorGroups = new Map();
    for (const [symbol, svr] of recentSnapshot.entries()) {
      const sector = meta.tickers[symbol]?.sector;
      if (!sector) continue;
      if (!sectorGroups.has(sector)) sectorGroups.set(sector, []);
      sectorGroups.get(sector).push(svr);
    }
    const sectors = SECTOR_ORDER
      .map((sector) => {
        const values = sectorGroups.get(sector);
        if (!values || !values.length) return null;
        return { sector, companyCount: values.length, medianSvr: round(median(values)), avgSvr: round(mean(values)) };
      })
      .filter(Boolean);

    const ranked = [...recentSnapshot.entries()]
      .map(([symbol, svr]) => ({
        symbol,
        name: meta.tickers[symbol]?.name || symbol,
        sector: meta.tickers[symbol]?.sector || null,
        avgSvr: round(svr),
      }))
      .filter((c) => c.avgSvr !== null)
      .sort((a, b) => b.avgSvr - a.avgSvr);
    ranked.forEach((c, i) => { c.rank = i + 1; });

    const mostShorted = ranked.slice(0, LEADERBOARD_COUNT);
    const leastShorted = ranked.slice(-LEADERBOARD_COUNT).reverse();

    const market = {
      companyCount: ranked.length,
      medianSvr: round(median(ranked.map((c) => c.avgSvr))),
      avgSvr: round(mean(ranked.map((c) => c.avgSvr))),
    };

    const latest = {
      generated_at_utc: new Date().toISOString(),
      windowStart: dates[0],
      windowEnd: dates[dates.length - 1],
      tradingDays: dates.length,
      recentSnapshotDays: Math.min(RECENT_SNAPSHOT_DAYS, dates.length),
      universeSize: symbols.length,
      loadedCount: svrByOurSymbol.size,
      market,
      sectors,
      trend,
      mostShorted,
      leastShorted,
      regression: {
        periodA: { start: periodADates[0], end: periodADates[periodADates.length - 1] },
        periodB: { start: periodBStartDate, end: periodBEndDate },
        spyReturn: round(spyReturn),
        pairCount: regressionPairs.length,
        pearsonR,
        spearmanR,
        pairs: regressionPairs,
      },
      companies: ranked,
    };

    await getShortSaleVolumeStore().setJSON(LATEST_KEY, latest);
    console.log(
      `scheduled-short-sale-volume-background: done — ${dates.length} trading days, ${svrByOurSymbol.size} tickers with SVR, ` +
      `${regressionPairs.length} regression pairs, pearson=${pearsonR}, spearman=${spearmanR}`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, tradingDays: dates.length, tickers: svrByOurSymbol.size }) };
  } catch (err) {
    console.error(`scheduled-short-sale-volume-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
