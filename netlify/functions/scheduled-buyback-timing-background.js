// Scheduled Background Function (see [functions."scheduled-buyback-timing-
// background"] in netlify.toml) for the "Buyback Timing" page — a fresh,
// off-list idea (per ROUTINE_BRIEF.md's standing permission to propose
// beyond the listed backlog). Every other buyback page on this site asks
// IF a company bought back stock and HOW MUCH (Share Count Trends,
// Shareholder Yield, Buyback Effectiveness). This one asks a genuinely
// different question: WHERE in its own trading range was the stock each
// time the company actually pulled the trigger — near a 52-week low, or
// near a 52-week high — and what happened to the stock over the year that
// followed. "Capital allocation timing skill," not spend or intensity.
//
// Two data sources, on purpose:
//   - Alpha Vantage CASH_FLOW (quarterly), full S&P 500 sweep, same
//     buybackSpendOf() field-quirk handling as scheduled-buyback-
//     effectiveness-background.js (that page's own header comment has the
//     full explanation of why proceedsFromRepurchaseOfEquity, not the
//     more obviously-named fields, is the real signal).
//   - Yahoo Finance daily adjusted closes (fetchDailyHistory, via
//     yahoo-client.js), full S&P 500 + SPY. This page needs several years
//     of daily history per name (a 52-week trailing range as of *each*
//     historical quarter, plus a full year of *forward* data after it) —
//     Alpha Vantage's TIME_SERIES_DAILY_ADJUSTED has no partial-range
//     option (only "compact" ~100 days or "full" = entire multi-decade
//     history), and scheduled-relative-strength-background.js already
//     found that pulling "full" across the whole S&P 500 is disproportionate
//     even for a much shorter lookback than this page needs. Yahoo's
//     chart endpoint returns exactly the years-deep window this page
//     actually uses, free and without Alpha Vantage's rate limit, so the
//     price side of this sweep is on Yahoo (see yahoo-client.js's own
//     header for why this codebase already made that same call for its
//     other full-universe price sweeps).
//
// Both sources are fetched per ticker in the same loop and reduced to a
// small set of computed numbers before being checkpointed — the raw daily
// price arrays themselves (years of daily bars per name) are never written
// to Netlify Blobs, only what survives per company: a dollar-weighted
// average "range percentile at the time of each buyback" and a dollar-
// weighted average forward 1-year excess return following them, plus the
// handful of individual quarter events behind those averages, small enough
// to keep. One-time snapshot, no schedule — matches this file's current
// convention for new full-universe Equities jobs (see scheduled-roic-wacc-
// background.js for the same note). Cash flow comes from the shared
// av-collected store (see av-collector-store.js); prices still come from
// Yahoo per company, so the job keeps its checkpoint/resume.

const { getBuybackTimingStore, BLOB_KEY, CHECKPOINT_KEY } = require("./buyback-timing-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { collectedFor } = require("./av-collector-store");
const { fetchDailyHistory } = require("./yahoo-client");


const QUARTERS_NEEDED = 24; // ~6 years, same depth as scheduled-buyback-effectiveness-background.js
const RANGE_SESSIONS = 252; // ~1 trading year, the standard "52-week" window
const FORWARD_DAYS = 365; // calendar days, not trading sessions — see forwardExcessReturn()
const NOTABLE_COUNT = 15;
const MIN_EVENTS_FOR_STATS = 3; // don't rank a company on 1-2 lucky/unlucky quarters
const MIN_SECTOR_N = 3;
const MIN_TERCILE_N = 15;

const CALL_SLEEP_MS_YAHOO = 300; // same pacing scheduled-relative-strength-background.js uses for Yahoo
const RUN_BUDGET_MS = 12 * 60 * 1000;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field — same gotcha guarded against elsewhere in this codebase.
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Identical convention to scheduled-buyback-effectiveness-background.js's
// own buybackSpendOf() — see that file's header for the full field-quirk
// explanation. Always non-negative, or null on a genuine data gap.
function buybackSpendOf(row) {
  const p = num(row.proceedsFromRepurchaseOfEquity);
  if (p !== null) return p < 0 ? -p : 0;
  const a = num(row.paymentsForRepurchaseOfCommonStock);
  if (a !== null) return Math.abs(a);
  const b = num(row.paymentsForRepurchaseOfEquity);
  if (b !== null) return Math.abs(b);
  return null;
}

function calendarQuarterKey(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

async function fetchQuarterlyCashFlow(apiKey, symbol) {
  const payload = await collectedFor("cashflow", symbol);
  if (!payload) throw new Error(`no shared cashflow data`);
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);
  return rows.slice(0, QUARTERS_NEEDED).map((r) => ({
    fiscalDateEnding: r.fiscalDateEnding,
    buybackSpend: buybackSpendOf(r),
  }));
}

// Largest index i such that dates[i] <= target, or -1 if every date is
// after target. `dates` must be ascending.
function bisectOnOrBefore(dates, target) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function addDaysIso(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Computes, for one company, the list of "timing events" (one per quarter
// with a real repurchase) behind its dollar-weighted averages. `closes` is
// this stock's own ascending [{date, close}] (close already adjusted, per
// fetchDailyHistory's default); `spyDates`/`spyCloseByDate` are SPY's.
function buildTimingEvents(quarters, closes, spyDates, spyCloseByDate) {
  const dates = closes.map((c) => c.date);
  const events = [];

  for (const q of quarters) {
    if (q.buybackSpend === null || q.buybackSpend <= 0) continue;

    const asOfIdx = bisectOnOrBefore(dates, q.fiscalDateEnding);
    if (asOfIdx < RANGE_SESSIONS - 1) continue; // not enough trailing history for a real 52-week range

    const windowSlice = closes.slice(asOfIdx - (RANGE_SESSIONS - 1), asOfIdx + 1);
    const windowCloses = windowSlice.map((c) => c.close);
    const low = Math.min(...windowCloses);
    const high = Math.max(...windowCloses);
    if (!(high > low)) continue; // degenerate (halted/flat) window

    const asOfClose = closes[asOfIdx].close;
    const rangePercentile = clamp(((asOfClose - low) / (high - low)) * 100, 0, 100);
    const asOfDate = dates[asOfIdx];

    let fwdExcessReturn = null;
    const targetDate = addDaysIso(asOfDate, FORWARD_DAYS);
    if (dates[dates.length - 1] >= targetDate && spyDates.length && spyDates[spyDates.length - 1] >= targetDate) {
      const fwdIdx = bisectOnOrBefore(dates, targetDate);
      const stockFwdRet = closes[fwdIdx].close / asOfClose - 1;
      const spyAsOfIdx = bisectOnOrBefore(spyDates, asOfDate);
      const spyFwdIdx = bisectOnOrBefore(spyDates, targetDate);
      if (spyAsOfIdx >= 0 && spyFwdIdx >= 0) {
        const spyAsOfClose = spyCloseByDate.get(spyDates[spyAsOfIdx]);
        const spyFwdClose = spyCloseByDate.get(spyDates[spyFwdIdx]);
        if (spyAsOfClose && spyFwdClose) {
          const spyFwdRet = spyFwdClose / spyAsOfClose - 1;
          // Compounding-consistent excess return, same construction as
          // /small-cap-vs-large-cap, /international-vs-us, /relative-
          // strength-leaders — not a simple subtraction.
          fwdExcessReturn = ((1 + stockFwdRet) / (1 + spyFwdRet) - 1) * 100;
        }
      }
    }

    events.push({
      quarter: calendarQuarterKey(q.fiscalDateEnding),
      fiscalDateEnding: q.fiscalDateEnding,
      spend: q.buybackSpend,
      rangePercentile: round(rangePercentile, 1),
      fwdExcessReturn: fwdExcessReturn !== null ? round(fwdExcessReturn, 2) : null,
    });
  }
  return events;
}

function weightedAvg(events, valueKey, requireValue) {
  const usable = requireValue ? events.filter((e) => e[valueKey] !== null) : events;
  const totalWeight = usable.reduce((s, e) => s + e.spend, 0);
  if (!usable.length || totalWeight <= 0) return null;
  return usable.reduce((s, e) => s + e[valueKey] * e.spend, 0) / totalWeight;
}

exports.handler = async () => {
  console.log(`scheduled-buyback-timing-background: starting, ${BREADTH_CONSTITUENTS.length} tickers + SPY`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmMeta = await getBeeswarmStore().get(META_KEY, { type: "json" });
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};

    // SPY is the benchmark every forward-return figure in this job depends
    // on — fetch it once upfront and abort if it fails, rather than
    // silently computing "excess return" against nothing.
    let spyHistory = null;
    for (let attempt = 0; attempt < 3 && !spyHistory; attempt++) {
      try {
        spyHistory = await fetchDailyHistory("SPY");
      } catch (err) {
        console.error(`scheduled-buyback-timing-background: SPY fetch failed (attempt ${attempt + 1}): ${err.message}`);
        await sleep(5000);
      }
    }
    if (!spyHistory) throw new Error("Could not fetch SPY benchmark history after 3 attempts");
    const spyDates = spyHistory.map((c) => c.date);
    const spyCloseByDate = new Map(spyHistory.map((c) => [c.date, c.close]));

    const store = getBuybackTimingStore();
    const saved = await store.get(CHECKPOINT_KEY, { type: "json" });
    const resume = !!(saved && !saved.complete && Date.now() - Date.parse(saved.startedAt) < CHECKPOINT_MAX_AGE_MS);
    const cycleStartedAt = resume ? saved.startedAt : new Date().toISOString();
    const results = new Map(resume ? Object.entries(saved.results) : []); // symbol -> { ttmBuybackSpend, events }
    if (resume) console.log(`scheduled-buyback-timing-background: resuming checkpoint with ${results.size} ticker(s) already done`);

    const failures = resume ? { ...(saved.failed || {}) } : {};
    const saveCheckpoint = (complete) =>
      store.setJSON(CHECKPOINT_KEY, { startedAt: cycleStartedAt, complete, results: Object.fromEntries(results), failed: failures });

    const startedAt = Date.now();
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchQuarterlyCashFlow(apiKey, symbol);
        if (quarters.length < 4) { results.set(symbol, { ttmBuybackSpend: null, events: [] }); delete failures[symbol]; return true; }

        const last4 = quarters.slice(0, 4);
        const ttmBuybackSpend = last4.every((q) => q.buybackSpend !== null)
          ? Math.round(last4.reduce((s, q) => s + q.buybackSpend, 0))
          : null;

        const closes = await fetchDailyHistory(symbol);
        const events = buildTimingEvents(quarters, closes, spyDates, spyCloseByDate);

        results.set(symbol, { ttmBuybackSpend, events });
        delete failures[symbol];
        return true;
      } catch (err) {
        console.error(`scheduled-buyback-timing-background: ${symbol} failed: ${err.message}`);
        failures[symbol] = String(err.message).slice(0, 200);
        return false;
      }
    }

    let todo = BREADTH_CONSTITUENTS.filter((s) => !results.has(s));
    let stoppedForTime = false;
    let sinceCheckpoint = 0;
    for (let pass = 0; pass < 2 && todo.length && !stoppedForTime; pass++) {
      if (pass > 0) {
        console.log(`scheduled-buyback-timing-background: retry pass for ${todo.length} ticker(s)`);
      }
      const missed = [];
      for (const symbol of todo) {
        if (outOfTime()) { stoppedForTime = true; break; }
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        if (got && ++sinceCheckpoint >= CHECKPOINT_EVERY) { await saveCheckpoint(false); sinceCheckpoint = 0; }
        await sleep(CALL_SLEEP_MS_YAHOO);
      }
      todo = missed;
    }
    await saveCheckpoint(!stoppedForTime);
    if (stoppedForTime) console.log(`scheduled-buyback-timing-background: out of time with ${results.size}/${BREADTH_CONSTITUENTS.length} fetched — run again to finish`);

    console.log(`scheduled-buyback-timing-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, { ttmBuybackSpend, events }] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector || !events.length) continue;

      const weightedAvgRangePercentile = weightedAvg(events, "rangePercentile", false);
      const eventsWithFwd = events.filter((e) => e.fwdExcessReturn !== null);
      const weightedAvgFwdExcessReturn = eventsWithFwd.length ? weightedAvg(eventsWithFwd, "fwdExcessReturn", true) : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        ttmBuybackSpend,
        eventCount: events.length,
        eventsWithFwdCount: eventsWithFwd.length,
        weightedAvgRangePercentile: round(weightedAvgRangePercentile, 1),
        weightedAvgFwdExcessReturn: weightedAvgFwdExcessReturn !== null ? round(weightedAvgFwdExcessReturn, 2) : null,
        events, // kept for the pooled tercile test below, stripped before the final table payload
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable buyback-and-price data and sector metadata");

    const withEnoughEvents = companies.filter((c) => c.eventCount >= MIN_EVENTS_FOR_STATS);

    // ---- Headline scatter: one point per company (avoids pseudo-
    // replicating the same company's quarters), dollar-weighted average
    // range percentile at the time of its buybacks vs. dollar-weighted
    // average forward 1-year excess return that followed them. Pearson/
    // Spearman are computed client-side from this array, same convention
    // as every other page on this site. ----
    const scatter = withEnoughEvents
      .filter((c) => c.weightedAvgFwdExcessReturn !== null)
      .map((c) => ({ symbol: c.symbol, sector: c.sector, x: c.weightedAvgRangePercentile, y: c.weightedAvgFwdExcessReturn, eventCount: c.eventCount }));

    // ---- Pooled tercile test: every individual buyback quarter across the
    // whole S&P 500 (not one row per company), split into thirds by where
    // in the 52-week range that purchase happened. This is a real panel —
    // the same company's quarters appear more than once — so it's reported
    // as a descriptive comparison, not treated as an independent-sample
    // test; the scatter above is the page's actual hypothesis test. ----
    const allEventsWithFwd = companies.flatMap((c) =>
      c.events.filter((e) => e.fwdExcessReturn !== null).map((e) => ({ ...e, symbol: c.symbol, sector: c.sector }))
    );
    const sortedByPct = [...allEventsWithFwd].sort((a, b) => a.rangePercentile - b.rangePercentile);
    const third = Math.floor(sortedByPct.length / 3);
    const tercileGroups = {
      "Bought near lows": sortedByPct.slice(0, third),
      "Bought mid-range": sortedByPct.slice(third, sortedByPct.length - third),
      "Bought near highs": sortedByPct.slice(sortedByPct.length - third),
    };
    const tercileBars = Object.entries(tercileGroups).map(([label, evs]) => ({
      label,
      n: evs.length,
      medianFwdExcessReturn: evs.length >= MIN_TERCILE_N ? round(median(evs.map((e) => e.fwdExcessReturn))) : null,
      meanFwdExcessReturn: evs.length >= MIN_TERCILE_N ? round(mean(evs.map((e) => e.fwdExcessReturn))) : null,
    }));

    // Welch's t-test (unequal variance), low tercile vs. high tercile —
    // same normal-approximation-for-the-p-value simplification every
    // regression's t-stat on this site already uses (see linearRegression()
    // in e.g. /buyback-effectiveness's own inline JS), just applied to a
    // two-group mean comparison instead of a slope.
    const low = tercileGroups["Bought near lows"].map((e) => e.fwdExcessReturn);
    const high = tercileGroups["Bought near highs"].map((e) => e.fwdExcessReturn);
    let welchTest = null;
    if (low.length >= MIN_TERCILE_N && high.length >= MIN_TERCILE_N) {
      const m1 = mean(low), m2 = mean(high);
      const v1 = mean(low.map((x) => (x - m1) ** 2));
      const v2 = mean(high.map((x) => (x - m2) ** 2));
      const se = Math.sqrt(v1 / low.length + v2 / high.length);
      const t = (m1 - m2) / se;
      welchTest = { n1: low.length, n2: high.length, mean1: round(m1), mean2: round(m2), t: round(t, 3), diff: round(m1 - m2) };
    }

    // ---- Sector aggregates (one value per company, median across the
    // sector — same discipline as the scatter above) ----
    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = withEnoughEvents.filter((c) => c.sector === sector);
      if (inSector.length < MIN_SECTOR_N) return null;
      const withFwd = inSector.filter((c) => c.weightedAvgFwdExcessReturn !== null);
      return {
        sector,
        companyCount: inSector.length,
        medianRangePercentileAtBuyback: round(median(inSector.map((c) => c.weightedAvgRangePercentile))),
        medianFwdExcessReturn: withFwd.length >= MIN_SECTOR_N ? round(median(withFwd.map((c) => c.weightedAvgFwdExcessReturn))) : null,
      };
    }).filter(Boolean);

    const market = {
      companyCount: withEnoughEvents.length,
      medianRangePercentileAtBuyback: round(median(withEnoughEvents.map((c) => c.weightedAvgRangePercentile))),
      pctBoughtBelowMidpoint: round((withEnoughEvents.filter((c) => c.weightedAvgRangePercentile < 50).length / withEnoughEvents.length) * 100, 1),
      medianFwdExcessReturn: round(median(scatter.map((s) => s.y))),
    };

    const rankedByPct = [...withEnoughEvents].sort((a, b) => a.weightedAvgRangePercentile - b.weightedAvgRangePercentile);
    const boughtNearLows = rankedByPct.slice(0, NOTABLE_COUNT).map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, weightedAvgRangePercentile: c.weightedAvgRangePercentile, ttmBuybackSpend: c.ttmBuybackSpend }));
    const boughtNearHighs = rankedByPct.slice(-NOTABLE_COUNT).reverse().map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, weightedAvgRangePercentile: c.weightedAvgRangePercentile, ttmBuybackSpend: c.ttmBuybackSpend }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      partial: stoppedForTime,
      market,
      sectors,
      scatter,
      tercileBars,
      welchTest,
      boughtNearLows,
      boughtNearHighs,
      companies: companies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        ttmBuybackSpend: c.ttmBuybackSpend,
        eventCount: c.eventCount,
        weightedAvgRangePercentile: c.weightedAvgRangePercentile,
        weightedAvgFwdExcessReturn: c.weightedAvgFwdExcessReturn,
      })),
    };

    if (stoppedForTime) {
      const published = await store.get(BLOB_KEY, { type: "json" });
      if (published && !published.partial) {
        console.log("scheduled-buyback-timing-background: partial run, keeping the last complete published snapshot until the next run finishes the cycle");
        return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, fetched: results.size, published: false }) };
      }
    }
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-buyback-timing-background: wrote ${companies.length} companies (${withEnoughEvents.length} with enough events for stats) across ${sectors.length} sectors, ${allEventsWithFwd.length} pooled events with a forward return`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial: stoppedForTime, fetched: results.size, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-buyback-timing-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
