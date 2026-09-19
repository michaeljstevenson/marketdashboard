// Scheduled Background Function (see [functions."scheduled-earnings-
// sentiment-background"] in netlify.toml — one-time snapshot, no recurring
// cron, per this site's current policy for newly-added Equities pages, see
// that function's own comment) that builds the Earnings Call Sentiment
// page's data.
//
// For each S&P 500 constituent, pulls two Alpha Vantage endpoints:
//   1. EARNINGS — same endpoint scheduled-surprise-background.js uses, to
//      get the latest reported quarter's fiscalDateEnding/reportedDate and
//      EPS surprise %. Re-swept here rather than reusing that page's own
//      blob (which only stores aggregates, not a per-company quarter
//      record) — same standalone-sweep tradeoff scheduled-pe-divergence-
//      background.js documents for the same reason.
//   2. EARNINGS_CALL_TRANSCRIPT — the actual call transcript, with a
//      per-statement sentiment score (-1..+1) Alpha Vantage computes itself
//      via an LLM. No other page on this site uses this endpoint.
//
// The tricky part: EARNINGS_CALL_TRANSCRIPT's "quarter" parameter
// (e.g. "2024Q1") is labeled by each COMPANY'S OWN fiscal quarter, not the
// calendar quarter — confirmed by direct testing: Apple's fiscal year
// starts in October, so its "2024Q1" transcript covers Oct-Dec 2023, while
// JPMorgan (a normal calendar-year reporter) has "2024Q1" cover Jan-Mar
// 2024. There is no field in either endpoint that states a company's
// fiscal-year-start month, so there is no way to compute the right label
// for every company without per-company calibration.
//
// This job does NOT attempt that calibration — it makes one guess per
// company (the calendar-quarter mapping of fiscalDateEnding, e.g.
// fiscalDateEnding in Jan-Mar -> "yearQ1") and accepts the miss for
// companies whose fiscal year doesn't start in January (Apple, Microsoft,
// and roughly a fifth of the index — see the page's own methodology
// section). A wrong guess just returns an empty/error transcript, which is
// handled as "no sentiment data this company" rather than retried — a
// bounded retry search exists in principle (there are only 4 possible
// quarter-label offsets, since Alpha Vantage normalizes fiscalDateEnding to
// calendar quarter-end dates regardless of a company's real fiscal
// calendar) but was deliberately left out to keep this single run's total
// call count near ~1,000 (503 EARNINGS + up to 503 transcript calls), the
// same volume class as scheduled-margin-leverage-background.js's two-
// statement sweep, comfortably inside a Background Function's ~15-minute
// ceiling at 800ms pacing with no retry pass. A future manual re-run could
// add per-company calibration (caching the working offset once found)
// without a schema change here — this file's per-company record already
// carries its own quarterLabel.
//
// Sector and company name come from the beeswarm store's meta.json, same
// reuse pattern as scheduled-surprise-background.js.

const { getEarningsSentimentStore, BLOB_KEY } = require("./earnings-sentiment-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CALL_PACING_MS = 800;
const MIN_EST_EPS_ABS = 0.05; // same divide-by-near-zero guard as scheduled-surprise-background.js
const MAX_ABS_SURPRISE_PCT = 200;
const MIN_STATEMENTS = 8; // a transcript this short (investor-day recap, aborted call) isn't a real Q&A session
const DIST_BINS = [-Infinity, -0.3, -0.15, -0.05, 0.05, 0.15, 0.3, Infinity];
const MIN_SECTOR_COVERAGE = 3; // floor for a sector to appear on the sector chart at all

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

// Calendar-quarter guess for the transcript "quarter" param — see file
// header for why this is a guess, not a guarantee, for every company.
function calendarQuarterLabel(fiscalDateEnding) {
  const d = new Date(fiscalDateEnding + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const qIdx = Math.floor(d.getUTCMonth() / 3); // 0..3
  return `${year}Q${qIdx + 1}`;
}

async function fetchAv(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  return payload;
}

async function fetchLatestEarnings(apiKey, symbol) {
  const payload = await fetchAv(`${ALPHA_VANTAGE_URL}?function=EARNINGS&symbol=${symbol}&apikey=${apiKey}`);
  const qs = payload.quarterlyEarnings;
  if (!Array.isArray(qs) || !qs.length) return null;
  const q = qs[0]; // newest-first
  const est = num(q.estimatedEPS);
  const surprisePct = num(q.surprisePercentage);
  if (est === null || surprisePct === null) return null;
  if (Math.abs(est) < MIN_EST_EPS_ABS) return null;
  if (Math.abs(surprisePct) > MAX_ABS_SURPRISE_PCT) return null;
  if (!q.fiscalDateEnding) return null;
  return {
    fiscalDateEnding: q.fiscalDateEnding,
    reportedDate: q.reportedDate || null,
    reportedEPS: num(q.reportedEPS),
    estimatedEPS: est,
    surprisePct,
  };
}

// role: "management" | "analyst" | "operator" — a deliberately simple
// heuristic (title contains "Analyst" -> analyst; speaker/title reads
// Operator/Moderator -> operator; everything else -> management), same
// "not exhaustive, documented in the methodology blurb" spirit as this
// site's other name/title-pattern heuristics (e.g. stock-split-tracker's
// SPAC filter, ipo-pipeline's fund/trust classifier).
function classifyRole(speaker, title) {
  const t = String(title || "").toLowerCase();
  const s = String(speaker || "").toLowerCase();
  if (t.includes("analyst")) return "analyst";
  if (s === "operator" || t.includes("operator") || t.includes("moderator")) return "operator";
  return "management";
}

// Q&A is taken to start at the first analyst statement — everything before
// that is "prepared remarks" (necessarily all management, since analysts by
// construction don't speak before the operator hands off to Q&A).
function processTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length < MIN_STATEMENTS) return null;

  let qaStart = transcript.findIndex((t) => classifyRole(t.speaker, t.title) === "analyst");
  if (qaStart === -1) qaStart = transcript.length; // no analyst found — treat whole call as "prepared"

  const rows = transcript
    .map((t, i) => ({
      role: classifyRole(t.speaker, t.title),
      sentiment: num(t.sentiment),
      section: i < qaStart ? "prepared" : "qa",
    }))
    .filter((r) => r.sentiment !== null && r.role !== "operator");

  if (!rows.length) return null;

  const preparedMgmt = rows.filter((r) => r.section === "prepared" && r.role === "management").map((r) => r.sentiment);
  const qaMgmt = rows.filter((r) => r.section === "qa" && r.role === "management").map((r) => r.sentiment);
  const analystQ = rows.filter((r) => r.role === "analyst").map((r) => r.sentiment);
  const overall = rows.map((r) => r.sentiment);

  const preparedSentiment = mean(preparedMgmt);
  const qaSentiment = mean(qaMgmt);

  return {
    statementCount: transcript.length,
    overallSentiment: round(mean(overall)),
    preparedSentiment: round(preparedSentiment),
    qaSentiment: round(qaSentiment),
    analystSentiment: round(mean(analystQ)),
    toneGap: preparedSentiment !== null && qaSentiment !== null ? round(qaSentiment - preparedSentiment) : null,
  };
}

exports.handler = async () => {
  console.log(`scheduled-earnings-sentiment-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const companies = [];
    let earningsMisses = 0;
    let transcriptMisses = 0;

    for (const symbol of BREADTH_CONSTITUENTS) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue; // can't place it on any sector view — same drop-unmapped convention as scheduled-surprise-background.js

      let earnings = null;
      try {
        earnings = await fetchLatestEarnings(apiKey, symbol);
      } catch (err) {
        console.error(`scheduled-earnings-sentiment-background: ${symbol} EARNINGS failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
      }
      await sleep(CALL_PACING_MS);

      if (!earnings) {
        earningsMisses++;
        continue;
      }

      const quarterLabel = calendarQuarterLabel(earnings.fiscalDateEnding);
      let sentiment = null;
      if (quarterLabel) {
        try {
          const payload = await fetchAv(
            `${ALPHA_VANTAGE_URL}?function=EARNINGS_CALL_TRANSCRIPT&symbol=${symbol}&quarter=${quarterLabel}&apikey=${apiKey}`
          );
          sentiment = processTranscript(payload.transcript);
        } catch (err) {
          console.error(`scheduled-earnings-sentiment-background: ${symbol} ${quarterLabel} transcript failed: ${err.message}`);
          if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        }
        await sleep(CALL_PACING_MS);
      }
      if (!sentiment) transcriptMisses++;

      companies.push({
        ticker: symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalDateEnding: earnings.fiscalDateEnding,
        reportedDate: earnings.reportedDate,
        quarterLabel,
        reportedEPS: round(earnings.reportedEPS, 2),
        estimatedEPS: round(earnings.estimatedEPS, 2),
        surprisePct: round(earnings.surprisePct, 2),
        sentiment, // null if this company's fiscal-quarter guess missed, or transcript too short/unavailable
      });
    }

    console.log(
      `scheduled-earnings-sentiment-background: ${companies.length} companies with earnings data (${earningsMisses} EARNINGS misses), ${companies.filter((c) => c.sentiment).length} with usable sentiment (${transcriptMisses} transcript misses)`
    );
    if (!companies.length) throw new Error("No tickers resolved with earnings data");

    const withSentiment = companies.filter((c) => c.sentiment);
    if (!withSentiment.length) throw new Error("No tickers resolved with usable call-sentiment data");

    const reportDates = companies.map((c) => c.reportedDate).filter(Boolean).sort();

    // Sector aggregates.
    const sectorAgg = SECTOR_ORDER.map((sector) => {
      const inSector = withSentiment.filter((c) => c.sector === sector);
      if (inSector.length < MIN_SECTOR_COVERAGE) return null;
      const gapRows = inSector.filter((c) => c.sentiment.toneGap !== null);
      return {
        sector,
        count: inSector.length,
        avgOverall: round(mean(inSector.map((c) => c.sentiment.overallSentiment)), 3),
        avgPrepared: round(mean(inSector.map((c) => c.sentiment.preparedSentiment)), 3),
        avgQa: round(mean(inSector.map((c) => c.sentiment.qaSentiment)), 3),
        avgToneGap: gapRows.length ? round(mean(gapRows.map((c) => c.sentiment.toneGap)), 3) : null,
      };
    }).filter(Boolean);

    // Distribution of overall call sentiment.
    const distribution = [];
    for (let i = 0; i < DIST_BINS.length - 1; i++) {
      const lo = DIST_BINS[i];
      const hi = DIST_BINS[i + 1];
      const count = withSentiment.filter((c) => c.sentiment.overallSentiment >= lo && c.sentiment.overallSentiment < hi).length;
      const label = lo === -Infinity ? `< ${hi}` : hi === Infinity ? `≥ ${lo}` : `${lo} to ${hi}`;
      distribution.push({ label, lo, hi, count });
    }

    // Cross-sectional test #1: does call sentiment track the magnitude of
    // the actual EPS surprise, or is management's tone decoupled from the
    // numbers? Test #2: does the prepared-vs-Q&A tone gap (how much rosier
    // the script sounds than the unscripted answers) also track it — i.e.
    // does the gap leak information the prepared remarks don't show?
    const scatterSentimentSurprise = withSentiment
      .filter((c) => c.surprisePct !== null)
      .map((c) => ({ x: c.sentiment.overallSentiment, y: c.surprisePct, ticker: c.ticker, name: c.name }));

    const scatterToneGapSurprise = withSentiment
      .filter((c) => c.surprisePct !== null && c.sentiment.toneGap !== null)
      .map((c) => ({ x: c.sentiment.toneGap, y: c.surprisePct, ticker: c.ticker, name: c.name }));

    const toneGapRows = withSentiment.filter((c) => c.sentiment.toneGap !== null);

    const leaderboardRow = (c) => ({
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      quarterLabel: c.quarterLabel,
      overallSentiment: c.sentiment.overallSentiment,
      preparedSentiment: c.sentiment.preparedSentiment,
      qaSentiment: c.sentiment.qaSentiment,
      toneGap: c.sentiment.toneGap,
      surprisePct: c.surprisePct,
    });

    const mostPositive = [...withSentiment].sort((a, b) => b.sentiment.overallSentiment - a.sentiment.overallSentiment).slice(0, 10).map(leaderboardRow);
    const mostNegative = [...withSentiment].sort((a, b) => a.sentiment.overallSentiment - b.sentiment.overallSentiment).slice(0, 10).map(leaderboardRow);
    const toneGapDown = [...toneGapRows].sort((a, b) => a.sentiment.toneGap - b.sentiment.toneGap).slice(0, 10).map(leaderboardRow);
    const toneGapUp = [...toneGapRows].sort((a, b) => b.sentiment.toneGap - a.sentiment.toneGap).slice(0, 10).map(leaderboardRow);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeTotal: BREADTH_CONSTITUENTS.length,
      universeWithEarnings: companies.length,
      universeWithSentiment: withSentiment.length,
      reportDateRange: reportDates.length ? { earliest: reportDates[0], latest: reportDates[reportDates.length - 1] } : null,
      market: {
        avgOverall: round(mean(withSentiment.map((c) => c.sentiment.overallSentiment)), 3),
        avgPrepared: round(mean(withSentiment.map((c) => c.sentiment.preparedSentiment)), 3),
        avgQa: round(mean(withSentiment.map((c) => c.sentiment.qaSentiment)), 3),
        avgToneGap: toneGapRows.length ? round(mean(toneGapRows.map((c) => c.sentiment.toneGap)), 3) : null,
      },
      sectors: sectorAgg,
      distribution,
      scatterSentimentSurprise,
      scatterToneGapSurprise,
      leaderboards: { mostPositive, mostNegative, toneGapDown, toneGapUp },
      companies: withSentiment.map((c) => ({
        ticker: c.ticker,
        name: c.name,
        sector: c.sector,
        quarterLabel: c.quarterLabel,
        reportedDate: c.reportedDate,
        statementCount: c.sentiment.statementCount,
        overallSentiment: c.sentiment.overallSentiment,
        preparedSentiment: c.sentiment.preparedSentiment,
        qaSentiment: c.sentiment.qaSentiment,
        analystSentiment: c.sentiment.analystSentiment,
        toneGap: c.sentiment.toneGap,
        surprisePct: c.surprisePct,
      })),
    };

    const store = getEarningsSentimentStore();
    await store.setJSON(BLOB_KEY, payload);

    console.log(
      `scheduled-earnings-sentiment-background: wrote ${withSentiment.length} companies with sentiment (of ${companies.length} with earnings data, of ${BREADTH_CONSTITUENTS.length} total)`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, withSentiment: withSentiment.length }) };
  } catch (err) {
    console.error(`scheduled-earnings-sentiment-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
