// Scheduled Background Function (see [functions."scheduled-short-interest-
// background"] in netlify.toml): FINRA short interest for the Short Sale
// Volume page.
//
// FINRA publishes every listed stock's short interest twice a month as free
// pipe-delimited files (cdn.finra.org/equity/otcmarket/biweekly/), covering
// exchange-listed stocks from the 06/15/2021 settlement on. Each run collects
// any settlement dates it hasn't stored yet, keeping only past and present
// S&P 500 members, then rebuilds the page payload when something new arrived
// or the last build is a week old:
//   - the latest short interest as a share of shares outstanding, days to
//     cover and the change from the previous settlement, by stock and sector
//   - median days to cover at each settlement date
//   - whether the stocks with the most days to cover lagged afterward: at each
//     settlement date, members are split into tenths by days to cover and
//     each tenth's later return is compared with the S&P 500 total return
//     index. Returns start 10 trading days after the settlement date, after
//     FINRA has published it, so the test only uses figures that were public.
//
// No Alpha Vantage calls: shares outstanding come from the shared overview
// collection, prices from Yahoo.

const { getShortInterestStore, INDEX_KEY, LATEST_KEY, dateKey } = require("./short-interest-blob-store");
const { DATES: PLAN_DATES, MEMBERS } = require("./putcall-history-plan");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { loadCollected } = require("./av-collector-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getShortSaleVolumeStore, LATEST_KEY: SSV_KEY } = require("./short-sale-volume-blob-store");
const { normalizeSector } = require("./beeswarm-sectors");
const { fetchDailyHistory, sleep } = require("./yahoo-client");
const { TICKER_NOW } = require("./putcall-ticker-map");

const FINRA_URL = (d) => `https://cdn.finra.org/equity/otcmarket/biweekly/shrt${d.replace(/-/g, "")}.csv`;
const FIRST_LISTED = "2021-06-15";
const RUN_BUDGET_MS = 12 * 60 * 1000;
const COLLECT_BUDGET_MS = 7 * 60 * 1000;
const REBUILD_AFTER_MS = 7 * 24 * 3600 * 1000;
const HORIZONS = [21, 63, 126];
const PUBLICATION_LAG = 10;
const TABLE_SIZE = 15;
const MAX_DTC = 100;
const INDEX = "^SP500TR";
// ~600 price histories one at a time took ~11 minutes in testing, too close
// to the 15-minute limit, so a few run side by side.
const PRICE_WORKERS = 4;
// Bumped whenever build() changes, so the next run rebuilds the payload
// instead of waiting for a new settlement date or the weekly rebuild.
const BUILD_VERSION = 2;

const finraSymbol = (s) => s.replace(/[-.]/g, "");
const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (v, d = 2) => (v === null || v === undefined ? null : round(v * 100, d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const p = (v.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return v[lo] + (v[hi] - v[lo]) * (p - lo);
}
const median = (a) => quantile(a, 0.5);
function num(v) {
  if (v === null || v === undefined || v === "" || v === "None") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Mean with a Newey-West standard error, as on the put/call page: forward
// windows of neighboring settlement dates overlap.
function neweyWest(series, lag) {
  const x = series.filter(Number.isFinite);
  const n = x.length;
  if (n < 12) return { mean: mean(x), se: null, t: null, n };
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

// Every symbol that was an S&P 500 member at any month-end since October
// 2021, plus today's list, keyed by FINRA's spelling (BRK-B is BRKB there).
function universe() {
  const map = new Map();
  for (const d of PLAN_DATES) for (const t of MEMBERS[d].split(",")) map.set(finraSymbol(t), t);
  for (const t of BREADTH_CONSTITUENTS) map.set(finraSymbol(t), t);
  return map;
}

function membersOn(date) {
  let best = null;
  for (const d of PLAN_DATES) if (d <= date) best = d;
  if (!best) return null;
  const last = PLAN_DATES[PLAN_DATES.length - 1];
  return best === last && date > last ? BREADTH_CONSTITUENTS.slice() : MEMBERS[best].split(",");
}

const ymd = (dt) => dt.toISOString().slice(0, 10);
function isWeekday(dt) { const g = dt.getUTCDay(); return g !== 0 && g !== 6; }

// Settlement dates fall on the 15th and the last business day of each month,
// moved earlier for weekends and holidays, so try up to four days back.
function candidateGroups(today) {
  const groups = [];
  const start = new Date(FIRST_LISTED + "T00:00:00Z");
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m++) {
    if (m > 11) { m = 0; y++; }
    const mid = new Date(Date.UTC(y, m, 15));
    const end = new Date(Date.UTC(y, m + 1, 0));
    if (mid > today) break;
    for (const anchor of [mid, end]) {
      if (anchor > today || ymd(anchor) < FIRST_LISTED) continue;
      const days = [];
      for (let k = 0; k < 4; k++) {
        const d = new Date(anchor); d.setUTCDate(d.getUTCDate() - k);
        if (isWeekday(d)) days.push(ymd(d));
      }
      groups.push(days);
    }
  }
  return groups;
}

function parseFile(text, wanted) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split("|").map((h) => h.replace(/"/g, "").trim());
  const col = (name) => header.indexOf(name);
  const iSym = col("symbolCode"), iShort = col("currentShortPositionQuantity"), iAdv = col("averageDailyVolumeQuantity"), iDtc = col("daysToCoverQuantity");
  if ([iSym, iShort, iAdv, iDtc].some((i) => i < 0)) throw new Error("unexpected FINRA header: " + lines[0].slice(0, 120));
  const rows = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = lines[i].split("|").map((x) => x.replace(/"/g, ""));
    const site = wanted.get(f[iSym]);
    if (!site) continue;
    rows[site] = [num(f[iShort]), num(f[iAdv]), num(f[iDtc])];
  }
  return rows;
}

async function collect(store, index, started) {
  const wanted = universe();
  const have = new Set(index.dates);
  const today = new Date();
  let added = 0;
  for (const group of candidateGroups(today)) {
    if (Date.now() - started > COLLECT_BUDGET_MS) break;
    if (group.some((d) => have.has(d))) continue;
    for (const d of group) {
      const res = await fetch(FINRA_URL(d));
      if (!res.ok) continue;
      const rows = parseFile(await res.text(), wanted);
      if (Object.keys(rows).length < 100) continue;
      await store.setJSON(dateKey(d), { date: d, rows });
      index.dates.push(d); have.add(d); added++;
      console.log(`short-interest: stored ${d} (${Object.keys(rows).length} members)`);
      break;
    }
  }
  index.dates.sort();
  return added;
}

async function build(store, index) {
  const snaps = [];
  for (const d of index.dates) {
    const s = await store.get(dateKey(d), { type: "json" });
    if (s) snaps.push(s);
  }
  if (!snaps.length) throw new Error("no short interest stored yet");
  const latest = snaps[snaps.length - 1];
  const previous = snaps.length > 1 ? snaps[snaps.length - 2] : null;

  let overview = {};
  try { overview = (await loadCollected("overview")).data || {}; } catch (err) { console.error(`short-interest: overview unavailable (${err.message})`); }
  const meta = ((await getBeeswarmStore().get(META_KEY, { type: "json" })) || {}).tickers || {};
  let svr = {};
  try {
    const ssv = await getShortSaleVolumeStore().get(SSV_KEY, { type: "json" });
    for (const c of (ssv && ssv.companies) || []) svr[c.symbol] = c.avgSvr;
  } catch (err) { console.error(`short-interest: short sale volume unavailable (${err.message})`); }

  // ---- latest settlement -------------------------------------------------
  const current = [];
  for (const symbol of BREADTH_CONSTITUENTS) {
    const r = latest.rows[symbol];
    if (!r || r[0] === null) continue;
    const shares = overview[symbol] ? num(overview[symbol].SharesOutstanding) : null;
    const prev = previous && previous.rows[symbol];
    const m = meta[symbol] || {};
    current.push({
      symbol,
      name: m.name || (overview[symbol] && overview[symbol].Name) || symbol,
      sector: m.sector || (overview[symbol] && normalizeSector(symbol, overview[symbol].Sector)) || null,
      shortShares: r[0],
      pctShares: shares ? pct(r[0] / shares) : null,
      daysToCover: r[2] !== null && r[2] < MAX_DTC ? round(r[2]) : null,
      changePct: prev && prev[0] ? pct(r[0] / prev[0] - 1, 1) : null,
      svr: Number.isFinite(svr[symbol]) ? round(svr[symbol] * 100, 1) : null,
    });
  }
  const ranked = current.filter((c) => c.pctShares !== null).sort((a, b) => b.pctShares - a.pctShares);
  const bySector = {};
  for (const c of current) if (c.sector) (bySector[c.sector] = bySector[c.sector] || []).push(c);
  const sectors = Object.entries(bySector).map(([sector, list]) => ({
    sector,
    n: list.length,
    medianPctShares: round(median(list.map((c) => c.pctShares))),
    medianDaysToCover: round(median(list.map((c) => c.daysToCover))),
  })).sort((a, b) => (b.medianPctShares ?? -Infinity) - (a.medianPctShares ?? -Infinity));

  // Short sale volume and short interest across stocks: rank correlation.
  const both = current.filter((c) => c.svr !== null && c.pctShares !== null);
  const rankOf = (vals) => { const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(vals.length); idx.forEach(([, i], k) => { r[i] = k + 1; }); return r; };
  let spearman = null;
  if (both.length > 30) {
    const a = rankOf(both.map((c) => c.svr)), b = rankOf(both.map((c) => c.pctShares));
    const ma = mean(a), mb = mean(b);
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    spearman = round(sab / Math.sqrt(saa * sbb));
  }

  // ---- history of days to cover ------------------------------------------
  // Settlement dates before the first planned month-end use that month-end's
  // members, the nearest point-in-time list.
  const history = snaps.map((s) => {
    const members = membersOn(s.date) || MEMBERS[PLAN_DATES[0]].split(",");
    const dtc = members.map((t) => s.rows[t] && s.rows[t][2]).filter((v) => Number.isFinite(v) && v < MAX_DTC);
    return { date: s.date, medianDaysToCover: round(median(dtc)), p25: round(quantile(dtc, 0.25)), p75: round(quantile(dtc, 0.75)), n: dtc.length };
  });

  // ---- forward-return test -----------------------------------------------
  const testSnaps = snaps.filter((s) => s.date >= PLAN_DATES[0]);
  const needed = new Set();
  for (const s of testSnaps) for (const t of membersOn(s.date) || []) if (s.rows[t]) needed.add(t);
  const since = Math.floor(Date.parse(PLAN_DATES[0] + "T00:00:00Z") / 1000) - 40 * 86400;
  const idxRows = await fetchDailyHistory(INDEX, { adjusted: true, sinceUnix: since });
  const days = idxRows.map((r) => r.date);
  const idxMap = new Map(idxRows.map((r) => [r.date, r.close]));
  const prices = new Map();
  const queue = [...needed];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const rows = await fetchDailyHistory(TICKER_NOW[t] || t, { adjusted: true, sinceUnix: since });
        prices.set(t, new Map(rows.map((r) => [r.date, r.close])));
      } catch (err) { /* left out of the test on every date */ }
      await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: PRICE_WORKERS }, worker));
  const startIndex = (date) => { const i = days.findIndex((d) => d >= date); return i < 0 ? -1 : i + PUBLICATION_LAG; };
  const perDate = [];
  for (const s of testSnaps) {
    const i0 = startIndex(s.date);
    if (i0 < 0 || i0 >= days.length) continue;
    const entry = days[i0];
    const rows = (membersOn(s.date) || [])
      .map((t) => ({ t, dtc: s.rows[t] && s.rows[t][2] }))
      .filter((r) => Number.isFinite(r.dtc) && r.dtc < MAX_DTC && prices.get(r.t) && prices.get(r.t).has(entry))
      .sort((a, b) => a.dtc - b.dtc);
    if (rows.length < 100) continue;
    const tenth = (k) => rows.slice(Math.floor((k * rows.length) / 10), Math.floor(((k + 1) * rows.length) / 10));
    const rec = { date: s.date, entry, n: rows.length, h: {} };
    for (const h of HORIZONS) {
      if (i0 + h >= days.length) continue;
      const exit = days[i0 + h];
      const ri = idxMap.get(exit) / idxMap.get(entry) - 1;
      const rel = (list) => mean(list.map((r) => { const p = prices.get(r.t); const a = p.get(entry), b = p.get(exit); return a && b ? (1 + (b / a - 1)) / (1 + ri) - 1 : null; }).filter(Number.isFinite));
      const deciles = Array.from({ length: 10 }, (_, k) => rel(tenth(k)));
      const all = rel(rows);
      rec.h[h] = { deciles, all };
    }
    perDate.push(rec);
  }
  const summarize = (pick) => Object.fromEntries(HORIZONS.map((h) => {
    const series = perDate.map((d) => d.h[h] && pick(d.h[h])).filter(Number.isFinite);
    const nw = neweyWest(series, Math.max(0, Math.ceil(h / 10) - 1));
    return [h, { dates: series.length, meanRelPct: pct(nw.mean), seRelPct: pct(nw.se), tStat: round(nw.t), hitRatePct: series.length ? round((series.filter((v) => v > 0).length / series.length) * 100, 1) : null }];
  }));
  const study = {
    dates: perDate.length,
    firstDate: perDate.length ? perDate[0].date : null,
    highestTenth: summarize((x) => x.deciles[9]),
    lowestTenth: summarize((x) => x.deciles[0]),
    allMembers: summarize((x) => x.all),
    highestMinusLowest: summarize((x) => (Number.isFinite(x.deciles[9]) && Number.isFinite(x.deciles[0]) ? x.deciles[9] - x.deciles[0] : null)),
    highestMinusAll: summarize((x) => (Number.isFinite(x.deciles[9]) && Number.isFinite(x.all) ? x.deciles[9] - x.all : null)),
    decileCurve: Object.fromEntries(HORIZONS.map((h) => [h, Array.from({ length: 10 }, (_, k) => {
      const v = perDate.map((d) => d.h[h] && d.h[h].deciles[k]).filter(Number.isFinite);
      return { decile: k + 1, meanRelPct: pct(mean(v)), dates: v.length };
    })])),
  };

  return {
    generated_at_utc: new Date().toISOString(),
    buildVersion: BUILD_VERSION,
    settlementDate: latest.date,
    previousSettlementDate: previous ? previous.date : null,
    firstSettlementDate: snaps[0].date,
    settlementDates: snaps.length,
    horizons: HORIZONS,
    publicationLagDays: PUBLICATION_LAG,
    market: {
      members: current.length,
      medianPctShares: round(median(current.map((c) => c.pctShares))),
      medianDaysToCover: round(median(current.map((c) => c.daysToCover))),
      medianChangePct: round(median(current.map((c) => c.changePct)), 1),
      svrVsShortInterestSpearman: spearman,
      svrPairs: both.length,
    },
    mostShorted: ranked.slice(0, TABLE_SIZE),
    leastShorted: ranked.slice(-TABLE_SIZE).reverse(),
    sectors,
    history,
    study,
    companies: current,
  };
}

exports.handler = async () => {
  const started = Date.now();
  try {
    const store = getShortInterestStore();
    const index = (await store.get(INDEX_KEY, { type: "json" })) || { dates: [] };
    const added = await collect(store, index, started);
    await store.setJSON(INDEX_KEY, { ...index, updatedAt: added ? new Date().toISOString() : index.updatedAt, checkedAt: new Date().toISOString() });
    const latest = await store.get(LATEST_KEY, { type: "json" });
    const stale = !latest || latest.buildVersion !== BUILD_VERSION || Date.now() - Date.parse(latest.generated_at_utc) > REBUILD_AFTER_MS;
    if ((added || stale) && Date.now() - started < RUN_BUDGET_MS - 5 * 60 * 1000) {
      const payload = await build(store, index);
      await store.setJSON(LATEST_KEY, payload);
      console.log(`short-interest: built ${payload.settlementDate}, ${payload.settlementDates} dates, test on ${payload.study.dates}`);
    } else {
      console.log(`short-interest: ${added} new dates, build ${added || stale ? "deferred to the next run" : "not needed"}`);
    }
    return { statusCode: 200 };
  } catch (err) {
    console.error(`short-interest: failed: ${err.message}`);
    return { statusCode: 500 };
  }
};

module.exports.candidateGroups = candidateGroups;
module.exports.parseFile = parseFile;
module.exports.universe = universe;
module.exports.membersOn = membersOn;
module.exports.build = build;
