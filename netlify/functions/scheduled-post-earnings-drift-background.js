// Scheduled Background Function (see [functions."scheduled-post-earnings-
// drift-background"] in netlify.toml): post-earnings announcement drift
// (PEAD), the tendency of stocks to keep moving in the direction of an
// earnings surprise for weeks after the report.
//
// Events come from the shared earnings collection (about ten years of
// quarterly reported and estimated EPS per S&P 500 member), prices from
// Yahoo, benchmark SPY. No Alpha Vantage calls.
//
// Timing: the collection doesn't say whether a report came before the open
// or after the close, so day 0 is the first trading day on or after the
// report date and the announcement reaction runs from the close of day -1 to
// the close of day +1, which covers either case. Drift is what comes after:
// from the close of day +1 to day +20 or +60. Returns are relative to SPY
// over the same days.
//
// Surprise groups are formed within each calendar quarter of report dates,
// so a quarter where nearly everyone beat doesn't fill the top group by
// itself. Spreads (top fifth minus bottom fifth) are averaged across
// quarters with a Newey-West standard error. The panel only has today's
// members, so companies that left the index aren't in it.

const { getPeadStore, PANEL_KEY } = require("./post-earnings-drift-blob-store");
const { loadCollected } = require("./av-collector-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { fetchDailyHistory, sleep } = require("./yahoo-client");

const PRICE_START = "2015-06-01";
const PRE_DAYS = 5;
const POST_DAYS = 60;
const GROUPS = 5;
const MIN_EVENTS_PER_QUARTER = 50;
// Surprise percentages explode when the estimate is near zero.
const MIN_ABS_ESTIMATE = 0.05;
const RECENT_DAYS = 100;
const LEADERBOARD_COUNT = 10;
const PRICE_WORKERS = 4;
const MIN_SECTOR_EVENTS = 40;

function num(v) {
  if (v === null || v === undefined || v === "" || v === "None") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
const pct = (v, d = 2) => (v === null || v === undefined ? null : round(v * 100, d));
const mean = (a) => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
function median(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function neweyWest(series, lag) {
  const x = series.filter(Number.isFinite);
  const n = x.length;
  if (n < 12) return { mean: mean(x), t: null, n };
  const m = mean(x);
  const d = x.map((v) => v - m);
  let s = d.reduce((acc, v) => acc + v * v, 0) / n;
  for (let l = 1; l <= Math.min(lag, n - 1); l++) {
    let c = 0;
    for (let i = l; i < n; i++) c += d[i] * d[i - l];
    s += 2 * (1 - l / (lag + 1)) * (c / n);
  }
  const se = Math.sqrt(Math.max(s, 0) / n);
  return { mean: m, t: se > 0 ? m / se : null, n };
}
const quarterOf = (date) => `${date.slice(0, 4)}-Q${Math.floor((+date.slice(5, 7) - 1) / 3) + 1}`;

async function loadPrices(symbols, sinceUnix) {
  const out = new Map();
  const queue = [...symbols];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const rows = await fetchDailyHistory(t, { adjusted: true, sinceUnix });
        out.set(t, new Map(rows.map((r) => [r.date, r.close])));
      } catch (err) { /* left out of every event */ }
      await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: PRICE_WORKERS }, worker));
  return out;
}

exports.handler = async () => {
  const started = Date.now();
  try {
    const earningsPub = await loadCollected("earnings");
    const meta = ((await getBeeswarmStore().get(META_KEY, { type: "json" })) || {}).tickers || {};
    const sinceUnix = Math.floor(Date.parse(PRICE_START + "T00:00:00Z") / 1000);
    const spyRows = await fetchDailyHistory("SPY", { adjusted: true, sinceUnix });
    const days = spyRows.map((r) => r.date);
    const spy = spyRows.map((r) => r.close);
    const dayIndex = (date) => { let lo = 0, hi = days.length; while (lo < hi) { const m = (lo + hi) >> 1; if (days[m] < date) lo = m + 1; else hi = m; } return lo; };
    const prices = await loadPrices(BREADTH_CONSTITUENTS, sinceUnix);

    // ---- events ------------------------------------------------------------
    const events = [];
    for (const symbol of BREADTH_CONSTITUENTS) {
      const p = prices.get(symbol);
      const e = earningsPub.data[symbol];
      if (!p || !e) continue;
      for (const q of e.quarterlyEarnings || []) {
        const est = num(q.estimatedEPS), rep = num(q.reportedEPS), surprise = num(q.surprisePercentage);
        if (!q.reportedDate || est === null || rep === null || surprise === null || Math.abs(est) < MIN_ABS_ESTIMATE) continue;
        const d0 = dayIndex(q.reportedDate);
        if (d0 - PRE_DAYS - 1 < 0 || d0 + 1 >= days.length) continue;
        const base = d0 - 1;
        const pb = p.get(days[base]);
        if (!pb) continue;
        // Path relative to SPY from the close before day 0, -PRE_DAYS..+POST_DAYS.
        const path = [];
        for (let k = -PRE_DAYS; k <= POST_DAYS; k++) {
          const i = d0 + k;
          const px = i < days.length ? p.get(days[i]) : undefined;
          path.push(px ? (px / pb) / (spy[i] / spy[base]) - 1 : null);
        }
        const at = (k) => path[k + PRE_DAYS];
        const reaction = at(1);
        if (!Number.isFinite(reaction)) continue;
        const after = (k) => (Number.isFinite(at(k)) ? (1 + at(k)) / (1 + reaction) - 1 : null);
        events.push({
          symbol, date: q.reportedDate, quarter: quarterOf(q.reportedDate), surprise, beat: rep > est ? 1 : rep < est ? -1 : 0,
          sector: (meta[symbol] && meta[symbol].sector) || null,
          reaction, drift20: after(20), drift60: after(60), path,
        });
      }
    }

    // ---- surprise groups within each report quarter -------------------------
    const byQuarter = new Map();
    for (const ev of events) { if (!byQuarter.has(ev.quarter)) byQuarter.set(ev.quarter, []); byQuarter.get(ev.quarter).push(ev); }
    const quarters = [...byQuarter.keys()].sort().filter((q) => byQuarter.get(q).length >= MIN_EVENTS_PER_QUARTER);
    for (const q of quarters) {
      const list = byQuarter.get(q).sort((a, b) => a.surprise - b.surprise);
      list.forEach((ev, i) => { ev.group = Math.min(GROUPS - 1, Math.floor((i * GROUPS) / list.length)); });
    }
    const grouped = events.filter((ev) => ev.group !== undefined);

    const curve = Array.from({ length: GROUPS }, (_, g) => {
      const members = grouped.filter((ev) => ev.group === g);
      return {
        group: g + 1,
        events: members.length,
        medianSurprisePct: round(median(members.map((ev) => ev.surprise)), 1),
        path: Array.from({ length: PRE_DAYS + POST_DAYS + 1 }, (_, k) => pct(mean(members.map((ev) => ev.path[k])), 2)),
        reactionPct: pct(mean(members.map((ev) => ev.reaction))),
        drift20Pct: pct(mean(members.map((ev) => ev.drift20))),
        drift60Pct: pct(mean(members.map((ev) => ev.drift60))),
        drift60HitPct: round((members.filter((ev) => ev.drift60 > 0).length / Math.max(1, members.filter((ev) => Number.isFinite(ev.drift60)).length)) * 100, 1),
      };
    });

    // Top-minus-bottom spread per quarter, then averaged across quarters.
    const perQuarter = quarters.map((q) => {
      const list = byQuarter.get(q);
      const top = list.filter((ev) => ev.group === GROUPS - 1), bottom = list.filter((ev) => ev.group === 0);
      const spread = (f) => { const a = mean(top.map(f)), b = mean(bottom.map(f)); return Number.isFinite(a) && Number.isFinite(b) ? a - b : null; };
      return { quarter: q, events: list.length, reaction: spread((ev) => ev.reaction), drift20: spread((ev) => ev.drift20), drift60: spread((ev) => ev.drift60) };
    });
    const summarize = (key) => {
      const nw = neweyWest(perQuarter.map((r) => r[key]), 1);
      return { meanPct: pct(nw.mean), t: round(nw.t), quarters: nw.n, positivePct: round((perQuarter.filter((r) => r[key] > 0).length / Math.max(1, perQuarter.filter((r) => Number.isFinite(r[key])).length)) * 100, 0) };
    };
    const spread = { reaction: summarize("reaction"), drift20: summarize("drift20"), drift60: summarize("drift60") };

    const years = [...new Set(perQuarter.map((r) => r.quarter.slice(0, 4)))].sort();
    const byYear = years.map((y) => {
      const rows = perQuarter.filter((r) => r.quarter.startsWith(y));
      return { year: y, quarters: rows.length, events: rows.reduce((s, r) => s + r.events, 0), reactionPct: pct(mean(rows.map((r) => r.reaction))), drift60Pct: pct(mean(rows.map((r) => r.drift60))) };
    });

    const beats = grouped.filter((ev) => ev.beat > 0), misses = grouped.filter((ev) => ev.beat < 0);
    const bySector = SECTOR_ORDER.map((sector) => {
      const b = beats.filter((ev) => ev.sector === sector), m = misses.filter((ev) => ev.sector === sector);
      if (b.length < MIN_SECTOR_EVENTS || m.length < MIN_SECTOR_EVENTS) return null;
      return { sector, beats: b.length, misses: m.length, beatDrift60Pct: pct(mean(b.map((ev) => ev.drift60))), missDrift60Pct: pct(mean(m.map((ev) => ev.drift60))), beatReactionPct: pct(mean(b.map((ev) => ev.reaction))), missReactionPct: pct(mean(m.map((ev) => ev.reaction))) };
    }).filter(Boolean);

    // ---- the latest reports ------------------------------------------------
    const lastDay = days[days.length - 1];
    const cutoff = days[Math.max(0, days.length - RECENT_DAYS)];
    const latestBySymbol = new Map();
    for (const ev of events) if (ev.date >= cutoff && (!latestBySymbol.has(ev.symbol) || ev.date > latestBySymbol.get(ev.symbol).date)) latestBySymbol.set(ev.symbol, ev);
    const companies = [...latestBySymbol.values()].map((ev) => {
      let lastK = null;
      for (let k = POST_DAYS; k >= 1; k--) if (Number.isFinite(ev.path[k + PRE_DAYS])) { lastK = k; break; }
      const since = lastK && lastK > 1 ? (1 + ev.path[lastK + PRE_DAYS]) / (1 + ev.reaction) - 1 : null;
      return {
        symbol: ev.symbol, name: (meta[ev.symbol] && meta[ev.symbol].name) || ev.symbol, sector: ev.sector, reportedDate: ev.date,
        surprisePct: round(ev.surprise, 1), beat: ev.beat, reactionPct: pct(ev.reaction), driftSincePct: pct(since), daysSince: lastK,
        drift20Pct: pct(ev.drift20),
      };
    }).sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
    const withDrift = companies.filter((c) => c.driftSincePct !== null);
    const lead = (list, dir) => list.slice().sort((a, b) => dir * (b.driftSincePct - a.driftSincePct)).slice(0, LEADERBOARD_COUNT);
    const leaderboards = {
      beatUp: lead(withDrift.filter((c) => c.beat > 0), 1), beatDown: lead(withDrift.filter((c) => c.beat > 0), -1),
      missUp: lead(withDrift.filter((c) => c.beat < 0), 1), missDown: lead(withDrift.filter((c) => c.beat < 0), -1),
    };

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOf: lastDay,
      earningsDate: earningsPub.generated_at_utc.slice(0, 10),
      universe: { members: BREADTH_CONSTITUENTS.length, priced: prices.size, events: events.length, groupedEvents: grouped.length, quarters: quarters.length, firstQuarter: quarters[0], lastQuarter: quarters[quarters.length - 1], recentWindowStart: cutoff },
      settings: { preDays: PRE_DAYS, postDays: POST_DAYS, groups: GROUPS, minAbsEstimate: MIN_ABS_ESTIMATE },
      beatSharePct: round((beats.length / grouped.length) * 100, 1),
      curve,
      spread,
      byYear,
      perQuarter: perQuarter.map((r) => ({ quarter: r.quarter, events: r.events, reactionPct: pct(r.reaction), drift60Pct: pct(r.drift60) })),
      bySector,
      recent: { companies, leaderboards, beats: companies.filter((c) => c.beat > 0).length, misses: companies.filter((c) => c.beat < 0).length },
    };
    await getPeadStore().setJSON(PANEL_KEY, payload);
    console.log(`scheduled-post-earnings-drift-background: ${events.length} events over ${quarters.length} quarters, drift60 spread ${spread.drift60.meanPct}% (t ${spread.drift60.t}), ${companies.length} recent, ${Math.round((Date.now() - started) / 1000)}s`);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`scheduled-post-earnings-drift-background: FAILED: ${err.message}`);
    return { statusCode: 500 };
  }
};
