// Scheduled Background Function (see [functions."scheduled-putcall-study-
// background"] in netlify.toml): builds the put/call ratio page from the
// snapshots scheduled-putcall-history-background.js collects.
//
// Two parts:
//   - This week's extremes: the S&P 500 members with the highest and lowest
//     full-chain put/call ratio in the latest weekly snapshot, joined to the
//     analyst ratings and price target in the shared Alpha Vantage overview
//     collection and to trailing returns from Yahoo.
//   - The forward-return study: at each completed month-end, members are
//     ranked into deciles by put/call ratio, and each decile's average return
//     over the following 5, 21, 63 and 126 trading days is compared with the
//     S&P 500. Averages are taken across month-ends, and the standard errors
//     use Newey-West weights because the 63- and 126-day windows of
//     consecutive month-ends overlap.
//
// No Alpha Vantage calls: snapshots and ratings come from blobs, prices from
// Yahoo. Returns are total returns (Yahoo adjusted closes) against the S&P
// 500 total return index (^SP500TR), so dividends count on both sides.

const { getPutCallHistoryStore, PROGRESS_KEY, snapshotKey } = require("./putcall-history-blob-store");
const { getPutCallStudyStore, BLOB_KEY } = require("./putcall-study-blob-store");
const { getOptionsPositioningStore, BLOB_KEY: OPTIONS_KEY } = require("./options-positioning-blob-store");
const { DATES } = require("./putcall-history-plan");
const { loadCollected } = require("./av-collector-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { fetchDailyHistory, sleep } = require("./yahoo-client");
const { TICKER_NOW } = require("./putcall-ticker-map");

const HORIZONS = [5, 21, 63, 126];
const MIN_TWO_SIDED = 3;
const TABLE_SIZE = 15;
const INDEX = "^SP500TR";
const HISTORY_START = "2021-06-01";

const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (v, d = 2) => (v === null || v === undefined ? null : round(v * 100, d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function median(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function num(v) {
  if (v === null || v === undefined || v === "" || v === "None" || v === "-") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Mean of a monthly series with a Newey-West (Bartlett) standard error, so
// overlapping forward windows don't overstate significance.
// Fewer months than this and the standard error isn't worth printing.
const MIN_MONTHS_FOR_SE = 12;

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

function consensusOf(o) {
  if (!o) return null;
  const sb = num(o.AnalystRatingStrongBuy) || 0, b = num(o.AnalystRatingBuy) || 0, h = num(o.AnalystRatingHold) || 0;
  const s = num(o.AnalystRatingSell) || 0, ss = num(o.AnalystRatingStrongSell) || 0;
  const total = sb + b + h + s + ss;
  if (!total) return { total: 0 };
  const score = (sb * 5 + b * 4 + h * 3 + s * 2 + ss) / total;
  const label = score >= 4.5 ? "Strong Buy" : score >= 3.5 ? "Buy" : score >= 2.5 ? "Hold" : score >= 1.5 ? "Sell" : "Strong Sell";
  return { strongBuy: sb, buy: b, hold: h, sell: s, strongSell: ss, total, buyPct: round(((sb + b) / total) * 100, 1), score: round(score, 2), label };
}

// date -> close, plus the sorted list of dates, for one symbol.
async function priceSeries(symbol, sinceUnix) {
  const rows = await fetchDailyHistory(symbol, { adjusted: true, sinceUnix });
  const map = new Map(rows.map((r) => [r.date, r.close]));
  return { map, dates: rows.map((r) => r.date), first: rows.length ? rows[0].date : null };
}

function decileGroups(rows) {
  const sorted = rows.slice().sort((a, b) => a.pc - b.pc);
  const n = sorted.length;
  const groups = Array.from({ length: 10 }, () => []);
  sorted.forEach((r, i) => groups[Math.min(9, Math.floor((i * 10) / n))].push(r));
  return groups;
}

exports.handler = async () => {
  const started = Date.now();
  try {
    const hist = getPutCallHistoryStore();
    const progress = (await hist.get(PROGRESS_KEY, { type: "json" })) || {};

    // ---- snapshots -------------------------------------------------------
    const monthEnds = [];
    for (const date of DATES.concat(Object.keys(progress.done || {}).filter((d) => !DATES.includes(d))).sort()) {
      const snap = await hist.get(snapshotKey(date), { type: "json" });
      if (snap && snap.complete) monthEnds.push(snap);
    }
    let current = null;
    if (progress.latestWeekly) {
      const w = await hist.get(snapshotKey(`weekly-${progress.latestWeekly}`), { type: "json" });
      if (w && w.complete) current = { date: w.date, source: "weekly", results: w.results, members: w.members, unavailable: Object.keys(w.unavailable || {}).length };
    }
    if (!current) {
      const op = await getOptionsPositioningStore().get(OPTIONS_KEY, { type: "json" });
      if (op && Array.isArray(op.companies)) {
        const results = {};
        for (const c of op.companies) results[c.symbol] = { pc: c.putCallRatio, twoSided: c.twoSidedExpirations };
        current = { date: (op.generated_at_utc || "").slice(0, 10), source: "options-positioning", results, members: op.universeSize, unavailable: op.universeSize - op.loadedCount };
      }
    }
    if (!current) throw new Error("no current put/call snapshot available");

    let overview = {};
    try { overview = (await loadCollected("overview")).data || {}; } catch (err) { console.error(`putcall-study: overview collection unavailable (${err.message})`); }
    const meta = ((await getBeeswarmStore().get(META_KEY, { type: "json" })) || {}).tickers || {};

    const payload = await buildPayload({ monthEnds, current, overview, meta, monthEndsPlanned: DATES.length });
    await getPutCallStudyStore().setJSON(BLOB_KEY, payload);
    console.log(`putcall-study: ${monthEnds.length} month-ends, ${payload.current.eligible} eligible now, ${payload.priceFailures} price failures, ${Math.round((Date.now() - started) / 1000)}s`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`putcall-study: failed: ${err.message}`);
    return { statusCode: 500 };
  }
};

async function buildPayload({ monthEnds, current, overview, meta, monthEndsPlanned }) {
    // ---- prices ----------------------------------------------------------
    const needed = new Set(Object.keys(current.results));
    for (const snap of monthEnds) for (const [t, r] of Object.entries(snap.results)) if (r.pc !== null && r.twoSided >= MIN_TWO_SIDED) needed.add(t);
    const sinceUnix = Math.floor(Date.parse(HISTORY_START + "T00:00:00Z") / 1000);
    const index = await priceSeries(INDEX, sinceUnix);
    const prices = new Map();
    const priceFailures = {};
    for (const t of needed) {
      const yahoo = TICKER_NOW[t] || t;
      try {
        prices.set(t, await priceSeries(yahoo, sinceUnix));
      } catch (err) {
        priceFailures[t] = err.message.slice(0, 80);
      }
      await sleep(200);
    }

    const tradingDays = index.dates;
    const dayIndex = new Map(tradingDays.map((d, i) => [d, i]));
    function windowReturn(series, from, to) {
      const a = series.map.get(from), b = series.map.get(to);
      return a && b ? b / a - 1 : null;
    }
    function forward(t, date, h) {
      const i = dayIndex.get(date);
      if (i === undefined || i + h >= tradingDays.length) return null;
      const s = prices.get(t);
      // A ticker reused by another company would have no price on the
      // snapshot date, so it drops out here instead of borrowing its returns.
      if (!s || !s.map.has(date)) return null;
      const r = windowReturn(s, date, tradingDays[i + h]);
      const ri = windowReturn(index, date, tradingDays[i + h]);
      return r === null || ri === null ? null : { abs: r, rel: (1 + r) / (1 + ri) - 1 };
    }
    function trailing(t, h) {
      const s = prices.get(t);
      if (!s) return null;
      const end = tradingDays[tradingDays.length - 1];
      const i = tradingDays.length - 1 - h;
      if (i < 0 || !s.map.has(end)) return null;
      const r = windowReturn(s, tradingDays[i], end);
      const ri = windowReturn(index, tradingDays[i], end);
      return r === null || ri === null ? null : { abs: r, rel: (1 + r) / (1 + ri) - 1 };
    }

    // ---- this week's extremes --------------------------------------------
    const eligibleNow = Object.entries(current.results)
      .filter(([, r]) => r.pc !== null && r.twoSided >= MIN_TWO_SIDED)
      .map(([symbol, r]) => ({ symbol, pc: r.pc, twoSided: r.twoSided }));
    const describe = (row) => {
      const o = overview[row.symbol];
      const m = meta[row.symbol] || {};
      const s = prices.get(row.symbol);
      const last = s ? s.map.get(tradingDays[tradingDays.length - 1]) : null;
      const target = o ? num(o.AnalystTargetPrice) : null;
      const out = {
        symbol: row.symbol,
        name: m.name || (o && o.Name) || row.symbol,
        sector: m.sector || (o && o.Sector) || null,
        pc: round(row.pc),
        twoSided: row.twoSided,
        consensus: consensusOf(o),
        targetUpsidePct: target && last ? round((target / last - 1) * 100, 1) : null,
        trailing: {},
      };
      for (const h of HORIZONS) {
        const r = trailing(row.symbol, h);
        out.trailing[h] = r ? { abs: pct(r.abs, 1), rel: pct(r.rel, 1) } : null;
      }
      return out;
    };
    const byPc = eligibleNow.slice().sort((a, b) => b.pc - a.pc);
    const mostBearish = byPc.slice(0, TABLE_SIZE).map(describe);
    const mostBullish = byPc.slice(-TABLE_SIZE).reverse().map(describe);
    const allPcNow = Object.values(current.results).map((r) => r.pc).filter((v) => v !== null);
    const buyPcts = (rows) => rows.map((r) => r.consensus && r.consensus.buyPct).filter(Number.isFinite);
    const allBuy = Object.keys(current.results).map((t) => consensusOf(overview[t])).filter((c) => c && c.total).map((c) => c.buyPct);

    // ---- forward-return study --------------------------------------------
    const perDate = [];
    for (const snap of monthEnds) {
      const rows = Object.entries(snap.results)
        .filter(([, r]) => r.pc !== null && r.twoSided >= MIN_TWO_SIDED)
        .map(([symbol, r]) => ({ symbol, pc: r.pc }));
      const priced = rows.filter((r) => { const s = prices.get(r.symbol); return s && s.map.has(snap.date); });
      const entry = {
        date: snap.date,
        members: snap.members,
        loaded: Object.values(snap.results).filter((r) => r.pc !== null).length,
        unavailable: Object.keys(snap.unavailable || {}).length,
        eligible: rows.length,
        priced: priced.length,
        medianPc: round(median(rows.map((r) => r.pc))),
        deciles: {},
        top15: {},
        bottom15: {},
        all: {},
      };
      if (priced.length >= 50) {
        const groups = decileGroups(priced);
        const byPcDesc = priced.slice().sort((a, b) => b.pc - a.pc);
        for (const h of HORIZONS) {
          const avg = (list, key) => mean(list.map((r) => forward(r.symbol, snap.date, h)).filter(Boolean).map((x) => x[key]));
          // Month-ends too recent for this horizon have no forward window yet.
          if (avg(priced, "rel") === null) continue;
          entry.deciles[h] = groups.map((g) => ({ rel: avg(g, "rel"), abs: avg(g, "abs") }));
          entry.top15[h] = { rel: avg(byPcDesc.slice(0, TABLE_SIZE), "rel"), abs: avg(byPcDesc.slice(0, TABLE_SIZE), "abs") };
          entry.bottom15[h] = { rel: avg(byPcDesc.slice(-TABLE_SIZE), "rel"), abs: avg(byPcDesc.slice(-TABLE_SIZE), "abs") };
          entry.all[h] = { rel: avg(priced, "rel"), abs: avg(priced, "abs") };
        }
      }
      perDate.push(entry);
    }

    const diff = (a, b) => (a && b && Number.isFinite(a.rel) && Number.isFinite(b.rel) ? { rel: a.rel - b.rel, abs: a.abs - b.abs } : null);
    const summarize = (pick) => {
      const out = {};
      for (const h of HORIZONS) {
        const lag = Math.max(0, Math.ceil(h / 21) - 1);
        const rel = perDate.map((d) => pick(d, h)).filter((v) => v && Number.isFinite(v.rel));
        const nw = neweyWest(rel.map((v) => v.rel), lag);
        out[h] = {
          months: rel.length,
          meanRelPct: pct(nw.mean),
          medianRelPct: pct(median(rel.map((v) => v.rel))),
          seRelPct: pct(nw.se),
          tStat: round(nw.t),
          hitRatePct: rel.length ? round((rel.filter((v) => v.rel > 0).length / rel.length) * 100, 1) : null,
          meanAbsPct: pct(mean(rel.map((v) => v.abs))),
        };
      }
      return out;
    };
    const study = {
      months: perDate.filter((d) => Object.keys(d.deciles).length).length,
      bearishDecile: summarize((d, h) => d.deciles[h] && d.deciles[h][9]),
      bullishDecile: summarize((d, h) => d.deciles[h] && d.deciles[h][0]),
      bearish15: summarize((d, h) => d.top15[h]),
      bullish15: summarize((d, h) => d.bottom15[h]),
      allEligible: summarize((d, h) => d.all[h]),
      // Differences within each month-end cancel what every stock shared that
      // month, such as the equal-weight universe trailing the cap-weighted index.
      bearishMinusBullish: summarize((d, h) => d.deciles[h] && diff(d.deciles[h][9], d.deciles[h][0])),
      bearishMinusAll: summarize((d, h) => d.deciles[h] && diff(d.deciles[h][9], d.all[h])),
      bullishMinusAll: summarize((d, h) => d.deciles[h] && diff(d.deciles[h][0], d.all[h])),
      decileCurve: Object.fromEntries(HORIZONS.map((h) => [h, Array.from({ length: 10 }, (_, k) => {
        const v = perDate.map((d) => d.deciles[h] && d.deciles[h][k]).filter((x) => x && Number.isFinite(x.rel));
        return { decile: k + 1, meanRelPct: pct(mean(v.map((x) => x.rel))), months: v.length };
      })])),
    };

    const payload = {
      generated_at_utc: new Date().toISOString(),
      horizons: HORIZONS,
      minTwoSidedExpirations: MIN_TWO_SIDED,
      benchmark: INDEX,
      pricesThrough: tradingDays[tradingDays.length - 1],
      current: {
        date: current.date,
        source: current.source,
        members: current.members,
        loaded: allPcNow.length,
        eligible: eligibleNow.length,
        unavailable: current.unavailable,
        medianPc: round(median(allPcNow)),
        mostBearish,
        mostBullish,
        consensus: {
          medianBuyPctBearish: round(median(buyPcts(mostBearish)), 1),
          medianBuyPctBullish: round(median(buyPcts(mostBullish)), 1),
          medianBuyPctAll: round(median(allBuy), 1),
        },
      },
      study,
      coverage: perDate.map(({ date, members, loaded, unavailable, eligible, priced, medianPc }) => ({ date, members, loaded, unavailable, eligible, priced, medianPc })),
      backfill: { monthEndsPlanned, monthEndsComplete: monthEnds.length },
      priceFailures: Object.keys(priceFailures).length,
    };
    return payload;
}

module.exports.neweyWest = neweyWest;
module.exports.consensusOf = consensusOf;
module.exports.decileGroups = decileGroups;
module.exports.buildPayload = buildPayload;
