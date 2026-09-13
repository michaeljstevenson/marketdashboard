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

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_HISTORY_POINTS = 260; // ~5 years of weekly snapshots
const MIN_ANALYSTS_FOR_LEADERBOARD = 3; // thin coverage makes drift/NRR noisy

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
    const rows = [];
    for (const [symbol, est] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      rows.push({
        ticker: symbol,
        name: m.name || symbol,
        sector: m.sector,
        marketCap: m.marketCap || null,
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
      scatter: scatterPoints,
      upgrades: upgrades.map(leaderboardRow),
      downgrades: downgrades.map(leaderboardRow),
    };

    const store = getRevisionsStore();
    await store.setJSON(LATEST_KEY, latest);

    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];
    const todayDate = generatedAt.slice(0, 10);
    // A re-run on the same UTC day (manual trigger, redeploy) replaces that
    // day's point instead of appending a duplicate.
    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push({
      date: todayDate,
      marketNrr,
      marketDrift30,
      sectors: Object.fromEntries(sectorAgg.map((s) => [s.sector, s.netRevisionRatio30])),
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
