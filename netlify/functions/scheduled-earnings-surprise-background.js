// Scheduled Background Function (see [functions."scheduled-earnings-
// surprise-background"] in netlify.toml) that sweeps Alpha Vantage's
// EARNINGS endpoint (quarterly reported vs. estimated EPS, with the
// surprise and surprise% already computed by Alpha Vantage) across the
// full S&P 500, for the earnings-surprise.html page.
//
// Unlike EARNINGS_ESTIMATES (a point-in-time snapshot, which is why
// scheduled-revisions-background.js has to accumulate its own weekly
// history blob), EARNINGS returns each company's last several actual
// reported quarters in a single call — so the market-wide beat-rate trend
// chart here is built directly from one sweep, no history accumulation
// needed.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than
// paying for a second ~503-call OVERVIEW sweep just for labels — same
// pattern as scheduled-revisions-background.js and
// scheduled-insider-transactions-background.js.
//
// Weekly, not daily: a company reports earnings once a quarter, so a
// trailing-8-quarter beat/miss history barely moves day to day.
//
// ~503 sequential calls, 1050ms apart with a retry pass — same pacing
// proven at this exact scale by scheduled-beeswarm-meta-background.js's
// OVERVIEW sweep.

const { getSurpriseStore, BLOB_KEY } = require("./earnings-surprise-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_LOOKBACK = 8; // ~2 years
const NOTABLE_COUNT = 15;
const RECENT_DAYS = 100; // ~one reporting season, for the "this quarter" leaderboards

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function classify(surprisePct) {
  if (surprisePct > 0) return "beat";
  if (surprisePct < 0) return "miss";
  return "inline";
}

async function fetchEarnings(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=EARNINGS&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.quarterlyEarnings;
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);

  // Alpha Vantage returns quarterlyEarnings most-recent-first already;
  // keep only quarters with a real analyst estimate on file (older history
  // often reports "None") and cap at the lookback window.
  return rows
    .filter((r) => r.estimatedEPS !== "None" && r.surprisePercentage !== "None")
    .slice(0, QUARTERS_LOOKBACK)
    .map((r) => {
      const surprisePct = parseFloat(r.surprisePercentage);
      return {
        fiscalDateEnding: r.fiscalDateEnding,
        reportedDate: r.reportedDate,
        reportedEPS: parseFloat(r.reportedEPS),
        estimatedEPS: parseFloat(r.estimatedEPS),
        surprisePct: Number.isFinite(surprisePct) ? round(surprisePct) : null,
        classification: Number.isFinite(surprisePct) ? classify(surprisePct) : null,
      };
    })
    .filter((r) => r.classification !== null);
}

function calendarQuarterLabel(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}

// Two-proportion z-test — same normal-approximation machinery
// (normalCdf/erf) used client-side throughout /factor-analysis, just
// applied to a difference in beat-rate proportions instead of a
// regression slope.
function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function twoProportionZTest(k1, n1, k0, n0) {
  if (n1 < 5 || n0 < 5) return null;
  const p1 = k1 / n1, p0 = k0 / n0;
  const pooled = (k1 + k0) / (n1 + n0);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n0));
  if (se === 0) return null;
  const z = (p1 - p0) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { n1, p1: round(p1 * 100), n0, p0: round(p0 * 100), z: round(z), p: round(p, 4) };
}

exports.handler = async () => {
  console.log(`scheduled-earnings-surprise-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchEarnings(apiKey, symbol);
        if (quarters.length) results.set(symbol, quarters);
        return true;
      } catch (err) {
        console.error(`scheduled-earnings-surprise-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-earnings-surprise-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-earnings-surprise-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, quarters] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;

      const beatCount = quarters.filter((q) => q.classification === "beat").length;
      const missCount = quarters.filter((q) => q.classification === "miss").length;
      const inlineCount = quarters.filter((q) => q.classification === "inline").length;
      const avgSurprisePct = round(quarters.reduce((s, q) => s + q.surprisePct, 0) / quarters.length);

      // Current streak: consecutive matching non-inline classifications
      // counting back from the most recent quarter (index 0).
      let currentStreak = 0;
      const latestClass = quarters[0].classification;
      if (latestClass !== "inline") {
        for (const q of quarters) {
          if (q.classification !== latestClass) break;
          currentStreak++;
        }
        if (latestClass === "miss") currentStreak = -currentStreak;
      }

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        quarters,
        beatCount,
        missCount,
        inlineCount,
        beatRate: round((beatCount / quarters.length) * 100),
        avgSurprisePct,
        currentStreak,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both earnings history and sector metadata");

    // Flatten to one row per qualifying company-quarter for pooled
    // sector/market beat-rate math (weights naturally by how many
    // qualifying quarters each company contributed, rather than treating
    // a company with 8 quarters the same as one with 2).
    const flat = companies.flatMap((c) => c.quarters.map((q) => ({ ...q, sector: c.sector, symbol: c.symbol })));

    function poolStats(rows) {
      const beat = rows.filter((r) => r.classification === "beat").length;
      const miss = rows.filter((r) => r.classification === "miss").length;
      const inline = rows.filter((r) => r.classification === "inline").length;
      const avgSurprisePct = round(rows.reduce((s, r) => s + r.surprisePct, 0) / rows.length);
      return { quarterCount: rows.length, beat, miss, inline, beatRate: round((beat / rows.length) * 100), avgSurprisePct };
    }

    const market = { companyCount: companies.length, ...poolStats(flat) };

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const rows = flat.filter((r) => r.sector === sector);
        if (!rows.length) return null;
        const companyCount = new Set(rows.map((r) => r.symbol)).size;
        return { sector, companyCount, ...poolStats(rows) };
      })
      .filter(Boolean);

    // Market-wide beat-rate trend by calendar quarter — needs a real
    // sample per quarter, so quarters with too few reports on file yet
    // (e.g. the just-started current quarter) are dropped rather than
    // shown as a noisy 100%-or-0% data point.
    const byQuarter = new Map();
    for (const r of flat) {
      const label = calendarQuarterLabel(r.reportedDate);
      if (!byQuarter.has(label)) byQuarter.set(label, []);
      byQuarter.get(label).push(r);
    }
    const MIN_QUARTER_SAMPLE = 30;
    const history = [...byQuarter.entries()]
      .filter(([, rows]) => rows.length >= MIN_QUARTER_SAMPLE)
      .map(([label, rows]) => ({ quarter: label, ...poolStats(rows) }))
      .sort((a, b) => (a.quarter < b.quarter ? -1 : 1))
      .slice(-12);

    // Persistence test: does beating (or missing) last quarter predict
    // beating this quarter? Built from consecutive same-company quarter
    // pairs, inline quarters on either side dropped to keep it a clean
    // binary comparison.
    let k1 = 0, n1 = 0, k0 = 0, n0 = 0; // 1 = prior beat, 0 = prior miss
    for (const c of companies) {
      for (let i = 0; i < c.quarters.length - 1; i++) {
        const current = c.quarters[i], prior = c.quarters[i + 1]; // index 0 = most recent
        if (current.classification === "inline" || prior.classification === "inline") continue;
        if (prior.classification === "beat") {
          n1++;
          if (current.classification === "beat") k1++;
        } else {
          n0++;
          if (current.classification === "beat") k0++;
        }
      }
    }
    const persistence = twoProportionZTest(k1, n1, k0, n0);

    const beatStreakLeaders = [...companies]
      .filter((c) => c.currentStreak > 0)
      .sort((a, b) => b.currentStreak - a.currentStreak || b.avgSurprisePct - a.avgSurprisePct)
      .slice(0, NOTABLE_COUNT)
      .map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, currentStreak: c.currentStreak, avgSurprisePct: c.avgSurprisePct }));

    const missStreakLeaders = [...companies]
      .filter((c) => c.currentStreak < 0)
      .sort((a, b) => a.currentStreak - b.currentStreak)
      .slice(0, NOTABLE_COUNT)
      .map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, currentStreak: c.currentStreak, avgSurprisePct: c.avgSurprisePct }));

    const now = new Date();
    const recentCutoff = new Date(now.getTime() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
    const mostRecentPerCompany = companies
      .filter((c) => c.quarters[0].reportedDate >= recentCutoff)
      .map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, ...c.quarters[0] }));

    const biggestBeats = [...mostRecentPerCompany].sort((a, b) => b.surprisePct - a.surprisePct).slice(0, NOTABLE_COUNT);
    const biggestMisses = [...mostRecentPerCompany].sort((a, b) => a.surprisePct - b.surprisePct).slice(0, NOTABLE_COUNT);

    const payload = {
      generated_at_utc: now.toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      quartersLookback: QUARTERS_LOOKBACK,
      market,
      sectors,
      history,
      persistence,
      beatStreakLeaders,
      missStreakLeaders,
      biggestBeats,
      biggestMisses,
      companies: companies.map((c) => ({
        symbol: c.symbol, name: c.name, sector: c.sector, beatCount: c.beatCount, missCount: c.missCount,
        inlineCount: c.inlineCount, beatRate: c.beatRate, avgSurprisePct: c.avgSurprisePct, currentStreak: c.currentStreak,
      })),
    };

    await getSurpriseStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-earnings-surprise-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-earnings-surprise-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
