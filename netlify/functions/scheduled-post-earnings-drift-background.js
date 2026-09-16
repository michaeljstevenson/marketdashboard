// Scheduled Background Function (see [functions."scheduled-post-earnings-
// drift-background"] in netlify.toml) that tests Post-Earnings Announcement
// Drift (PEAD) — one of the best-documented anomalies in the academic
// asset-pricing literature: stocks that beat (miss) their earnings estimate
// tend to keep drifting in the same direction vs. the market for weeks
// afterward, rather than the surprise being instantly and fully priced in.
//
// Reuses the earnings-surprise blob (getSurpriseStore) for the input side
// of the test — each company's most recent reportedDate and
// surprisePercentage — instead of re-sweeping Alpha Vantage's EARNINGS
// endpoint a second time. Same cross-page-reuse convention
// scheduled-earnings-growth-divergence-background.js uses for the
// relative-strength blob and scheduled-shareholder-yield-background.js uses
// for the share-count-trends blob.
//
// IMPORTANT staleness caveat: scheduled-surprise-background.js's own
// recurring schedule was removed by commit 704645f — it is now a one-time
// snapshot (2026-09-16), not auto-refreshing, unless someone manually
// reruns it from the Netlify dashboard. As real time passes, the
// `reportedDate` values in that snapshot get stale and fewer of them will
// still fall inside this job's own rolling ~100-trading-day compact price
// window — this job does NOT try to paper over that, it just reports the
// shrinking "in coverage window" count plainly (see `universe.inWindow`
// below) rather than silently dropping to a confusing near-zero N with no
// explanation. The page's methodology section documents this honestly.
//
// Price data is a fresh sweep of TIME_SERIES_DAILY_ADJUSTED across the full
// S&P 500 (BREADTH_CONSTITUENTS) + SPY, outputsize=compact (last ~100
// trading days) — same deliberate choice scheduled-relative-strength-
// background.js made for the same reason: a short event window (+1/+5/+10/
// +20 trading days from an earnings date) doesn't need, and shouldn't pay
// the bandwidth/parse cost of, "full" history (~580K tokens for a single
// mega-cap, confirmed directly against Alpha Vantage in that page's own
// design).
//
// For each company with a reportedDate that falls inside the fetched
// compact window, the anchor trading day is the first close on or after
// reportedDate (never before — that would leak pre-announcement data into
// the "after" side of the test). Forward/excess returns are computed at
// +1/+5/+10/+20 trading days from that anchor, against SPY over the
// identical span, using the same compounding-consistent excess-return
// formula (relativeReturn) as scheduled-relative-strength-background.js
// and scheduled-international-background.js. A leg whose price history
// doesn't reach a given horizon yet (recent report, near the end of the
// compact window) gets a null for that horizon only, not a dropped company
// or a fabricated value — same convention as scheduled-spinoff-
// background.js's per-leg horizon handling.
//
// The real statistical test (Pearson/Spearman regression of
// surprisePercentage against the +20-day forward excess return, plus a
// plain beat-vs-miss two-sample comparison) is computed client-side in
// post-earnings-drift.html from the raw per-company `companies` array this
// job writes — same division of labor as /spin-off-performance.html (this
// job precomputes the aggregate drift curve, sector medians and
// leaderboards server-side; the page duplicates this site's usual stats
// helpers to run the regression/t-test itself, since every page here is
// self-contained per CLAUDE.md).
//
// No accumulating weekly history: like /spin-off-performance, this
// recomputes the full drift panel fresh from whatever quarter/price window
// is available each run, rather than building up a time series — there's
// no obvious "trend of PEAD over time" this page is trying to chart, and a
// fresh snapshot is simpler and cheaper to reason about.
//
// ~504 sequential TIME_SERIES_DAILY_ADJUSTED calls (503 constituents +
// SPY), 1050ms apart with a retry pass — identical pacing to
// scheduled-relative-strength-background.js at the same scale.

const { getPeadStore, LATEST_KEY } = require("./post-earnings-drift-blob-store");
const { getSurpriseStore, LATEST_KEY: SURPRISE_LATEST_KEY } = require("./surprise-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HORIZONS = [1, 5, 10, 20];
const LEADERBOARD_COUNT = 10;
const MIN_SECTOR_N = 5; // per group (beat/miss), per sector — below this a median is noise, not signal

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, digits = 3) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
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

// Compounding-consistent excess return, in percentage points — same
// construction used by scheduled-relative-strength-background.js and
// scheduled-international-background.js.
function relativeReturn(stockRet, benchRet) {
  if (stockRet === null || benchRet === null) return null;
  return ((1 + stockRet) / (1 + benchRet) - 1) * 100;
}

async function fetchDailyAdjusted(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=compact&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const series = payload["Time Series (Daily)"];
  if (!series) throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 200)}`);

  const rows = Object.entries(series)
    .map(([date, day]) => ({ date, close: parseFloat(day["5. adjusted close"]) }))
    .filter((d) => Number.isFinite(d.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { dates: rows.map((r) => r.date), closes: rows.map((r) => r.close) };
}

// First index in an ascending `dates` array on or after `targetDate`. Null
// if targetDate falls entirely outside the array's span — either before
// its first date (the report predates this run's compact window: we can't
// find the true "day after" without fabricating a gap) or after its last
// date (shouldn't happen when both fetches run the same day, but guarded).
function findAnchorIndex(dates, targetDate) {
  if (!dates.length || targetDate < dates[0] || targetDate > dates[dates.length - 1]) return null;
  let lo = 0;
  let hi = dates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] >= targetDate) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

exports.handler = async () => {
  console.log(`scheduled-post-earnings-drift-background: starting, ${BREADTH_CONSTITUENTS.length} tickers + SPY`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    // ---- Reused input: each company's most recent reported surprise ----
    let surpriseByTicker = {};
    let surpriseSnapshotGeneratedAt = null;
    try {
      const surpriseStore = getSurpriseStore();
      const surpriseLatest = await surpriseStore.get(SURPRISE_LATEST_KEY, { type: "json" });
      if (surpriseLatest) {
        surpriseSnapshotGeneratedAt = surpriseLatest.generated_at_utc || null;
        if (Array.isArray(surpriseLatest.companiesLatest)) {
          for (const c of surpriseLatest.companiesLatest) {
            if (c.reportedDate && Number.isFinite(c.surprisePct)) surpriseByTicker[c.ticker] = c;
          }
        }
      }
    } catch (err) {
      console.error("scheduled-post-earnings-drift-background: could not read earnings-surprise blob, continuing with zero coverage:", err.message);
    }
    const surpriseCompaniesAvailable = Object.keys(surpriseByTicker).length;

    // ---- SPY benchmark: fetch first, abort the run if it fails ----
    let spy = null;
    for (let attempt = 0; attempt < 3 && !spy; attempt++) {
      try {
        spy = await fetchDailyAdjusted(apiKey, "SPY");
      } catch (err) {
        console.error(`scheduled-post-earnings-drift-background: SPY fetch failed (attempt ${attempt + 1}): ${err.message}`);
        await sleep(5000);
      }
    }
    if (!spy) throw new Error("Could not fetch SPY benchmark data after 3 attempts");
    await sleep(1050);

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    // ---- Full-universe compact price sweep ----
    const priceResults = new Map();
    async function fetchInto(symbol) {
      try {
        const hist = await fetchDailyAdjusted(apiKey, symbol);
        if (hist.dates.length) priceResults.set(symbol, hist);
        return true;
      } catch (err) {
        console.error(`scheduled-post-earnings-drift-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }
    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-post-earnings-drift-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(1050);
      }
      todo = missed;
    }
    console.log(`scheduled-post-earnings-drift-background: fetched ${priceResults.size}/${BREADTH_CONSTITUENTS.length} price series`);

    // ---- Build one drift record per company ----
    const companies = [];
    let priceLoadFailed = 0;
    let missingSurpriseMatch = 0;
    let outOfWindow = 0;

    for (const symbol of BREADTH_CONSTITUENTS) {
      const hist = priceResults.get(symbol);
      if (!hist) { priceLoadFailed++; continue; }

      const surprise = surpriseByTicker[symbol];
      if (!surprise) { missingSurpriseMatch++; continue; }

      const anchorIdx = findAnchorIndex(hist.dates, surprise.reportedDate);
      if (anchorIdx === null) { outOfWindow++; continue; }

      const anchorDate = hist.dates[anchorIdx];
      const spyAnchorIdx = findAnchorIndex(spy.dates, anchorDate);
      if (spyAnchorIdx === null) { outOfWindow++; continue; }

      const m = metaTickers[symbol];
      const sector = (m && m.sector) || null;
      if (!sector) { missingSurpriseMatch++; continue; } // no sector metadata — can't place it in any sector aggregate

      const ret = {};
      const excess = {};
      for (const h of HORIZONS) {
        const fwdIdx = anchorIdx + h;
        const spyFwdIdx = spyAnchorIdx + h;
        if (fwdIdx >= hist.closes.length || spyFwdIdx >= spy.closes.length) {
          ret[h] = null;
          excess[h] = null;
          continue;
        }
        const stockRet = hist.closes[fwdIdx] / hist.closes[anchorIdx] - 1;
        const spyRet = spy.closes[spyFwdIdx] / spy.closes[spyAnchorIdx] - 1;
        ret[h] = round(stockRet * 100, 2);
        excess[h] = round(relativeReturn(stockRet, spyRet), 2);
      }

      companies.push({
        symbol,
        name: (m && m.name) || symbol,
        sector,
        reportedDate: surprise.reportedDate,
        quarterLabel: surprise.quarterLabel || null,
        surprisePct: round(surprise.surprisePct, 2),
        beat: surprise.surprisePct > 0 ? 1 : surprise.surprisePct < 0 ? -1 : 0,
        anchorDate,
        ret: { d1: ret[1], d5: ret[5], d10: ret[10], d20: ret[20] },
        excess: { d1: excess[1], d5: excess[5], d10: excess[10], d20: excess[20] },
      });
    }

    const inWindow = companies.length;
    console.log(`scheduled-post-earnings-drift-background: ${inWindow} companies in coverage window (surprise available: ${surpriseCompaniesAvailable}, price failed: ${priceLoadFailed}, no surprise match: ${missingSurpriseMatch}, out of window: ${outOfWindow})`);

    // ---- Drift curve: avg cumulative excess return by horizon, beat vs miss ----
    const beat = companies.filter((c) => c.beat > 0);
    const miss = companies.filter((c) => c.beat < 0);
    const horizonKeyOf = { 1: "d1", 5: "d5", 10: "d10", 20: "d20" };
    function curveFor(group) {
      const avgExcess = [];
      const n = [];
      for (const h of HORIZONS) {
        const key = horizonKeyOf[h];
        const vals = group.map((c) => c.excess[key]).filter((v) => v !== null);
        avgExcess.push(round(mean(vals), 3));
        n.push(vals.length);
      }
      return { avgExcess, n };
    }
    const driftCurve = { horizons: HORIZONS, beat: curveFor(beat), miss: curveFor(miss) };

    // ---- Sector breakdown: median +20d excess by sector, beat vs miss ----
    const sectorBreakdown = SECTOR_ORDER.map((sector) => {
      const beatVals = beat.filter((c) => c.sector === sector && c.excess.d20 !== null).map((c) => c.excess.d20);
      const missVals = miss.filter((c) => c.sector === sector && c.excess.d20 !== null).map((c) => c.excess.d20);
      if (!beatVals.length && !missVals.length) return null;
      return {
        sector,
        beatN: beatVals.length,
        missN: missVals.length,
        beatMedianExcess20: round(median(beatVals), 2),
        missMedianExcess20: round(median(missVals), 2),
        thin: beatVals.length < MIN_SECTOR_N || missVals.length < MIN_SECTOR_N,
      };
    }).filter(Boolean);
    const sectorsWithEnoughData = sectorBreakdown.filter((s) => !s.thin).length;

    // ---- Leaderboards: biggest +20d drift among beats and among misses ----
    function leaderRow(c) {
      return {
        symbol: c.symbol, name: c.name, sector: c.sector, reportedDate: c.reportedDate,
        surprisePct: c.surprisePct, excess20: c.excess.d20,
      };
    }
    const beatWithD20 = beat.filter((c) => c.excess.d20 !== null);
    const missWithD20 = miss.filter((c) => c.excess.d20 !== null);
    const leaderboards = {
      beatUp: [...beatWithD20].sort((a, b) => b.excess.d20 - a.excess.d20).slice(0, LEADERBOARD_COUNT).map(leaderRow),
      beatDown: [...beatWithD20].sort((a, b) => a.excess.d20 - b.excess.d20).slice(0, LEADERBOARD_COUNT).map(leaderRow),
      missUp: [...missWithD20].sort((a, b) => b.excess.d20 - a.excess.d20).slice(0, LEADERBOARD_COUNT).map(leaderRow),
      missDown: [...missWithD20].sort((a, b) => a.excess.d20 - b.excess.d20).slice(0, LEADERBOARD_COUNT).map(leaderRow),
    };

    const payload = {
      generated_at_utc: new Date().toISOString(),
      priceWindow: { start: spy.dates[0], end: spy.dates[spy.dates.length - 1] },
      horizons: HORIZONS,
      universe: {
        total: BREADTH_CONSTITUENTS.length,
        priceLoaded: priceResults.size,
        surpriseSnapshotGeneratedAt,
        surpriseCompaniesAvailable,
        inWindow,
      },
      skipped: { priceLoadFailed, missingSurpriseMatch, outOfWindow },
      driftCurve,
      sectorBreakdown,
      sectorThinThreshold: MIN_SECTOR_N,
      sectorsWithEnoughData,
      leaderboards,
      companies,
    };

    await getPeadStore().setJSON(LATEST_KEY, payload);
    console.log(`scheduled-post-earnings-drift-background: wrote ${inWindow} companies in window (${beat.length} beats, ${miss.length} misses)`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, inWindow, beats: beat.length, misses: miss.length }) };
  } catch (err) {
    console.error("scheduled-post-earnings-drift-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
