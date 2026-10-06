// Scheduled Background Function (see [functions."scheduled-beta-stability-
// background"] in netlify.toml) for the Beta Stability page: per S&P 500
// constituent, has the stock's own market sensitivity (beta vs. SPY) held
// steady over the last ~3 years, or drifted?
//
// A genuinely different question from every other beta/volatility page on
// this site: /equity-risk-premium.html and /roic-wacc.html both read
// Alpha Vantage OVERVIEW's `Beta` field — a single static number, Alpha
// Vantage's own (undisclosed-methodology) point estimate, never tested for
// stability. /volatility.html compares the VIX to S&P 500 realized
// volatility at the INDEX level only, with no per-stock beta and no
// per-stock cross-section at all. This page computes beta itself, twice,
// from two non-overlapping ~1.5-year halves of the same ~3-year trailing
// window, so it can directly ask whether a stock's own realized beta is a
// durable property or a moving target.
//
// Zero Alpha Vantage calls. Beta is computed entirely from Yahoo Finance
// daily closes (yahoo-client.js's fetchDailyHistory — the same helper
// scheduled-vol-risk-premium-background.js and scheduled-quality-lowvol-
// background.js already use for per-stock full-universe sweeps, and the
// only one of this site's ~65 backend jobs that needs no Alpha Vantage
// budget at all), resampled to weekly closes (Monday-of-week key, last
// trading day of each week wins) and converted to weekly log returns.
// Weekly, not daily: daily returns over a multi-year window are heavily
// autocorrelated at the individual-stock level (bid-ask bounce, stale
// quotes on thin names) and would inflate the apparent precision of an
// OLS beta estimate; weekly is the standard academic/practitioner
// convention for a multi-year beta (e.g. Bloomberg's default BETA
// function uses weekly returns over 2 years).
//
// Construction: SPY's own daily history is fetched once (not once per
// company) and resampled the same way. For each constituent, the trailing
// TARGET_WEEKS of weeks common to both the stock and SPY are used (SPY has
// traded every week since 1993, so in practice this is just the trailing
// window of the stock's own available weekly history, capped at
// TARGET_WEEKS). That set of weekly closes yields TARGET_WEEKS-1 weekly
// log returns, split into two EQUAL, non-overlapping, back-to-back halves
// — older half first, recent half last, same "equal-length oldest-half
// vs. most-recent-half split" discipline as scheduled-ai-capex-
// background.js's structural-break test, just applied per-company instead
// of to one aggregate series. OLS beta (slope of stock weekly return on
// SPY weekly return) is computed independently in each half, plus once
// more over the full window. `drift` = recentBeta − olderBeta.
//
// A constituent with fewer than MIN_WEEKS of common weekly history (a
// recent IPO, a very recent spinoff, a halted/delisted name, or a Yahoo
// fetch failure after retries) is EXCLUDED, not compared on a shorter or
// fabricated window — same "excluded, not distorted" convention as every
// other full-sweep job on this site.
//
// Only the two half-betas, the full-period beta/R², and the drift figure
// are computed and stored server-side. The cross-sectional Pearson/
// Spearman persistence test (recent beta vs. older beta) and the one-
// sample t-test/sign test on drift both run client-side in beta-
// stability.html, same architecture as every other page on this site
// (self-contained per-page script, see CLAUDE.md).
//
// One-time snapshot, no recurring schedule — matches the convention every
// full-universe page has used since 2026-09-16. Re-run manually for a
// fresh pass.
//
// Reuses company name/sector from Sector Beeswarm's own weekly meta.json
// blob, same pattern as every other full-universe sweep in this codebase.
// Also does one optional, read-only cross-page read — Relative Strength
// Leaders/Laggards' own 3-month relative return — for this page's "does a
// recently-drifting beta line up with recent relative performance" test,
// with a graceful fallback (the test just doesn't render) if that blob
// isn't populated yet.
//
// ~504 sequential Yahoo fetches (503 constituents + SPY, SPY first) at
// 300ms spacing with a retry pass — same cadence as scheduled-quality-
// lowvol-background.js's own full-universe Yahoo sweep. Yahoo has no
// per-account quota the way Alpha Vantage does, but yahoo-client.js's own
// comments note it 429s intermittently on bulk sequential access, hence
// the pacing and retry pass.

const { getBetaStabilityStore, BLOB_KEY } = require("./beta-stability-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { fetchDailyHistory, sleep } = require("./yahoo-client");

const TARGET_WEEKS = 151; // ~2.9 years of weekly closes -> 150 weekly returns, split 75/75
const MIN_WEEKS = 105; // ~2 years -> 104 returns, min 52 per half; shorter histories are excluded
const LEADERBOARD_COUNT = 15;
const MIN_SECTOR_N = 3;
const MATERIAL_DRIFT = 0.25; // beta points — the methodology's "materially shifted" threshold

function round(v, d = 3) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Monday-of-week key (UTC) for a "YYYY-MM-DD" date string.
function weekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

// [{date, close}] ascending -> Map(weekKey -> last close seen that week).
function toWeeklyCloses(dailyHistory) {
  const byWeek = new Map();
  for (const row of dailyHistory) {
    if (row.close === null || row.close === undefined || !Number.isFinite(row.close) || row.close <= 0) continue;
    byWeek.set(weekKey(row.date), row.close); // ascending input, so the latest day in each week wins
  }
  return byWeek;
}

function olsSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
  return { slope, intercept, r, r2: r === null ? null : r * r, n };
}

// Weekly log-return series for a symbol, restricted to weeks common to
// `spyWeeks`, trimmed to the most recent TARGET_WEEKS closes. Returns null
// if fewer than MIN_WEEKS of common history exist.
function weeklyReturnsAgainstSpy(dailyHistory, spyWeeks) {
  const ownWeeks = toWeeklyCloses(dailyHistory);
  const commonKeys = [...ownWeeks.keys()].filter((k) => spyWeeks.has(k)).sort();
  const trimmed = commonKeys.slice(-TARGET_WEEKS);
  if (trimmed.length < MIN_WEEKS) return null;

  const ownCloses = trimmed.map((k) => ownWeeks.get(k));
  const spyCloses = trimmed.map((k) => spyWeeks.get(k));
  const ownReturns = [], spyReturns = [];
  for (let i = 1; i < trimmed.length; i++) {
    const or = Math.log(ownCloses[i] / ownCloses[i - 1]);
    const sr = Math.log(spyCloses[i] / spyCloses[i - 1]);
    if (Number.isFinite(or) && Number.isFinite(sr)) {
      ownReturns.push(or);
      spyReturns.push(sr);
    }
  }
  if (ownReturns.length < MIN_WEEKS - 1) return null;
  return { ownReturns, spyReturns, weeksUsed: trimmed.length };
}

exports.handler = async () => {
  console.log(`scheduled-beta-stability-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let rel3MBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) if (c.rel3M !== null && c.rel3M !== undefined) rel3MBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-beta-stability-background: could not read relative-strength blob, continuing without the drift-vs-relative-return test:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    // SPY's own weekly closes — fetched once, reused for every constituent.
    let spyWeeks = null;
    for (let attempt = 0; attempt < 3 && !spyWeeks; attempt++) {
      try {
        spyWeeks = toWeeklyCloses(await fetchDailyHistory("SPY"));
      } catch (err) {
        console.error(`scheduled-beta-stability-background: SPY fetch attempt ${attempt + 1} failed: ${err.message}`);
        await sleep(3000);
      }
    }
    if (!spyWeeks || spyWeeks.size < MIN_WEEKS) throw new Error("Could not fetch enough SPY weekly history to compute any beta — aborting rather than writing a benchmark-less snapshot");

    const results = new Map();
    let excludedShortHistory = 0;

    async function fetchInto(symbol) {
      try {
        const daily = await fetchDailyHistory(symbol);
        const wk = weeklyReturnsAgainstSpy(daily, spyWeeks);
        if (!wk) {
          excludedShortHistory++;
          return true; // fetched fine, just not enough common history — not a failure to retry
        }
        const mid = Math.floor(wk.ownReturns.length / 2);
        const older = olsSlope(wk.spyReturns.slice(0, mid), wk.ownReturns.slice(0, mid));
        const recent = olsSlope(wk.spyReturns.slice(mid), wk.ownReturns.slice(mid));
        const full = olsSlope(wk.spyReturns, wk.ownReturns);
        if (!older || !recent || !full) {
          excludedShortHistory++;
          return true; // degenerate variance in a half (e.g. a halted/pinned stock) — excluded, not fabricated
        }
        results.set(symbol, { olderBeta: older.slope, recentBeta: recent.slope, fullBeta: full.slope, fullR2: full.r2, weeksUsed: wk.weeksUsed });
        return true;
      } catch (err) {
        console.error(`scheduled-beta-stability-background: ${symbol} failed: ${err.message}`);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-beta-stability-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(300);
      }
      todo = missed;
    }

    console.log(
      `scheduled-beta-stability-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers ` +
      `(${excludedShortHistory} excluded for insufficient common weekly history)`
    );
    if (results.size === 0) throw new Error("Every ticker failed or was excluded — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, entry] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const drift = entry.recentBeta - entry.olderBeta;
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        olderBeta: round(entry.olderBeta),
        recentBeta: round(entry.recentBeta),
        fullBeta: round(entry.fullBeta),
        fullR2: round(entry.fullR2),
        drift: round(drift),
        weeksUsed: entry.weeksUsed,
        rel3M: rel3MBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with both a usable beta pair and sector metadata");

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianOlderBeta: round(median(inSector.map((c) => c.olderBeta))),
          medianRecentBeta: round(median(inSector.map((c) => c.recentBeta))),
          medianDrift: round(median(inSector.map((c) => c.drift))),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      medianOlderBeta: round(median(companies.map((c) => c.olderBeta))),
      medianRecentBeta: round(median(companies.map((c) => c.recentBeta))),
      medianFullBeta: round(median(companies.map((c) => c.fullBeta))),
      medianDrift: round(median(companies.map((c) => c.drift))),
      pctMaterialDrift: round((companies.filter((c) => Math.abs(c.drift) >= MATERIAL_DRIFT).length / companies.length) * 100, 1),
    };

    const biggestIncrease = [...companies].sort((a, b) => b.drift - a.drift).slice(0, LEADERBOARD_COUNT);
    const biggestDecrease = [...companies].sort((a, b) => a.drift - b.drift).slice(0, LEADERBOARD_COUNT);
    const mostStable = [...companies].sort((a, b) => Math.abs(a.drift) - Math.abs(b.drift)).slice(0, LEADERBOARD_COUNT);

    const persistencePairs = companies.map((c) => ({ x: c.olderBeta, y: c.recentBeta, symbol: c.symbol }));
    const driftVsRel3mPairs = hasRel3M
      ? companies.filter((c) => c.rel3M !== null).map((c) => ({ x: c.drift, y: c.rel3M, symbol: c.symbol }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      excludedShortHistory,
      hasRel3M,
      materialDriftThreshold: MATERIAL_DRIFT,
      targetWeeks: TARGET_WEEKS,
      minWeeks: MIN_WEEKS,
      market,
      sectors,
      biggestIncrease,
      biggestDecrease,
      mostStable,
      persistencePairs,
      driftVsRel3mPairs,
      companies,
    };

    await getBetaStabilityStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-beta-stability-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-beta-stability-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
