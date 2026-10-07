// Scheduled Background Function (see [functions."scheduled-revisions-background"]
// in netlify.toml) that computes analyst earnings-estimate revision breadth
// and magnitude across the S&P 500, for the earnings-revisions.html page.
//
// For each constituent (reusing breadth-constituents.js), pulls Alpha
// Vantage's EARNINGS_ESTIMATES and reads off the current-fiscal-year (FY1)
// consensus EPS estimate plus how it has moved over the trailing 7/30/90
// days and how many analysts revised it up vs. down over the trailing 30
// days. Two numbers come out of that per stock:
//   - Net Revision Ratio: (upward revisions − downward revisions) / total
//     revisions over the trailing 30 days, range −1..+1 — a breadth measure
//     (how many analysts are moving, and which way), the same construction
//     as a diffusion index.
//   - Estimate Drift: the 30-day % change in the consensus FY1 EPS estimate
//     itself — a magnitude measure (how much the number actually moved).
// A sector or the market can have high breadth with small drift (many small
// nudges, same direction) or the reverse (one or two analysts making a big
// call) — that distinction is why both are surfaced separately rather than
// collapsed into one score.
//
// Sector and company name come from the beeswarm store's meta.json (see
// beeswarm-blob-store.js / scheduled-beeswarm-meta-background.js) rather
// than a fresh OVERVIEW call per ticker — that data already exists,
// refreshed weekly, and sector reassignments are rare enough that reading
// it here (a different page's blob, but the same store this site already
// treats as the canonical S&P 500 sector map) avoids ~503 redundant calls.
//
// Runs weekly (Saturday), after scheduled-beeswarm-meta-background so this
// job's sector/name lookups are fresh. Not daily: trailing-30-day revision
// counts and a 30-day drift number don't meaningfully change day to day,
// and a full-index sweep is the expensive kind of job this site reserves
// for weekly cadence (see scheduled-beeswarm-meta-background.js,
// scheduled-concentration-history-background.js).
//
// Pacing mirrors scheduled-beeswarm-meta-background.js exactly (~1.05s
// between calls, two passes with a 65s cooling-off between them) since that
// job already proved out a safe cadence for a full ~503-symbol sweep on
// this account's rate limit.

const { getRevisionsStore, LATEST_KEY, HISTORY_KEY } = require("./revisions-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");
const { fetchQuotes } = require("./yahoo-client");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_HISTORY_POINTS = 260; // ~5 years of weekly snapshots
const MIN_ANALYSTS_FOR_LEADERBOARD = 3; // thin coverage makes drift/NRR noisy
// Days-ago points Alpha Vantage gives for each consensus EPS estimate.
const AGO = [0, 7, 30, 60, 90];
// Second share classes whose revenue estimate repeats the first class's
// company-level figure, so revenue totals count each company once.
const SECOND_CLASSES = new Set(["GOOG", "FOX", "NWS"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// AV returns null (not 0) for a revision-count field when there were no
// revisions of that direction in the window — treated as 0, not "unknown".
function count(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchEarningsEstimates(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=EARNINGS_ESTIMATES&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const estimates = payload.estimates;
  if (!Array.isArray(estimates) || !estimates.length) return null;

  // "Current FY1" = the fiscal-year-horizon estimate with the nearest date.
  // Alpha Vantage returns a rolling window of the current and next fiscal
  // year only (no trailing/completed years), so the minimum date among
  // horizon="fiscal year" rows is always the in-progress or next-to-report
  // fiscal year, never a year that's already fully reported.
  const fyRows = estimates.filter((e) => e.horizon === "fiscal year" && e.date);
  if (!fyRows.length) return null;
  fyRows.sort((a, b) => (a.date < b.date ? -1 : 1));
  const fy1 = fyRows[0];
  const fy2 = fyRows[1] || null;
  const epsAt = (row, k) => (row ? num(k ? row[`eps_estimate_average_${k}_days_ago`] : row.eps_estimate_average) : null);

  const epsNow = num(fy1.eps_estimate_average);
  const eps7 = num(fy1.eps_estimate_average_7_days_ago);
  const eps30 = num(fy1.eps_estimate_average_30_days_ago);
  const eps90 = num(fy1.eps_estimate_average_90_days_ago);
  const up30 = count(fy1.eps_estimate_revision_up_trailing_30_days);
  const down30 = count(fy1.eps_estimate_revision_down_trailing_30_days);
  const totalRevisions30 = up30 + down30;

  return {
    fyEndDate: fy1.date,
    analystCount: num(fy1.eps_estimate_analyst_count),
    epsNow,
    drift7: epsNow !== null && eps7 !== null && eps7 !== 0 ? ((epsNow - eps7) / Math.abs(eps7)) * 100 : null,
    drift30: epsNow !== null && eps30 !== null && eps30 !== 0 ? ((epsNow - eps30) / Math.abs(eps30)) * 100 : null,
    drift90: epsNow !== null && eps90 !== null && eps90 !== 0 ? ((epsNow - eps90) / Math.abs(eps90)) * 100 : null,
    up30,
    down30,
    netRevisionRatio30: totalRevisions30 > 0 ? (up30 - down30) / totalRevisions30 : null,
    fy2EndDate: fy2 ? fy2.date : null,
    fy1Eps: Object.fromEntries(AGO.map((k) => [k, epsAt(fy1, k)])),
    fy2Eps: Object.fromEntries(AGO.map((k) => [k, epsAt(fy2, k)])),
    fy1Revenue: num(fy1.revenue_estimate_average),
    fy2Revenue: fy2 ? num(fy2.revenue_estimate_average) : null,
  };
}

// Next-twelve-months blend of the two fiscal years, weighted by how much of
// FY1 is still ahead on `date`: the usual way to put companies with different
// fiscal year-ends on one forward basis.
function ntm(fy1Value, fy2Value, fy1EndDate, date) {
  if (!Number.isFinite(fy1Value)) return null;
  const w = Math.max(0, Math.min(1, (Date.parse(fy1EndDate) - Date.parse(date)) / (365 * 86400000)));
  if (!Number.isFinite(fy2Value)) return w > 0.5 ? fy1Value : null;
  return w * fy1Value + (1 - w) * fy2Value;
}

// Change in forward earnings and revenue totals since the stored weekly point
// nearest 4 and 13 weeks back (within a week), once history reaches that far.
function revenueVsEps(points, now) {
  const out = { since: {} };
  for (const weeks of [4, 13]) {
    const target = Date.parse(now.date) - weeks * 7 * 86400000;
    const then = points.filter((p) => p.revenue && p.earnings).sort((a, b) => Math.abs(Date.parse(a.date) - target) - Math.abs(Date.parse(b.date) - target))[0];
    if (!then || Math.abs(Date.parse(then.date) - target) > 7 * 86400000) continue;
    const ch = (a, b) => (a > 0 && b > 0 ? round((a / b - 1) * 100, 2) : null);
    out.since[weeks] = {
      from: then.date,
      revenuePct: ch(now.revenue, then.revenue),
      earningsPct: ch(now.earnings, then.earnings),
      sectors: SECTOR_ORDER.filter((s) => then.sectorTotals && then.sectorTotals[s]).map((s) => ({ sector: s, revenuePct: ch(now.sectorTotals[s].revenue, then.sectorTotals[s].revenue), earningsPct: ch(now.sectorTotals[s].earnings, then.sectorTotals[s].earnings) })),
    };
  }
  const withTotals = points.filter((p) => p.revenue && p.earnings);
  out.firstStored = withTotals.length ? withTotals[0].date : now.date;
  return out;
}

// Aggregate forward earnings (shares x NTM EPS) for a group at each
// days-ago point, using only stocks with every point, so the path compares
// the same companies throughout. Every point uses today's fiscal-year
// weights, so the path shows estimate revisions only, without the drift
// that comes from rolling toward next year's (usually higher) estimate.
function forwardPath(rows, today) {
  const usable = rows.filter((r) => r.shares && r.price && AGO.every((k) => Number.isFinite(ntm(r.fy1Eps[k], r.fy2Eps[k], r.fyEndDate, today))));
  if (!usable.length) return null;
  const total = (k) => usable.reduce((s, r) => s + r.shares * ntm(r.fy1Eps[k], r.fy2Eps[k], r.fyEndDate, today), 0);
  const now = total(0);
  const cap = usable.reduce((s, r) => s + r.shares * r.price, 0);
  return {
    companies: usable.length,
    forwardPE: now > 0 ? round(cap / now, 1) : null,
    changePct: Object.fromEntries(AGO.filter((k) => k).map((k) => { const then = total(k); return [k, then > 0 ? round((now / then - 1) * 100, 2) : null]; })),
    earningsNow: now,
  };
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function round(v, d = 3) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

exports.handler = async () => {
  console.log(`scheduled-revisions-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const entry = await fetchEarningsEstimates(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-revisions-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    // Two passes, same cadence as scheduled-beeswarm-meta-background.js:
    // ~1.05s between calls, a full minute+ cooling-off before retrying
    // whatever the first pass missed.
    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-revisions-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-revisions-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);

    // Join against sector/name metadata; drop anything unmapped rather than
    // let it distort a sector aggregate under the wrong column.
    let quotes = new Map();
    try { quotes = await fetchQuotes([...results.keys()]); } catch (err) { console.error(`scheduled-revisions-background: quotes failed (${err.message})`); }
    const rows = [];
    for (const [symbol, est] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      rows.push({
        ticker: symbol,
        name: m.name || symbol,
        sector: m.sector,
        marketCap: m.marketCap || null,
        shares: m.sharesOutstanding || null,
        price: quotes.get(symbol) ? quotes.get(symbol).price : null,
        ...est,
      });
    }

    if (!rows.length) throw new Error("No tickers resolved with both estimates and sector metadata");

    const sectorAgg = SECTOR_ORDER.map((sector) => {
      const inSector = rows.filter((r) => r.sector === sector);
      const withNrr = inSector.filter((r) => r.netRevisionRatio30 !== null);
      const upTotal = inSector.reduce((s, r) => s + r.up30, 0);
      const downTotal = inSector.reduce((s, r) => s + r.down30, 0);
      return {
        sector,
        count: inSector.length,
        netRevisionRatio30: round(mean(withNrr.map((r) => r.netRevisionRatio30))),
        drift30: round(mean(inSector.map((r) => r.drift30))),
        upTotal,
        downTotal,
      };
    }).filter((s) => s.count > 0);

    const marketNrr = round(mean(rows.filter((r) => r.netRevisionRatio30 !== null).map((r) => r.netRevisionRatio30)));
    const marketDrift30 = round(mean(rows.map((r) => r.drift30)));
    const upTotal = rows.reduce((s, r) => s + r.up30, 0);
    const downTotal = rows.reduce((s, r) => s + r.down30, 0);

    const eligible = rows.filter(
      (r) => r.drift30 !== null && r.analystCount !== null && r.analystCount >= MIN_ANALYSTS_FOR_LEADERBOARD
    );
    const upgrades = [...eligible].sort((a, b) => b.drift30 - a.drift30).slice(0, 10);
    const downgrades = [...eligible].sort((a, b) => a.drift30 - b.drift30).slice(0, 10);

    const leaderboardRow = (r) => ({
      ticker: r.ticker,
      name: r.name,
      sector: r.sector,
      epsNow: round(r.epsNow, 2),
      drift30: round(r.drift30, 2),
      up30: r.up30,
      down30: r.down30,
      analystCount: r.analystCount,
    });

    const scatterPoints = rows
      .filter((r) => r.netRevisionRatio30 !== null && r.drift30 !== null)
      .map((r) => ({
        ticker: r.ticker,
        sector: r.sector,
        netRevisionRatio30: round(r.netRevisionRatio30),
        drift30: round(r.drift30, 2),
      }));

    const generatedAt = new Date().toISOString();
    const today = generatedAt.slice(0, 10);

    // ---- forward EPS: index and sectors -----------------------------------
    let spx = null;
    try { const q = await fetchQuotes(["^GSPC"]); spx = q.get("^GSPC") ? q.get("^GSPC").price : null; } catch (err) { /* level left out */ }
    const marketPath = forwardPath(rows, today);
    const forward = marketPath && {
      ...marketPath,
      // The index's own forward EPS in index points: its level divided by
      // the members' combined forward P/E.
      indexEps: spx && marketPath.forwardPE ? round(spx / marketPath.forwardPE, 2) : null,
      indexLevel: spx ? round(spx, 2) : null,
      sectors: SECTOR_ORDER.map((sector) => { const p = forwardPath(rows.filter((r) => r.sector === sector), today); return p && { sector, companies: p.companies, forwardPE: p.forwardPE, changePct: p.changePct }; }).filter(Boolean),
    };
    if (forward) delete forward.earningsNow;
    const revenueOf = (list) => list.filter((r) => !SECOND_CLASSES.has(r.ticker)).reduce((s, r) => { const v = ntm(r.fy1Revenue, r.fy2Revenue, r.fyEndDate, today); return s + (Number.isFinite(v) ? v : 0); }, 0);
    const earningsOf = (list) => list.reduce((s, r) => { const v = ntm(r.fy1Eps[0], r.fy2Eps[0], r.fyEndDate, today); return s + (r.shares && Number.isFinite(v) ? r.shares * v : 0); }, 0);

    const latest = {
      generated_at_utc: generatedAt,
      universe_size: rows.length,
      universe_total: BREADTH_CONSTITUENTS.length,
      market: {
        netRevisionRatio30: marketNrr,
        drift30: marketDrift30,
        upTotal,
        downTotal,
      },
      sectors: sectorAgg,
      forward,
      scatter: scatterPoints,
      upgrades: upgrades.map(leaderboardRow),
      downgrades: downgrades.map(leaderboardRow),
    };

    const store = getRevisionsStore();
    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];
    latest.revenueVsEps = revenueVsEps(points, { date: today, earnings: earningsOf(rows), revenue: revenueOf(rows), sectorTotals: Object.fromEntries(SECTOR_ORDER.map((sec) => { const list = rows.filter((r) => r.sector === sec); return [sec, { earnings: earningsOf(list), revenue: revenueOf(list) }]; })) });
    await store.setJSON(LATEST_KEY, latest);

    const todayDate = generatedAt.slice(0, 10);
    // A re-run on the same UTC day (manual trigger, redeploy) replaces that
    // day's point instead of appending a duplicate.
    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push({
      date: todayDate,
      marketNrr,
      marketDrift30,
      sectors: Object.fromEntries(sectorAgg.map((s) => [s.sector, s.netRevisionRatio30])),
      // Forward earnings and revenue totals ($), so revenue and EPS
      // revisions can be compared week to week from here on.
      forwardEps: forward ? forward.indexEps : null,
      earnings: Math.round(earningsOf(rows)),
      revenue: Math.round(revenueOf(rows)),
      sectorTotals: Object.fromEntries(SECTOR_ORDER.map((sec) => { const list = rows.filter((r) => r.sector === sec); return [sec, { earnings: Math.round(earningsOf(list)), revenue: Math.round(revenueOf(list)) }]; })),
    });
    const trimmed = filtered.slice(-MAX_HISTORY_POINTS);
    await store.setJSON(HISTORY_KEY, { points: trimmed });

    console.log(`scheduled-revisions-background: wrote ${rows.length} rows across ${sectorAgg.length} sectors, history now ${trimmed.length} points`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, rows: rows.length, sectors: sectorAgg.length }) };
  } catch (err) {
    console.error(`scheduled-revisions-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports.ntm = ntm;
module.exports.forwardPath = forwardPath;
module.exports.revenueVsEps = revenueVsEps;
