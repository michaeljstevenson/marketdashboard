// Scheduled Background Function (see [functions."scheduled-dispersion-
// background"] in netlify.toml) that computes analyst estimate dispersion
// — how much individual analysts disagree with each other about a stock's
// current-fiscal-year EPS, not just where the consensus average sits —
// across the S&P 500, for the analyst-estimate-dispersion.html page.
//
// For each constituent (reusing breadth-constituents.js), pulls Alpha
// Vantage's EARNINGS_ESTIMATES and reads the current-fiscal-year (FY1) row's
// high/low/average EPS estimate. Dispersion is expressed as a relative
// range: (high − low) / |average| × 100 — a simple, scale-free disagreement
// measure (AV doesn't expose the full per-analyst distribution, only the
// high/low/average/count, so a standard deviation isn't available; a
// relative range is the best disagreement measure this data supports).
// This is a distinct question from scheduled-revisions-background.js's Net
// Revision Ratio / Estimate Drift, which ask whether the consensus is
// moving and by how much — a stock can have a tightly-clustered consensus
// that's moving fast (low dispersion, high drift) or a widely-split
// consensus that's stable (high dispersion, low drift).
//
// Sector and company name come from the beeswarm store's meta.json (see
// beeswarm-blob-store.js / scheduled-beeswarm-meta-background.js), the same
// reuse pattern as scheduled-revisions-background.js, rather than a fresh
// OVERVIEW call per ticker.
//
// Runs weekly (Saturday), after scheduled-share-count-background (10:50 UTC,
// ~9-10 minutes for its own full sweep) so this job's own ~503 sequential
// EARNINGS_ESTIMATES calls don't compete with it for the rate limit. Weekly,
// not daily, for the same reason as scheduled-revisions-background.js:
// analyst dispersion on a current-fiscal-year estimate doesn't meaningfully
// move day to day, and a full-index sweep is the expensive kind of job this
// site reserves for weekly cadence.

const { getDispersionStore, LATEST_KEY, HISTORY_KEY } = require("./dispersion-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_HISTORY_POINTS = 260; // ~5 years of weekly snapshots
const MIN_ANALYSTS_FOR_LEADERBOARD = 5; // a 2-analyst spread is nearly always noise, not signal

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

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

  // Same FY1 selection as scheduled-revisions-background.js: the nearest-
  // dated "fiscal year" horizon row is always the in-progress or next-to-
  // report fiscal year.
  const fyRows = estimates.filter((e) => e.horizon === "fiscal year" && e.date);
  if (!fyRows.length) return null;
  fyRows.sort((a, b) => (a.date < b.date ? -1 : 1));
  const fy1 = fyRows[0];

  const epsAvg = num(fy1.eps_estimate_average);
  const epsHigh = num(fy1.eps_estimate_high);
  const epsLow = num(fy1.eps_estimate_low);
  const analystCount = num(fy1.eps_estimate_analyst_count);
  const up30 = count(fy1.eps_estimate_revision_up_trailing_30_days);
  const down30 = count(fy1.eps_estimate_revision_down_trailing_30_days);

  const dispersion =
    epsAvg !== null && epsAvg !== 0 && epsHigh !== null && epsLow !== null
      ? ((epsHigh - epsLow) / Math.abs(epsAvg)) * 100
      : null;

  return {
    fyEndDate: fy1.date,
    analystCount,
    epsAvg,
    epsHigh,
    epsLow,
    dispersion,
    revisionChurn30: up30 + down30,
  };
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function round(v, d = 3) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

exports.handler = async () => {
  console.log(`scheduled-dispersion-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
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
        console.error(`scheduled-dispersion-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    // Two passes, same cadence as scheduled-revisions-background.js: ~1.05s
    // between calls, a minute+ cooling-off before retrying whatever the
    // first pass missed.
    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-dispersion-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-dispersion-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);

    const rows = [];
    for (const [symbol, est] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      rows.push({
        ticker: symbol,
        name: m.name || symbol,
        sector: m.sector,
        ...est,
      });
    }

    if (!rows.length) throw new Error("No tickers resolved with both estimates and sector metadata");

    const withDispersion = rows.filter((r) => r.dispersion !== null);

    const sectorAgg = SECTOR_ORDER.map((sector) => {
      const inSector = withDispersion.filter((r) => r.sector === sector);
      return {
        sector,
        count: inSector.length,
        medianDispersion: round(median(inSector.map((r) => r.dispersion))),
        meanDispersion: round(mean(inSector.map((r) => r.dispersion))),
      };
    }).filter((s) => s.count > 0);

    const marketMedianDispersion = round(median(withDispersion.map((r) => r.dispersion)));
    const marketMeanDispersion = round(mean(withDispersion.map((r) => r.dispersion)));

    const eligible = withDispersion.filter((r) => r.analystCount !== null && r.analystCount >= MIN_ANALYSTS_FOR_LEADERBOARD);
    const mostDisagreement = [...eligible].sort((a, b) => b.dispersion - a.dispersion).slice(0, 10);
    const leastDisagreement = [...eligible].sort((a, b) => a.dispersion - b.dispersion).slice(0, 10);

    const leaderboardRow = (r) => ({
      ticker: r.ticker,
      name: r.name,
      sector: r.sector,
      epsAvg: round(r.epsAvg, 2),
      epsHigh: round(r.epsHigh, 2),
      epsLow: round(r.epsLow, 2),
      dispersion: round(r.dispersion, 1),
      analystCount: r.analystCount,
    });

    // Dispersion vs. revision churn: does more analyst disagreement about
    // where EPS should land coincide with more analysts actually changing
    // their number (up or down) in a given 30-day window? Only meaningful
    // with enough analysts that "churn" isn't just 1-2 people moving.
    const scatterPoints = eligible.map((r) => ({
      ticker: r.ticker,
      sector: r.sector,
      dispersion: round(r.dispersion, 2),
      revisionChurn30: r.revisionChurn30,
    }));

    const histogram = withDispersion.map((r) => round(r.dispersion, 2));

    const generatedAt = new Date().toISOString();

    const latest = {
      generated_at_utc: generatedAt,
      universe_size: rows.length,
      universe_total: BREADTH_CONSTITUENTS.length,
      dispersion_coverage: withDispersion.length,
      market: {
        medianDispersion: marketMedianDispersion,
        meanDispersion: marketMeanDispersion,
      },
      sectors: sectorAgg,
      histogram,
      scatter: scatterPoints,
      mostDisagreement: mostDisagreement.map(leaderboardRow),
      leastDisagreement: leastDisagreement.map(leaderboardRow),
    };

    const store = getDispersionStore();
    await store.setJSON(LATEST_KEY, latest);

    const history = (await store.get(HISTORY_KEY, { type: "json" })) || { points: [] };
    const points = Array.isArray(history.points) ? history.points : [];
    const todayDate = generatedAt.slice(0, 10);
    const filtered = points.filter((p) => p.date !== todayDate);
    filtered.push({
      date: todayDate,
      marketMedianDispersion,
      sectors: Object.fromEntries(sectorAgg.map((s) => [s.sector, s.medianDispersion])),
    });
    const trimmed = filtered.slice(-MAX_HISTORY_POINTS);
    await store.setJSON(HISTORY_KEY, { points: trimmed });

    console.log(`scheduled-dispersion-background: wrote ${rows.length} rows (${withDispersion.length} with dispersion) across ${sectorAgg.length} sectors, history now ${trimmed.length} points`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, rows: rows.length, sectors: sectorAgg.length }) };
  } catch (err) {
    console.error(`scheduled-dispersion-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
