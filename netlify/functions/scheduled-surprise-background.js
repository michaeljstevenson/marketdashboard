// Scheduled Background Function (see [functions."scheduled-surprise-background"]
// in netlify.toml) that builds the S&P 500 earnings-surprise panel for the
// earnings-surprise.html page: beat/miss rates by sector and over time, the
// distribution of surprise magnitudes, and a test of whether a beat (or
// miss) tends to be followed by another one next quarter ("surprise
// persistence" — the empirical basis for post-earnings-announcement-drift
// strategies).
//
// For each constituent (reusing breadth-constituents.js), pulls Alpha
// Vantage's EARNINGS endpoint, which returns the full quarterly EPS history
// (actual, estimate, surprise %) in one call — unlike EARNINGS_ESTIMATES
// (used by scheduled-revisions-background.js), this is a real historical
// panel, so the "beat rate over time" trend is recomputed fresh from actual
// past quarters each run rather than an accumulating weekly snapshot.
//
// Sector and company name come from the beeswarm store's meta.json, same
// reuse pattern as scheduled-revisions-background.js and
// scheduled-insider-transactions-background.js — avoids a second ~503-call
// OVERVIEW sweep for data that page already refreshes weekly.
//
// Runs weekly (Saturday), well after the rest of the Saturday block so it
// doesn't overlap another full-universe sweep still finishing (see
// netlify.toml). Earnings results only change once a quarter per company,
// so weekly recomputation is about keeping the "latest reported quarter"
// window current as new companies report through each earnings season, not
// because any individual company's data goes stale faster than that.
//
// Pacing mirrors the other full-sweep jobs on this site: ~1.05s between
// calls, two passes with a 65s cooling-off between them.

const { getSurpriseStore, LATEST_KEY } = require("./surprise-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_QUARTERS_KEPT = 13; // ~3 years, plus one extra for lag-1 pairing at the edge
const MIN_EST_EPS_ABS = 0.05; // a consensus estimate smaller than a nickel makes surprise% divide-by-near-zero noise
const MAX_ABS_SURPRISE_PCT = 200; // clip the (rare) blow-up prints past this rather than let one stock dominate a mean
const MIN_QUARTER_COVERAGE_LATEST = 0.5; // share of the mapped universe that must have reported for a quarter to count as "latest"
const MIN_QUARTER_COVERAGE_TREND = 30; // absolute floor (companies) for a quarter to appear on the trend line at all
const TREND_QUARTERS = 12;
const MIN_STREAK_LEN = 3; // leaderboard floor — a 1- or 2-quarter "streak" isn't informative
const DIST_BINS = [-Infinity, -20, -10, -5, 0, 5, 10, 20, Infinity];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  if (v === null || v === undefined || v === "None") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 3) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
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

// Calendarized fiscal quarter: buckets by the month of fiscalDateEnding
// (Jan-Mar -> Q1, Apr-Jun -> Q2, Jul-Sep -> Q3, Oct-Dec -> Q4) so companies
// on non-calendar fiscal years (Apple's FY ends in September, for example)
// still land in the same bucket as calendar-year peers reporting a similar
// real-world period — an approximation, not exact fiscal alignment, but the
// standard convention financial sites use for cross-company quarter charts.
function quarterKeyFromDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const qIdx = Math.floor(d.getUTCMonth() / 3); // 0..3
  return { key: year * 4 + qIdx, label: `${year} Q${qIdx + 1}` };
}

async function fetchEarnings(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(`${ALPHA_VANTAGE_URL}?function=EARNINGS&symbol=${symbol}&apikey=${apiKey}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const qs = payload.quarterlyEarnings;
  if (!Array.isArray(qs) || !qs.length) return null;

  const rows = [];
  for (const q of qs) {
    const est = num(q.estimatedEPS);
    const surprisePct = num(q.surprisePercentage);
    if (est === null || surprisePct === null) continue;
    if (Math.abs(est) < MIN_EST_EPS_ABS) continue;
    if (Math.abs(surprisePct) > MAX_ABS_SURPRISE_PCT) continue;
    const qk = quarterKeyFromDate(q.fiscalDateEnding);
    if (!qk) continue;
    rows.push({
      key: qk.key,
      label: qk.label,
      fiscalDateEnding: q.fiscalDateEnding,
      reportedDate: q.reportedDate || null,
      reportedEPS: num(q.reportedEPS),
      estimatedEPS: est,
      surprisePct,
      beat: surprisePct > 0 ? 1 : surprisePct < 0 ? -1 : 0,
    });
    if (rows.length >= MAX_QUARTERS_KEPT) break; // qs is already newest-first
  }
  return rows;
}

// Two-proportion z-test (pooled variance) — used to say whether "beat rate
// after a beat" and "beat rate after a miss" differ by more than sampling
// noise would produce, not just eyeball two percentages next to each other.
function twoProportionZ(p1, n1, p2, n2) {
  if (!n1 || !n2) return null;
  const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return se > 0 ? (p1 - p2) / se : null;
}

// Abramowitz-Stegun normal CDF approximation — plenty accurate for a
// descriptive p-value on a site that isn't running a stats package.
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

function twoTailedP(z) {
  if (z === null) return null;
  return round(2 * (1 - normalCdf(Math.abs(z))), 4);
}

exports.handler = async () => {
  console.log(`scheduled-surprise-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const rows = await fetchEarnings(apiKey, symbol);
        if (rows && rows.length) results.set(symbol, rows);
        return true;
      } catch (err) {
        console.error(`scheduled-surprise-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-surprise-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-surprise-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);

    // Join against sector/name metadata; drop anything unmapped so it can't
    // distort a sector aggregate under the wrong column.
    const companies = [];
    for (const [symbol, quarters] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      companies.push({ ticker: symbol, name: m.name || symbol, sector: m.sector, quarters });
    }
    if (!companies.length) throw new Error("No tickers resolved with both earnings data and sector metadata");

    // Group every (company, quarter) observation by calendarized quarter.
    const byQuarter = new Map();
    for (const c of companies) {
      for (const q of c.quarters) {
        if (!byQuarter.has(q.key)) byQuarter.set(q.key, { key: q.key, label: q.label, entries: [] });
        byQuarter.get(q.key).entries.push({ ticker: c.ticker, name: c.name, sector: c.sector, ...q });
      }
    }
    const quarterKeysDesc = [...byQuarter.keys()].sort((a, b) => b - a);

    // "Latest quarter" for the headline stats/leaderboards: the most recent
    // quarter where at least half the mapped universe has reported —
    // avoids a headline number based on the 20 companies that report
    // first each season.
    const coverageFloor = companies.length * MIN_QUARTER_COVERAGE_LATEST;
    const latestKey = quarterKeysDesc.find((k) => byQuarter.get(k).entries.length >= coverageFloor);
    const latestQuarter = latestKey !== undefined ? byQuarter.get(latestKey) : null;
    if (!latestQuarter) throw new Error("No quarter reached the minimum coverage threshold");

    const latestEntries = latestQuarter.entries;
    const latestBeats = latestEntries.filter((e) => e.beat > 0).length;
    const latestMisses = latestEntries.filter((e) => e.beat < 0).length;
    const marketBeatRate = round((latestBeats / latestEntries.length) * 100, 2);
    const marketAvgSurprise = round(mean(latestEntries.map((e) => e.surprisePct)), 2);
    const marketMedianSurprise = round(median(latestEntries.map((e) => e.surprisePct)), 2);

    // Sector breakdown for the latest quarter.
    const sectorAgg = SECTOR_ORDER.map((sector) => {
      const inSector = latestEntries.filter((e) => e.sector === sector);
      if (!inSector.length) return null;
      const beats = inSector.filter((e) => e.beat > 0).length;
      return {
        sector,
        count: inSector.length,
        beatRate: round((beats / inSector.length) * 100, 1),
        avgSurprise: round(mean(inSector.map((e) => e.surprisePct)), 2),
      };
    }).filter(Boolean);

    // Magnitude distribution, latest quarter.
    const distribution = [];
    for (let i = 0; i < DIST_BINS.length - 1; i++) {
      const lo = DIST_BINS[i];
      const hi = DIST_BINS[i + 1];
      const count = latestEntries.filter((e) => e.surprisePct >= lo && e.surprisePct < hi).length;
      const label = lo === -Infinity ? `< ${hi}%` : hi === Infinity ? `≥ ${lo}%` : `${lo}% to ${hi}%`;
      distribution.push({ label, lo, hi, count });
    }

    // Trend: last N quarters with enough absolute coverage to be meaningful,
    // oldest to newest.
    const trend = quarterKeysDesc
      .filter((k) => byQuarter.get(k).entries.length >= MIN_QUARTER_COVERAGE_TREND)
      .slice(0, TREND_QUARTERS)
      .reverse()
      .map((k) => {
        const q = byQuarter.get(k);
        const beats = q.entries.filter((e) => e.beat > 0).length;
        return {
          label: q.label,
          count: q.entries.length,
          beatRate: round((beats / q.entries.length) * 100, 2),
          avgSurprise: round(mean(q.entries.map((e) => e.surprisePct)), 2),
        };
      });

    // Persistence: pooled lag-1 panel. For each company, walk its own
    // chronological quarter sequence and pair each quarter with the one
    // immediately before it *in that company's filtered list* — which is
    // usually, but not guaranteed to be, the adjacent real-world quarter
    // (a filtered-out quarter — e.g. a near-zero estimate — leaves a gap
    // rather than breaking the pairing entirely).
    let followBeatBeats = 0, followBeatTotal = 0;
    let followMissBeats = 0, followMissTotal = 0;
    let unconditionalBeats = 0, unconditionalTotal = 0;
    const streaksBeat = [];
    const streaksMiss = [];
    for (const c of companies) {
      const asc = [...c.quarters].sort((a, b) => a.key - b.key);
      for (let i = 1; i < asc.length; i++) {
        const prev = asc[i - 1];
        const curr = asc[i];
        unconditionalTotal++;
        if (curr.beat > 0) unconditionalBeats++;
        if (prev.beat > 0) {
          followBeatTotal++;
          if (curr.beat > 0) followBeatBeats++;
        } else if (prev.beat < 0) {
          followMissTotal++;
          if (curr.beat > 0) followMissBeats++;
        }
      }
      // Current streak from most recent quarter backward.
      const desc = [...c.quarters].sort((a, b) => b.key - a.key);
      if (desc.length) {
        const dir = desc[0].beat;
        if (dir !== 0) {
          let len = 0;
          for (const q of desc) {
            if (q.beat === dir) len++;
            else break;
          }
          if (len >= MIN_STREAK_LEN) {
            const row = {
              ticker: c.ticker,
              name: c.name,
              sector: c.sector,
              streak: len,
              latestSurprisePct: round(desc[0].surprisePct, 2),
              latestQuarterLabel: desc[0].label,
            };
            if (dir > 0) streaksBeat.push(row);
            else streaksMiss.push(row);
          }
        }
      }
    }
    streaksBeat.sort((a, b) => b.streak - a.streak || b.latestSurprisePct - a.latestSurprisePct);
    streaksMiss.sort((a, b) => b.streak - a.streak || a.latestSurprisePct - b.latestSurprisePct);

    const pBeatFollowBeat = followBeatTotal ? followBeatBeats / followBeatTotal : null;
    const pBeatFollowMiss = followMissTotal ? followMissBeats / followMissTotal : null;
    const pBeatUnconditional = unconditionalTotal ? unconditionalBeats / unconditionalTotal : null;
    const persistenceZ =
      pBeatFollowBeat !== null && pBeatFollowMiss !== null
        ? twoProportionZ(pBeatFollowBeat, followBeatTotal, pBeatFollowMiss, followMissTotal)
        : null;

    const persistence = {
      beatRateAfterBeat: round(pBeatFollowBeat * 100, 2),
      beatRateAfterMiss: round(pBeatFollowMiss * 100, 2),
      unconditionalBeatRate: round(pBeatUnconditional * 100, 2),
      nAfterBeat: followBeatTotal,
      nAfterMiss: followMissTotal,
      z: round(persistenceZ, 3),
      pValue: twoTailedP(persistenceZ),
    };

    const leaderboardRow = (r) => ({
      ticker: r.ticker,
      name: r.name,
      sector: r.sector,
      streak: r.streak,
      latestSurprisePct: r.latestSurprisePct,
      latestQuarterLabel: r.latestQuarterLabel,
    });

    const surpriseRow = (e) => ({
      ticker: e.ticker,
      name: e.name,
      sector: e.sector,
      surprisePct: round(e.surprisePct, 2),
      reportedEPS: round(e.reportedEPS, 2),
      estimatedEPS: round(e.estimatedEPS, 2),
    });

    const biggestBeats = [...latestEntries].sort((a, b) => b.surprisePct - a.surprisePct).slice(0, 10).map(surpriseRow);
    const biggestMisses = [...latestEntries].sort((a, b) => a.surprisePct - b.surprisePct).slice(0, 10).map(surpriseRow);

    const latest = {
      generated_at_utc: new Date().toISOString(),
      universe_size: companies.length,
      universe_total: BREADTH_CONSTITUENTS.length,
      latestQuarter: { label: latestQuarter.label, count: latestEntries.length },
      market: {
        beatRate: marketBeatRate,
        avgSurprise: marketAvgSurprise,
        medianSurprise: marketMedianSurprise,
        beats: latestBeats,
        misses: latestMisses,
        meets: latestEntries.length - latestBeats - latestMisses,
      },
      sectors: sectorAgg,
      distribution,
      trend,
      persistence,
      streaksBeat: streaksBeat.slice(0, 10).map(leaderboardRow),
      streaksMiss: streaksMiss.slice(0, 10).map(leaderboardRow),
      biggestBeats,
      biggestMisses,
    };

    const store = getSurpriseStore();
    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-surprise-background: wrote ${companies.length} companies, latest quarter ${latestQuarter.label} (n=${latestEntries.length}), trend ${trend.length} quarters`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, latestQuarter: latestQuarter.label }) };
  } catch (err) {
    console.error(`scheduled-surprise-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
