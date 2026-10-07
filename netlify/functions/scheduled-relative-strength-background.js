// Scheduled Background Function (see [functions."scheduled-relative-strength-background"]
// in netlify.toml) for the "Relative Strength Leaders/Laggards" page. Sweeps
// Yahoo Finance daily adjusted closes for the S&P 500 (BREADTH_CONSTITUENTS
// plus members removed since the momentum study's live window began), SPY and
// ^SP500TR, then publishes:
//  - each current member's 1M/3M/6M/12-1M return relative to SPY,
//  - this week's entries to and exits from the top and bottom tenth of 3M
//    relative return,
//  - the point-in-time momentum study: relative-strength-history.js holds the
//    month-ends through its STATIC_THROUGH, and this job computes the later
//    month-ends from the same sweep and merges them in.
//
// Closes are kept from 12 months before the first live month-end, since that
// month-end's 12-1M lookback starts there. The window grows by a month each
// month until build_momentum_study.py (Research Data/outperformance-breadth)
// is rerun with newer prices, which moves STATIC_THROUGH forward.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than paying
// for a second OVERVIEW sweep just for labels.
//
// Other jobs read this store: latest.json's companies[].rel3M (quality score,
// options positioning, golden cross and others) and history.json's weekly
// {date, spyPrice, prices} points (52-week-high momentum, RSI reversal), so
// both keep their shapes.

const { getRelativeStrengthStore, LATEST_KEY, HISTORY_KEY } = require("./relative-strength-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const PIT = require("./breadth-pit-history");
const STUDY = require("./relative-strength-history");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { fetchDailyHistory, sleep } = require("./yahoo-client");

const LOOKBACK_1M_DAYS = 21;
const LOOKBACK_3M_DAYS = 63;
const LOOKBACK_6M_DAYS = 126;
const LOOKBACK_12M_DAYS = 252;
const LEADERBOARD_COUNT = 15;
const MAX_HISTORY_WEEKS = 20; // ~5 months of weekly snapshots
const PRICE_WORKERS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

// Study rules, identical to build_momentum_study.py so live month-ends line
// up with the precomputed ones.
const STUDY_LOOKBACKS = { "1": [0, 1], "3": [0, 3], "6": [0, 6], "12-1": [1, 12] }; // [skip, back] months
const STUDY_HORIZONS = [1, 3, 6, 12];
const FRESH_DAYS = 7;
const GAP_DAYS = 14;
const MIN_RANKED = 50;
const MIN_MONTHS_FOR_SE = 12;

const CURRENT_SET = new Set(BREADTH_CONSTITUENTS);
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY_MS;

function round(v, digits = 2) {
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

// Overlapping multi-month holding periods make neighboring months' returns
// correlated, so the standard error uses Newey-West weights with lag =
// horizon in months minus 1 (same function as scheduled-putcall-study-background.js).
function neweyWest(series, lag) {
  const x = series.filter(Number.isFinite);
  const n = x.length;
  if (n < MIN_MONTHS_FOR_SE) return { mean: mean(x), se: null, t: null, n };
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

function isMemberOn(symbol, date) {
  if (date > PIT.MEMBERSHIP_AS_OF) return CURRENT_SET.has(symbol);
  return (PIT.MEMBERSHIP[symbol] || []).some(([s, e]) => s <= date && (e === null || date < e));
}

function membershipEnd(symbol, date) {
  if (date > PIT.MEMBERSHIP_AS_OF) return null;
  const iv = (PIT.MEMBERSHIP[symbol] || []).find(([s, e]) => s <= date && (e === null || date < e));
  return iv ? iv[1] : null;
}

function memberCountOn(date) {
  return date > PIT.MEMBERSHIP_AS_OF
    ? BREADTH_CONSTITUENTS.length
    : Object.keys(PIT.MEMBERSHIP).filter((sym) => isMemberOn(sym, date)).length;
}

function closeOnOrBefore(closes, date) {
  let lo = 0, hi = closes.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid].date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function addMonthEnd(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0)).toISOString().slice(0, 10);
}

// First month-end after STATIC_THROUGH and the date the sweep needs closes from.
const LIVE_FIRST_MONTH_END = addMonthEnd(STUDY.STATIC_THROUGH, 1);
const KEEP_FROM = new Date(Date.parse(addMonthEnd(LIVE_FIRST_MONTH_END, -12)) - 20 * DAY_MS).toISOString().slice(0, 10);

function symbolsToFetch() {
  const removed = Object.entries(PIT.MEMBERSHIP)
    .filter(([sym, ivs]) => !CURRENT_SET.has(sym) && ivs.some(([, e]) => e === null || e > LIVE_FIRST_MONTH_END))
    .map(([sym]) => sym);
  return [...BREADTH_CONSTITUENTS, ...removed];
}

// Compounding-consistent excess return: (1+stock)/(1+benchmark) - 1, in
// percentage points. Simple subtraction misstates larger moves.
function relativeReturn(stockRet, benchRet) {
  if (stockRet === null || benchRet === null) return null;
  return ((1 + stockRet) / (1 + benchRet) - 1) * 100;
}

// Return between two benchmark-calendar dates for one stock, or null when the
// stock has no close within FRESH_DAYS of either date.
function windowReturn(closes, fromDate, toDate) {
  const a = closeOnOrBefore(closes, fromDate);
  const b = closeOnOrBefore(closes, toDate);
  if (a < 0 || b < 0) return null;
  if (daysBetween(closes[a].date, fromDate) > FRESH_DAYS || daysBetween(closes[b].date, toDate) > FRESH_DAYS) return null;
  if (!(closes[a].close > 0)) return null;
  return closes[b].close / closes[a].close - 1;
}

// Tenth 1..10 for each name, 10 = highest value. Same rule as the offline
// script: sort ascending (ties by symbol), tenth = floor(k * 10 / n) + 1.
function assignTenths(valueBySymbol) {
  const names = Object.keys(valueBySymbol).sort((a, b) => valueBySymbol[a] - valueBySymbol[b] || (a < b ? -1 : 1));
  const n = names.length;
  const out = {};
  names.forEach((s, k) => { out[s] = Math.floor((k * 10) / n) + 1; });
  return { tenths: out, n };
}

// One formation month-end of the study, computed on the members that day.
function studyFormation(i, monthEnds, indexAtMonthEnd, closesBySymbol) {
  const M = monthEnds[i];
  const fresh = (closes, k) => {
    const p = closeOnOrBefore(closes, monthEnds[k]);
    return p >= 0 && daysBetween(closes[p].date, monthEnds[k]) <= FRESH_DAYS ? closes[p].close : null;
  };
  const have = [];
  for (const [symbol, closes] of closesBySymbol.entries()) {
    if (!isMemberOn(symbol, M)) continue;
    const p0 = fresh(closes, i);
    if (p0 > 0) have.push({ symbol, closes, p0 });
  }
  const out = { date: M, members: memberCountOn(M), n: {}, res: {} };

  const forward = {};
  for (const h of STUDY_HORIZONS) {
    const j = i + h;
    if (j >= monthEnds.length) continue;
    const bench = indexAtMonthEnd[j] / indexAtMonthEnd[i] - 1;
    const E = monthEnds[j];
    const vals = {};
    for (const { symbol, closes, p0 } of have) {
      const end = membershipEnd(symbol, M);
      const need = end && end < E ? end : E;
      // History that stops while the stock was still a member is a data gap,
      // not a delisting the holding period should absorb.
      if (daysBetween(closes[closes.length - 1].date, need) > GAP_DAYS) continue;
      const pj = closes[closeOnOrBefore(closes, E)].close;
      vals[symbol] = relativeReturn(pj / p0 - 1, bench);
    }
    forward[h] = vals;
  }

  for (const [L, [skip, back]] of Object.entries(STUDY_LOOKBACKS)) {
    const a = i - back, b = i - skip;
    if (a < 0) continue;
    const lb = {};
    for (const { symbol, closes } of have) {
      const pa = fresh(closes, a), pb = fresh(closes, b);
      if (pa > 0 && pb > 0) lb[symbol] = pb / pa - 1;
    }
    const { tenths, n } = assignTenths(lb);
    out.n[L] = n;
    if (n < MIN_RANKED) continue;
    out.res[L] = {};
    for (const [h, vals] of Object.entries(forward)) {
      const groups = Array.from({ length: 10 }, () => []);
      for (const [symbol, d] of Object.entries(tenths)) if (symbol in vals) groups[d - 1].push(vals[symbol]);
      const all = groups.flat();
      if (!all.length || !groups[0].length || !groups[9].length) continue;
      out.res[L][h] = { dec: groups.map((g) => mean(g)), all: mean(all), n: all.length };
    }
  }
  return out;
}

function liveStudyRows(indexCloses, closesBySymbol) {
  const lastDate = indexCloses[indexCloses.length - 1].date;
  const byMonth = new Map();
  for (const row of indexCloses) byMonth.set(row.date.slice(0, 7), row);
  // Only complete months: the current month's last close isn't its month-end yet.
  const monthRows = [...byMonth.values()].filter((r) => r.date.slice(0, 7) < lastDate.slice(0, 7));
  const monthEnds = monthRows.map((r) => r.date);
  const indexAtMonthEnd = monthRows.map((r) => r.close);
  const rows = [];
  for (let i = 0; i < monthEnds.length; i++) {
    if (monthEnds[i] <= STUDY.STATIC_THROUGH) continue;
    // A formation month-end with no complete horizon yet adds nothing.
    if (i + 1 >= monthEnds.length) continue;
    rows.push(studyFormation(i, monthEnds, indexAtMonthEnd, closesBySymbol));
  }
  return rows;
}

// Precomputed month-ends plus the live ones, reduced to what the page shows.
function buildStudy(liveRows) {
  const months = [...STUDY.MONTHS, ...liveRows.map((r) => r.date)];
  const holdingMonth = (d) => addMonthEnd(d, 1).slice(0, 7);
  const summary = {}, deciles = {}, spreads = { months: months.map(holdingMonth) };
  for (const L of STUDY.LOOKBACKS) {
    summary[L] = {};
    deciles[L] = {};
    for (const h of STUDY.HORIZONS) {
      const st = STUDY.SERIES[L][String(h)];
      const top = [...st.top], bot = [...st.bot], all = [...st.all];
      const decSum = STUDY.DECILES[L][String(h)].mean.map((m) => m * STUDY.DECILES[L][String(h)].months);
      let decMonths = STUDY.DECILES[L][String(h)].months;
      for (const r of liveRows) {
        const x = r.res[L] && r.res[L][h];
        top.push(x ? x.dec[9] : null);
        bot.push(x ? x.dec[0] : null);
        all.push(x ? x.all : null);
        if (x) { x.dec.forEach((v, k) => { decSum[k] += v; }); decMonths++; }
      }
      const tb = [], ta = [];
      top.forEach((v, k) => {
        if (v === null || bot[k] === null || all[k] === null) return;
        tb.push(v - bot[k]);
        ta.push(v - all[k]);
      });
      const nwTb = neweyWest(tb, h - 1), nwTa = neweyWest(ta, h - 1);
      const withData = top.map((v, k) => k).filter((k) => top[k] !== null && bot[k] !== null);
      summary[L][h] = {
        months: tb.length,
        firstMonth: withData.length ? months[withData[0]] : null,
        lastMonth: withData.length ? months[withData[withData.length - 1]] : null,
        top: round(mean(top)),
        bottom: round(mean(bot)),
        all: round(mean(all)),
        topMinusBottom: { mean: round(nwTb.mean), t: round(nwTb.t) },
        topMinusAll: { mean: round(nwTa.mean), t: round(nwTa.t) },
      };
      deciles[L][h] = decSum.map((s) => round(s / decMonths));
      if (h === 1) spreads[L] = top.map((v, k) => (v === null || bot[k] === null ? null : round(v - bot[k])));
    }
  }
  const coverage = {
    dates: months,
    members: [...STUDY.COVERAGE.map((c) => c[0]), ...liveRows.map((r) => r.members)],
    ranked: Object.fromEntries(STUDY.LOOKBACKS.map((L, li) => [L, [...STUDY.COVERAGE.map((c) => c[li + 1]), ...liveRows.map((r) => r.n[L] || 0)]])),
  };
  return {
    firstFormation: STUDY.MONTHS[0],
    staticThrough: STUDY.STATIC_THROUGH,
    lastFormation: months[months.length - 1],
    liveMonths: liveRows.length,
    lookbacks: STUDY.LOOKBACKS,
    horizons: STUDY.HORIZONS,
    summary,
    deciles,
    spreads,
    coverage,
  };
}

async function fetchAll(symbols, sinceUnix) {
  const results = new Map();
  const failed = [];
  const queue = [...symbols];
  const worker = async () => {
    while (queue.length) {
      const symbol = queue.shift();
      try {
        const closes = await fetchDailyHistory(symbol, { adjusted: true, sinceUnix });
        results.set(symbol, closes.filter((c) => c.date >= KEEP_FROM));
      } catch (err) {
        failed.push(symbol);
      }
      await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: PRICE_WORKERS }, worker));
  return { results, failed };
}

exports.handler = async () => {
  const startedAt = Date.now();
  const symbols = symbolsToFetch();
  console.log(`scheduled-relative-strength-background: starting, ${symbols.length} symbols (${BREADTH_CONSTITUENTS.length} current members) + SPY, ^SP500TR, closes from ${KEEP_FROM}`);
  try {
    const sinceUnix = Math.floor(Date.parse(KEEP_FROM) / 1000);

    // SPY is the benchmark every current number depends on, so the run stops
    // without it instead of computing "relative" returns against nothing.
    let spyCloses = null;
    for (let attempt = 0; attempt < 3 && !spyCloses; attempt++) {
      try {
        spyCloses = (await fetchDailyHistory("SPY", { adjusted: true, sinceUnix })).filter((c) => c.date >= KEEP_FROM);
      } catch (err) {
        console.error(`scheduled-relative-strength-background: SPY fetch failed (attempt ${attempt + 1}): ${err.message}`);
        await sleep(5000);
      }
    }
    if (!spyCloses) throw new Error("Could not fetch SPY benchmark data after 3 attempts");

    let indexCloses = null;
    try {
      indexCloses = await fetchDailyHistory("^SP500TR", { adjusted: false, sinceUnix });
    } catch (err) {
      console.error(`scheduled-relative-strength-background: ^SP500TR fetch failed, publishing the precomputed study only: ${err.message}`);
    }

    const { results, failed } = await fetchAll(symbols, sinceUnix);
    // Former members that were acquired are gone from Yahoo, so only current
    // members get a retry pass.
    const retry = failed.filter((s) => CURRENT_SET.has(s));
    if (retry.length) {
      console.log(`scheduled-relative-strength-background: retry pass for ${retry.length} ticker(s)`);
      await sleep(30000);
      const again = await fetchAll(retry, sinceUnix);
      for (const [s, c] of again.results) results.set(s, c);
      if (again.failed.length) console.error(`scheduled-relative-strength-background: still failing: ${again.failed.join(", ")}`);
    }
    console.log(`scheduled-relative-strength-background: fetched ${results.size}/${symbols.length} in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    // ---- Current relative strength, on SPY's trading calendar ----
    const spyAt = (back, endIdx = spyCloses.length - 1) => (endIdx - back >= 0 ? spyCloses[endIdx - back] : null);
    const latestDate = spyCloses[spyCloses.length - 1].date;
    const spyPrice = spyCloses[spyCloses.length - 1].close;
    const relOver = (closes, fromRow, toRow) => {
      if (!fromRow || !toRow) return null;
      const r = windowReturn(closes, fromRow.date, toRow.date);
      return relativeReturn(r, toRow.close / fromRow.close - 1);
    };
    const rawOver = (closes, fromRow, toRow) => (fromRow && toRow ? windowReturn(closes, fromRow.date, toRow.date) : null);

    // Same 3M measure a week earlier, for this week's entries to and exits
    // from the top and bottom tenth. Computed from this sweep's prices so it
    // works on the first run and isn't skewed by dividend re-adjustment
    // between two stored snapshots.
    const weekAgoTarget = new Date(Date.parse(latestDate) - 7 * DAY_MS).toISOString().slice(0, 10);
    const weekAgoIdx = closeOnOrBefore(spyCloses, weekAgoTarget);
    const weekAgoDate = weekAgoIdx >= 0 ? spyCloses[weekAgoIdx].date : null;

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const companies = [];
    const prevRel3M = {};
    for (const symbol of BREADTH_CONSTITUENTS) {
      const closes = results.get(symbol);
      if (!closes || closes.length < LOOKBACK_1M_DAYS + 1) continue;
      if (daysBetween(closes[closes.length - 1].date, latestDate) > FRESH_DAYS) continue;
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const now = spyAt(0);
      const ret1M = rawOver(closes, spyAt(LOOKBACK_1M_DAYS), now);
      const ret3M = rawOver(closes, spyAt(LOOKBACK_3M_DAYS), now);
      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        price: round(closes[closes.length - 1].close),
        ret1M: round(ret1M !== null ? ret1M * 100 : null),
        ret3M: round(ret3M !== null ? ret3M * 100 : null),
        rel1M: round(relOver(closes, spyAt(LOOKBACK_1M_DAYS), now)),
        rel3M: round(relOver(closes, spyAt(LOOKBACK_3M_DAYS), now)),
        rel6M: round(relOver(closes, spyAt(LOOKBACK_6M_DAYS), now)),
        rel12_1M: round(relOver(closes, spyAt(LOOKBACK_12M_DAYS), spyAt(LOOKBACK_1M_DAYS))),
      });
      if (weekAgoIdx >= 0) {
        const v = relOver(closes, spyAt(LOOKBACK_3M_DAYS, weekAgoIdx), spyCloses[weekAgoIdx]);
        if (v !== null) prevRel3M[symbol] = v;
      }
    }

    // Rank by 3-month relative return, best first (1 = strongest leader).
    const ranked = companies.filter((c) => c.rel3M !== null).sort((a, b) => b.rel3M - a.rel3M);
    ranked.forEach((c, i) => { c.rank3M = i + 1; });
    const unranked = companies.filter((c) => c.rel3M === null);
    unranked.forEach((c) => { c.rank3M = null; });

    const n = ranked.length;
    const leaderCut = Math.max(1, Math.round(n * 0.2));
    ranked.forEach((c) => {
      if (c.rank3M <= leaderCut) c.classification = "Leader";
      else if (c.rank3M > n - leaderCut) c.classification = "Laggard";
      else c.classification = "Neutral";
    });
    unranked.forEach((c) => { c.classification = null; });
    const allCompanies = [...ranked, ...unranked];

    // ---- This week's changes in the top and bottom tenth ----
    const nowTenths = assignTenths(Object.fromEntries(ranked.map((c) => [c.symbol, c.rel3M]))).tenths;
    const prevTenths = assignTenths(prevRel3M).tenths;
    const prevRank = {};
    Object.keys(prevRel3M).sort((a, b) => prevRel3M[b] - prevRel3M[a]).forEach((s, i) => { prevRank[s] = i + 1; });
    const changeRow = (c) => ({
      symbol: c.symbol, name: c.name, sector: c.sector,
      rank3M: c.rank3M, prevRank3M: prevRank[c.symbol] || null,
      rel1M: c.rel1M, rel3M: c.rel3M, rel6M: c.rel6M, rel12_1M: c.rel12_1M,
    });
    const tenthChanges = (tenth) => {
      const both = ranked.filter((c) => prevTenths[c.symbol] !== undefined);
      return {
        entered: both.filter((c) => nowTenths[c.symbol] === tenth && prevTenths[c.symbol] !== tenth).map(changeRow),
        left: both.filter((c) => nowTenths[c.symbol] !== tenth && prevTenths[c.symbol] === tenth).map(changeRow),
      };
    };
    const weeklyChanges = weekAgoDate
      ? {
          asOf: latestDate,
          weekAgo: weekAgoDate,
          comparedCount: ranked.filter((c) => prevTenths[c.symbol] !== undefined).length,
          top: tenthChanges(10),
          bottom: tenthChanges(1),
        }
      : null;

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = ranked.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          avgRel1M: round(mean(inSector.map((c) => c.rel1M))),
          avgRel3M: round(mean(inSector.map((c) => c.rel3M))),
          leaderCount: inSector.filter((c) => c.classification === "Leader").length,
          laggardCount: inSector.filter((c) => c.classification === "Laggard").length,
        };
      })
      .filter(Boolean);

    const spyRetPct = (back) => {
      const a = spyAt(back), b = spyAt(0);
      return a && b ? round((b.close / a.close - 1) * 100) : null;
    };
    const market = {
      companyCount: n,
      avgRel1M: round(mean(ranked.map((c) => c.rel1M))),
      avgRel3M: round(mean(ranked.map((c) => c.rel3M))),
      medianRel3M: round(median(ranked.map((c) => c.rel3M))),
      pctOutperforming3M: round(n ? (ranked.filter((c) => c.rel3M > 0).length / n) * 100 : null, 1),
      spyRet1M: spyRetPct(LOOKBACK_1M_DAYS),
      spyRet3M: spyRetPct(LOOKBACK_3M_DAYS),
      spyRet6M: spyRetPct(LOOKBACK_6M_DAYS),
    };

    const leaders = ranked.slice(0, LEADERBOARD_COUNT);
    const laggards = ranked.slice(-LEADERBOARD_COUNT).reverse();

    // ---- Momentum study ----
    let liveRows = [];
    if (indexCloses && indexCloses.length) {
      liveRows = liveStudyRows(indexCloses.filter((c) => c.date >= KEEP_FROM), results);
    }
    const study = buildStudy(liveRows);

    // ---- Weekly snapshot (read by the 52-week-high and RSI reversal jobs) ----
    const store = getRelativeStrengthStore();
    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];
    const generatedAt = new Date().toISOString();
    const todayDate = generatedAt.slice(0, 10);
    const prices = {};
    const rel3mRank = {};
    ranked.forEach((c) => { prices[c.symbol] = c.price; rel3mRank[c.symbol] = c.rank3M; });
    // One point per Monday-to-Sunday week, so an off-schedule re-run replaces
    // that week's snapshot instead of adding a one-day "week".
    const weekOf = (d) => {
      const t = new Date(d + "T00:00:00Z");
      t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
      return t.toISOString().slice(0, 10);
    };
    const filtered = points.filter((p) => weekOf(p.date) !== weekOf(todayDate));
    filtered.push({ date: todayDate, spyPrice: round(spyPrice), prices, rel3mRank });
    const trimmedPoints = filtered.slice(-MAX_HISTORY_WEEKS);
    await store.setJSON(HISTORY_KEY, { points: trimmedPoints });

    const latest = {
      generated_at_utc: generatedAt,
      priceAsOf: latestDate,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: BREADTH_CONSTITUENTS.filter((s) => results.has(s)).length,
      market,
      sectors,
      leaders,
      laggards,
      weeklyChanges,
      study,
      companies: allCompanies.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        price: c.price,
        ret1M: c.ret1M,
        ret3M: c.ret3M,
        rel1M: c.rel1M,
        rel3M: c.rel3M,
        rel6M: c.rel6M,
        rel12_1M: c.rel12_1M,
        rank3M: c.rank3M,
        classification: c.classification,
      })),
    };
    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-relative-strength-background: done in ${Math.round((Date.now() - startedAt) / 1000)}s, ` +
      `${latest.loadedCount}/${BREADTH_CONSTITUENTS.length} current members, ${liveRows.length} live study month-end(s) after ${STUDY.STATIC_THROUGH}`
    );
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("scheduled-relative-strength-background: failed", err);
    return { statusCode: 500, body: err.message };
  }
};
