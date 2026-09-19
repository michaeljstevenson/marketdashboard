// Scheduled Background Function (see
// [functions."scheduled-earnings-call-sentiment-background"] in
// netlify.toml) that builds the "Earnings Call Sentiment" page: does
// management's own tone on the earnings call track the number they just
// reported, and how does that tone compare to the tone of the analysts
// questioning them?
//
// One-time snapshot, no recurring schedule — matches the convention this
// repo adopted for every Equities page added the same night as this one
// (see netlify.toml's other "one-time snapshot" comments and commit
// 704645f). Can be re-run manually (Netlify dashboard "Run now") for a
// fresh pass later.
//
// Two Alpha Vantage endpoints per constituent, not one:
//   1. EARNINGS — not (only) for the EPS numbers, but to resolve which
//      fiscal-quarter label ("YYYYQ#") the transcript endpoint actually
//      wants. Alpha Vantage's EARNINGS_CALL_TRANSCRIPT takes a quarter in
//      each company's OWN fiscal-quarter numbering (confirmed directly:
//      AAPL's quarter ending 2025-06-30 is "2025Q3", matching the call's
//      own "Q3 Fiscal Year 2025" self-description, since Apple's fiscal
//      year ends in September — not calendar-Q2/"2025Q2"). EARNINGS
//      returns no such label directly, so it's derived here: the fiscal
//      year-end month is the mode of annualEarnings[].fiscalDateEnding
//      months (mode, not just the first entry, since this endpoint's most
//      recent annual row is occasionally a partial/TTM-style entry that
//      doesn't land on the company's real fiscal year-end — seen live on
//      WMT, whose first annualEarnings row was dated six months off the
//      rest of its own series), then each quarterlyEarnings row's own
//      fiscal quarter number and year are derived from how its
//      fiscalDateEnding month sits relative to that fiscal year-end. This
//      also hands back that same quarter's surprise% for free, so the
//      page's core stats test (does call tone track the number) needs no
//      second data source.
//   2. EARNINGS_CALL_TRANSCRIPT, for the resolved label — full per-speaker
//      transcript with Alpha Vantage's own LLM-derived per-turn sentiment
//      score.
//
// Deliberately does NOT fall back to the prior quarter when the resolved
// label comes back with an empty transcript (confirmed live: WMT's most
// recently reported quarter at the time of writing had no transcript yet,
// while the one before it did — Alpha Vantage's transcript indexing lags
// the earnings release itself by some unknown number of weeks). A
// same-run fallback would need a second transcript call for every company
// that just reported, on top of the ~1,000 calls this sweep already
// makes — pushing a job already close to the ~15-minute Background
// Function ceiling (see the pacing note below) over it for uncertain
// benefit. A company whose latest quarter isn't indexed yet simply isn't
// in this snapshot until a later manual re-run — logged as a real,
// disclosed limitation (see the page's own methodology section), not
// silently patched over.
//
// ~1,000 sequential calls (two per resolved company, one for companies
// whose EARNINGS call itself fails), paced at 750ms — the same rate this
// codebase's other two-endpoint-per-company sweep
// (scheduled-margin-leverage-background.js, ~1,006 calls) already uses
// for the identical reason: doubling calls-per-company nearly doubles
// total sweep time against the same ~15-minute ceiling, so pacing is
// tighter here than the ~1,050ms used by this file's single-endpoint
// sweeps.

const { getEarningsCallSentimentStore, BLOB_KEY } = require("./earnings-call-sentiment-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CALL_PACING_MS = 750;
const MIN_EST_EPS_ABS = 0.05; // matches scheduled-surprise-background.js — a sub-nickel estimate makes surprise% divide-by-near-zero noise
const MAX_ABS_SURPRISE_PCT = 200; // matches scheduled-surprise-background.js — clip rare blowup prints rather than let one stock dominate the regression
const MIN_TURNS_FOR_LEADERBOARD = 3; // a 1-2 turn "average" tone isn't a meaningful signal
const LEADERBOARD_COUNT = 10;
const DIST_BIN_WIDTH = 0.1; // sentiment is a 0..1 scale (see page methodology) — ten bins

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  if (v === null || v === undefined || v === "None") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 3) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
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

function monthOf(dateStr) {
  if (!dateStr || dateStr.length < 7) return null;
  const m = parseInt(dateStr.slice(5, 7), 10);
  return Number.isFinite(m) ? m : null;
}

function yearOf(dateStr) {
  if (!dateStr || dateStr.length < 4) return null;
  const y = parseInt(dateStr.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

// Mode of the annualEarnings months, not just the first entry's — see the
// file header comment on why (a stray partial/TTM row can otherwise pick
// the wrong fiscal year-end month).
function fyEndMonthFromAnnual(annualEarnings) {
  const counts = new Map();
  for (const a of annualEarnings || []) {
    const m = monthOf(a.fiscalDateEnding);
    if (!m) continue;
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [m, c] of counts.entries()) {
    if (c > bestCount) {
      bestCount = c;
      best = m;
    }
  }
  return best;
}

// Derives Alpha Vantage's own "YYYYQ#" quarter label (each company's own
// fiscal numbering, not calendar quarter) from a quarterlyEarnings row's
// fiscalDateEnding and the company's fiscal year-end month. Validated live
// against AAPL (FYE September; quarter ending 2025-06-30 -> "2025Q3",
// matching the call's own "Q3 Fiscal Year 2025" self-description) and WMT
// (FYE January; quarter ending 2025-01-31 -> "2025Q4", matching "Fourth
// Quarter Fiscal Year 2025").
function quarterLabelFor(fiscalDateEnding, fyEndMonth) {
  const month = monthOf(fiscalDateEnding);
  const year = yearOf(fiscalDateEnding);
  if (!month || !year || !fyEndMonth) return null;
  const fyStart = (fyEndMonth % 12) + 1;
  const qIdx = Math.floor((((month - fyStart) % 12) + 12) % 12 / 3); // 0..3
  const fiscalYear = month > fyEndMonth ? year + 1 : year;
  return `${fiscalYear}Q${qIdx + 1}`;
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
  const quarters = Array.isArray(payload.quarterlyEarnings) ? payload.quarterlyEarnings : [];
  const annual = Array.isArray(payload.annualEarnings) ? payload.annualEarnings : [];
  if (!quarters.length || !annual.length) return null;
  return { quarters, annual };
}

async function fetchTranscript(apiKey, symbol, quarter) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=EARNINGS_CALL_TRANSCRIPT&symbol=${symbol}&quarter=${quarter}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  return Array.isArray(payload.transcript) ? payload.transcript : [];
}

// Management: CEO/CFO/COO/President/Chair(man) of the parent or of any
// named segment ("CEO of Walmart U.S." is still management). Analyst:
// anyone Alpha Vantage tags with an "Analyst" title. Everything else
// (Operator, Investor Relations) is real content but neither side of the
// tone comparison this page is testing, so it's excluded from both
// buckets rather than forced into one.
function classifyTurn(title) {
  const t = (title || "").toLowerCase();
  if (/\b(ceo|cfo|coo|chief|president|chair)\b/.test(t)) return "management";
  if (/analyst/.test(t)) return "analyst";
  return "other";
}

function bucketSentiment(transcript) {
  const mgmt = [];
  const analyst = [];
  const all = [];
  for (const turn of transcript || []) {
    const s = num(turn.sentiment);
    if (s === null) continue;
    all.push(s);
    const role = classifyTurn(turn.title);
    if (role === "management") mgmt.push(s);
    else if (role === "analyst") analyst.push(s);
  }
  return {
    managementSentiment: mean(mgmt),
    analystSentiment: mean(analyst),
    overallSentiment: mean(all),
    managementTurns: mgmt.length,
    analystTurns: analyst.length,
    totalTurns: all.length,
  };
}

// Same beat/miss guardrails as scheduled-surprise-background.js: a sub-
// nickel consensus estimate makes a % surprise divide-by-near-zero noise,
// and a handful of real blowup prints (triple-digit % misses on a company
// that nearly broke even) shouldn't get to dominate a market-wide
// regression.
function surprisePctFor(quarterRow) {
  const est = num(quarterRow.estimatedEPS);
  const surprisePct = num(quarterRow.surprisePercentage);
  if (est === null || surprisePct === null) return null;
  if (Math.abs(est) < MIN_EST_EPS_ABS) return null;
  if (Math.abs(surprisePct) > MAX_ABS_SURPRISE_PCT) return null;
  return surprisePct;
}

function linearRegression(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const syy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const dof = n - 2;
  const sse = ys.reduce((s, y, i) => s + (y - (intercept + slope * xs[i])) ** 2, 0);
  const seSlope = Math.sqrt(sse / dof / sxx);
  const t = slope / seSlope;
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { n, slope: round(slope, 5), intercept: round(intercept, 5), r: round(r, 4), r2: round(r * r, 4), t: round(t, 3), p: round(p, 4) };
}
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
function rankArray(arr) {
  const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && arr[idx[j + 1]] === arr[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}
function spearmanRegression(xs, ys) {
  return linearRegression(rankArray(xs), rankArray(ys));
}

exports.handler = async () => {
  console.log(`scheduled-earnings-call-sentiment-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = [];
    let noTranscriptCount = 0;
    let earningsFailedCount = 0;

    async function processTicker(symbol) {
      let earnings;
      try {
        earnings = await fetchEarnings(apiKey, symbol);
      } catch (err) {
        console.error(`scheduled-earnings-call-sentiment-background: ${symbol} EARNINGS failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
      await sleep(CALL_PACING_MS);
      if (!earnings) {
        earningsFailedCount++;
        return true; // resolved (nothing to retry), just no usable history
      }

      const fyEndMonth = fyEndMonthFromAnnual(earnings.annual);
      const latestQ = earnings.quarters[0];
      const label = quarterLabelFor(latestQ.fiscalDateEnding, fyEndMonth);
      if (!label) {
        earningsFailedCount++;
        return true;
      }

      let transcript;
      try {
        transcript = await fetchTranscript(apiKey, symbol, label);
      } catch (err) {
        console.error(`scheduled-earnings-call-sentiment-background: ${symbol} TRANSCRIPT failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
      await sleep(CALL_PACING_MS);

      if (!transcript.length) {
        noTranscriptCount++;
        return true; // not indexed yet — a real, disclosed gap, not an error to retry
      }

      const bucketed = bucketSentiment(transcript);
      if (bucketed.managementTurns === 0 && bucketed.analystTurns === 0) return true; // nothing usable

      const m = metaTickers[symbol];
      if (!m || !m.sector) return true; // can't place it on a sector chart or leaderboard without this

      results.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        quarterLabel: label,
        fiscalDateEnding: latestQ.fiscalDateEnding,
        reportedDate: latestQ.reportedDate || null,
        managementSentiment: round(bucketed.managementSentiment, 4),
        analystSentiment: round(bucketed.analystSentiment, 4),
        overallSentiment: round(bucketed.overallSentiment, 4),
        sentimentGap:
          bucketed.managementSentiment !== null && bucketed.analystSentiment !== null
            ? round(bucketed.managementSentiment - bucketed.analystSentiment, 4)
            : null,
        managementTurns: bucketed.managementTurns,
        analystTurns: bucketed.analystTurns,
        totalTurns: bucketed.totalTurns,
        surprisePct: round(surprisePctFor(latestQ), 2),
      });
      return true;
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-earnings-call-sentiment-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const ok = await processTicker(symbol);
        if (!ok) missed.push(symbol);
      }
      todo = missed;
    }

    console.log(
      `scheduled-earnings-call-sentiment-background: ${results.length} usable, ${noTranscriptCount} not yet indexed, ${earningsFailedCount} no earnings history, ${todo.length} unresolved after retry`
    );
    if (!results.length) throw new Error("No tickers resolved with both a transcript and sector metadata");

    // Sector aggregates.
    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = results.filter((r) => r.sector === sector);
      if (!inSector.length) return null;
      return {
        sector,
        count: inSector.length,
        medianManagementSentiment: round(median(inSector.map((r) => r.managementSentiment)), 3),
        medianAnalystSentiment: round(median(inSector.map((r) => r.analystSentiment)), 3),
        medianGap: round(median(inSector.map((r) => r.sentimentGap)), 3),
      };
    }).filter(Boolean);

    // Distribution of management-tone sentiment across the universe.
    const distribution = [];
    for (let lo = 0; lo < 1; lo = round(lo + DIST_BIN_WIDTH, 2)) {
      const hi = round(lo + DIST_BIN_WIDTH, 2);
      const count = results.filter((r) => r.managementSentiment !== null && r.managementSentiment >= lo && r.managementSentiment < (hi === 1 ? 1.001 : hi)).length;
      distribution.push({ label: lo.toFixed(1) + "–" + hi.toFixed(1), lo, hi, count });
    }

    // Core stats test #1: does management's own tone track the number they
    // just reported? Core stats test #2: does the management/analyst tone
    // gap move with the size (and direction) of the surprise — e.g. does
    // management sound relatively more upbeat, versus the analysts
    // questioning them, specifically on a quarter that missed?
    const sentimentSurprisePairs = results.filter((r) => r.managementSentiment !== null && r.surprisePct !== null);
    const gapSurprisePairs = results.filter((r) => r.sentimentGap !== null && r.surprisePct !== null);

    const sentimentVsSurprise =
      sentimentSurprisePairs.length >= 10
        ? {
            pearson: linearRegression(sentimentSurprisePairs.map((r) => r.surprisePct), sentimentSurprisePairs.map((r) => r.managementSentiment)),
            spearman: spearmanRegression(sentimentSurprisePairs.map((r) => r.surprisePct), sentimentSurprisePairs.map((r) => r.managementSentiment)),
          }
        : null;

    const gapVsSurprise =
      gapSurprisePairs.length >= 10
        ? {
            pearson: linearRegression(gapSurprisePairs.map((r) => r.surprisePct), gapSurprisePairs.map((r) => r.sentimentGap)),
            spearman: spearmanRegression(gapSurprisePairs.map((r) => r.surprisePct), gapSurprisePairs.map((r) => r.sentimentGap)),
          }
        : null;

    const eligible = results.filter((r) => r.managementTurns >= MIN_TURNS_FOR_LEADERBOARD);
    const gapEligible = results.filter((r) => r.managementTurns >= MIN_TURNS_FOR_LEADERBOARD && r.analystTurns >= MIN_TURNS_FOR_LEADERBOARD);

    const leaderRow = (r) => ({
      symbol: r.symbol,
      name: r.name,
      sector: r.sector,
      managementSentiment: r.managementSentiment,
      analystSentiment: r.analystSentiment,
      sentimentGap: r.sentimentGap,
      surprisePct: r.surprisePct,
      quarterLabel: r.quarterLabel,
    });

    const mostBullish = [...eligible].sort((a, b) => b.managementSentiment - a.managementSentiment).slice(0, LEADERBOARD_COUNT).map(leaderRow);
    const mostGuarded = [...eligible].sort((a, b) => a.managementSentiment - b.managementSentiment).slice(0, LEADERBOARD_COUNT).map(leaderRow);
    const widestGap = [...gapEligible].sort((a, b) => b.sentimentGap - a.sentimentGap).slice(0, LEADERBOARD_COUNT).map(leaderRow);
    const narrowestGap = [...gapEligible].sort((a, b) => Math.abs(a.sentimentGap) - Math.abs(b.sentimentGap)).slice(0, LEADERBOARD_COUNT).map(leaderRow);

    const latest = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.length,
      noTranscriptCount,
      earningsFailedCount,
      sectors,
      distribution,
      sentimentVsSurprise,
      gapVsSurprise,
      mostBullish,
      mostGuarded,
      widestGap,
      narrowestGap,
      companies: results,
    };

    const store = getEarningsCallSentimentStore();
    await store.setJSON(BLOB_KEY, latest);

    console.log(`scheduled-earnings-call-sentiment-background: wrote ${results.length} companies`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: results.length }) };
  } catch (err) {
    console.error(`scheduled-earnings-call-sentiment-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
