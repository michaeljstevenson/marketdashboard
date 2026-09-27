// Scheduled Background Function (see [functions."scheduled-momentum-crash-
// risk-background"] in netlify.toml) for the "Momentum Tail Risk" page —
// a fresh, off-list idea (per ROUTINE_BRIEF.md's standing permission to
// propose beyond the listed backlog). Relative Strength Leaders/Laggards
// already asks whether momentum persists on average (does last quarter's
// rank predict next quarter's forward return). This page asks a different,
// well-documented question from the academic momentum literature (Daniel &
// Moskowitz, "Momentum Crashes," 2016): does chasing the strongest
// momentum names carry more downside tail risk than the average forward
// return alone would suggest — not "does momentum pay on average" but
// "what does the full distribution of outcomes look like."
//
// Retrospective decile backtest, not a forward-accumulating cold-start
// page: every S&P 500 constituent's full daily price history already
// contains everything needed to reconstruct ~24 months of monthly
// momentum-decile rebalances and their outcomes in one pass, so this page
// has real historical depth from its very first run (unlike the several
// "needs a few weeks of real snapshots" pages elsewhere on this site).
//
// Single data source: Yahoo Finance daily adjusted closes (fetchDailyHistory,
// via yahoo-client.js), full S&P 500 + SPY, ~503 sequential calls at 300ms
// spacing (same pacing scheduled-relative-strength-background.js uses) —
// no Alpha Vantage calls at all. Trimmed to the trailing ~800 sessions per
// ticker before any computation, and only the small decile-level
// aggregates (never the raw daily arrays) are written to Netlify Blobs.

const { getMomentumCrashRiskStore, BLOB_KEY } = require("./momentum-crash-risk-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { fetchDailyHistory } = require("./yahoo-client");

const TRIM_SESSIONS = 800; // ~3.1 years — enough for a 252-session lookback plus ~25 monthly rebalance points
const LOOKBACK_SESSIONS = 252; // ~12 months, the standard momentum-literature window
const MONTHS_USED = 24; // trailing rebalance-to-rebalance transitions used for the backtest
const DECILE_COUNT = 10;
const CRASH_THRESHOLD = -10; // % — a monthly relative return worse than this counts as a "crash" observation
const MIN_TICKERS_PER_MONTH = 150; // don't cross-sectionally rank a month with too thin a cross-section

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Largest index i such that dates[i] <= target, or -1 if every date is
// after target. `dates` must be ascending. Same helper as scheduled-
// buyback-timing-background.js's own bisectOnOrBefore().
function bisectOnOrBefore(dates, target) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// Indices of the last trading day of each calendar month within an
// ascending [{date, close}] series.
function monthEndIndices(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const isLast = i === bars.length - 1;
    if (isLast || bars[i].date.slice(0, 7) !== bars[i + 1].date.slice(0, 7)) out.push(i);
  }
  return out;
}

exports.handler = async () => {
  console.log(`scheduled-momentum-crash-risk-background: starting, ${BREADTH_CONSTITUENTS.length} tickers + SPY`);
  try {
    const beeswarmMeta = await getBeeswarmStore().get(META_KEY, { type: "json" });
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};

    let spyBars = null;
    for (let attempt = 0; attempt < 3 && !spyBars; attempt++) {
      try {
        spyBars = (await fetchDailyHistory("SPY")).slice(-TRIM_SESSIONS);
      } catch (err) {
        console.error(`scheduled-momentum-crash-risk-background: SPY fetch failed (attempt ${attempt + 1}): ${err.message}`);
        await sleep(5000);
      }
    }
    if (!spyBars) throw new Error("Could not fetch SPY benchmark history after 3 attempts");
    await sleep(300);
    const spyDates = spyBars.map((b) => b.date);
    const spyCloseByDate = new Map(spyBars.map((b) => [b.date, b.close]));

    const results = new Map(); // symbol -> trimmed bars

    async function fetchInto(symbol) {
      try {
        const bars = (await fetchDailyHistory(symbol)).slice(-TRIM_SESSIONS);
        if (bars.length >= LOOKBACK_SESSIONS + 21) results.set(symbol, bars); // needs at least one real rebalance
        return true;
      } catch (err) {
        console.error(`scheduled-momentum-crash-risk-background: ${symbol} failed: ${err.message}`);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-momentum-crash-risk-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(20000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(300);
      }
      todo = missed;
    }

    console.log(`scheduled-momentum-crash-risk-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed. Refusing to write an empty snapshot");

    // ---- Build each ticker's own rebalance records: trailing-12-month
    // momentum as of each of its last (MONTHS_USED+1) month-ends, and the
    // relative return (vs. SPY) to the NEXT month-end. The final month-end
    // is kept as a "current" record with forwardRelReturn left null (not
    // enough time has passed yet) rather than dropped, so the full table
    // can show where every stock ranks as of today, not just its history. ----
    const recordsByMonth = new Map(); // monthKey -> [{ symbol, trailing12M, fwdRelReturn }]
    const currentByMonth = new Map(); // monthKey -> [{ symbol, trailing12M }]  (unpaired, most-recent month only)
    let latestMonthKey = null;

    for (const [symbol, bars] of results.entries()) {
      const meAll = monthEndIndices(bars);
      const me = meAll.slice(-(MONTHS_USED + 1));
      if (me.length < 2) continue;

      for (let k = 0; k < me.length - 1; k++) {
        const m = me[k];
        const next = me[k + 1];
        if (m < LOOKBACK_SESSIONS) continue;
        const trailing12M = (bars[m].close / bars[m - LOOKBACK_SESSIONS].close - 1) * 100;
        const monthKey = bars[m].date.slice(0, 7);

        // Date-aligned SPY lookup — nearest SPY trading day on or before
        // each of this ticker's own month-end dates (guards against the
        // rare case where a ticker's own calendar has a day SPY doesn't).
        const spyMIdx = bisectOnOrBefore(spyDates, bars[m].date);
        const spyNextIdx = bisectOnOrBefore(spyDates, bars[next].date);
        let fwdRelReturn = null;
        if (spyMIdx >= 0 && spyNextIdx >= 0) {
          const spyAtM = spyCloseByDate.get(spyDates[spyMIdx]);
          const spyAtNext = spyCloseByDate.get(spyDates[spyNextIdx]);
          const stockFwd = bars[next].close / bars[m].close - 1;
          const spyFwd = spyAtNext / spyAtM - 1;
          fwdRelReturn = ((1 + stockFwd) / (1 + spyFwd) - 1) * 100;
        }

        const arr = recordsByMonth.get(monthKey) || [];
        arr.push({ symbol, trailing12M, fwdRelReturn });
        recordsByMonth.set(monthKey, arr);
      }

      // Unpaired "current" record at the true latest month-end.
      const lastIdx = me[me.length - 1];
      if (lastIdx >= LOOKBACK_SESSIONS) {
        const trailing12M = (bars[lastIdx].close / bars[lastIdx - LOOKBACK_SESSIONS].close - 1) * 100;
        const monthKey = bars[lastIdx].date.slice(0, 7);
        const arr = currentByMonth.get(monthKey) || [];
        arr.push({ symbol, trailing12M });
        currentByMonth.set(monthKey, arr);
        if (!latestMonthKey || monthKey > latestMonthKey) latestMonthKey = monthKey;
      }
    }

    // ---- Cross-sectional decile assignment, one calendar month at a time
    // (never pooling raw company-quarters into one giant panel without
    // first ranking within their own month — the same discipline as every
    // other page's regime/quarter aggregation on this site). ----
    const decileObservations = Array.from({ length: DECILE_COUNT }, () => []); // [decile-1] -> [fwdRelReturn, ...]
    const spreadByMonth = [];

    for (const [monthKey, arr] of [...recordsByMonth.entries()].sort()) {
      if (arr.length < MIN_TICKERS_PER_MONTH) continue;
      const withFwd = arr.filter((r) => r.fwdRelReturn !== null);
      if (withFwd.length < MIN_TICKERS_PER_MONTH) continue;
      const sorted = [...withFwd].sort((a, b) => a.trailing12M - b.trailing12M);
      const n = sorted.length;
      sorted.forEach((r, i) => {
        const decile = Math.min(DECILE_COUNT - 1, Math.floor((i / n) * DECILE_COUNT));
        decileObservations[decile].push(r.fwdRelReturn);
      });
      const bottomN = Math.max(1, Math.floor(n / DECILE_COUNT));
      const bottom = mean(sorted.slice(0, bottomN).map((r) => r.fwdRelReturn));
      const top = mean(sorted.slice(-bottomN).map((r) => r.fwdRelReturn));
      spreadByMonth.push({ month: monthKey, spread: round(top - bottom), n });
    }

    const decileStats = decileObservations.map((obs, i) => {
      const crashN = obs.filter((x) => x < CRASH_THRESHOLD).length;
      return {
        decile: i + 1,
        label: i === 0 ? "1 (Losers)" : i === DECILE_COUNT - 1 ? "10 (Winners)" : String(i + 1),
        n: obs.length,
        avgFwdRelReturn: round(mean(obs)),
        medianFwdRelReturn: round(median(obs)),
        crashRatePct: obs.length ? round((crashN / obs.length) * 100, 1) : null,
        crashN,
      };
    });

    // ---- Two-proportion z-test: winners' crash rate vs. losers', and
    // winners vs. the two middle deciles pooled — same test family as
    // /earnings-surprise's own beat-rate-persistence test. ----
    function twoPropZTest(n1, x1, n2, x2) {
      const p1 = x1 / n1, p2 = x2 / n2;
      const pPool = (x1 + x2) / (n1 + n2);
      const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
      const z = se > 0 ? (p1 - p2) / se : null;
      const p = z === null ? null : 2 * (1 - normalCdf(Math.abs(z)));
      return { n1, n2, rate1: round(p1 * 100, 1), rate2: round(p2 * 100, 1), z: z === null ? null : round(z, 3), p: p === null ? null : round(p, 4) };
    }
    function normalCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
    function erf(x) {
      const sign = x < 0 ? -1 : 1; x = Math.abs(x);
      const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
      const t = 1 / (1 + p * x);
      const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
      return sign * y;
    }

    const winners = decileStats[DECILE_COUNT - 1];
    const losers = decileStats[0];
    const middle = { n: decileStats[4].n + decileStats[5].n, crashN: decileStats[4].crashN + decileStats[5].crashN };
    const winnersVsLosers = winners.n && losers.n ? twoPropZTest(winners.n, winners.crashN, losers.n, losers.crashN) : null;
    const winnersVsMiddle = winners.n && middle.n ? twoPropZTest(winners.n, winners.crashN, middle.n, middle.crashN) : null;

    // ---- Current snapshot: latest month's decile assignment per ticker,
    // for the full sortable table. ----
    const currentArr = latestMonthKey ? currentByMonth.get(latestMonthKey) || [] : [];
    const currentSorted = [...currentArr].sort((a, b) => a.trailing12M - b.trailing12M);
    const nCur = currentSorted.length;
    const companies = currentSorted.map((r, i) => {
      const m = metaTickers[r.symbol];
      const decile = nCur ? Math.min(DECILE_COUNT - 1, Math.floor((i / nCur) * DECILE_COUNT)) + 1 : null;
      return {
        symbol: r.symbol,
        name: (m && m.name) || r.symbol,
        sector: (m && m.sector) || null,
        trailing12M: round(r.trailing12M),
        decile,
      };
    });

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      latestMonthKey,
      monthsUsed: [...recordsByMonth.keys()].filter((k) => recordsByMonth.get(k).length >= MIN_TICKERS_PER_MONTH).length,
      decileStats,
      spreadByMonth,
      winnersVsLosers,
      winnersVsMiddle,
      companies,
    };

    await getMomentumCrashRiskStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-momentum-crash-risk-background: wrote ${decileStats.reduce((s, d) => s + d.n, 0)} pooled decile-month observations across ${payload.monthsUsed} months, ${companies.length} companies in the current snapshot`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, fetched: results.size, months: payload.monthsUsed, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-momentum-crash-risk-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
