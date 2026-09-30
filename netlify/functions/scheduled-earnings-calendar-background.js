// Scheduled Background Function (see [functions."scheduled-earnings-calendar-
// background"] in netlify.toml) that builds the Earnings Calendar & Bar-Setting
// page's data.
//
//   1. Pull Alpha Vantage's EARNINGS_CALENDAR (CSV, next 3 months, every
//      listed company) and keep only S&P 500 constituents reporting inside
//      the look-ahead window.
//   2. For each of those reporters, pull EARNINGS (full quarterly history).
//      From it: the year-ago same-quarter reported EPS (so the calendar's
//      consensus estimate can be turned into an implied year-over-year growth
//      rate), and the company's trailing beat rate / average surprise.
//   3. Pool every historical (company, quarter) pair from those same
//      payloads — consensus estimate vs. the reported EPS four quarters
//      earlier gives that quarter's implied growth, and the actual surprise
//      is already in the payload — and test whether a high implied-growth
//      "bar" is followed by smaller surprises (Pearson + Spearman, plus a
//      quintile view).
//
// Sector/name/market cap come from the beeswarm store's meta.json, same
// reuse pattern as the site's other full-universe jobs. The earnings-surprise
// blob is read (optionally) only to say how much of the S&P 500 has already
// reported this season.
//
// Weekly, Sunday 07:00 UTC — the only day of the week with no other
// scheduled job. ~250-350 sequential EARNINGS calls at 1050ms spacing plus a
// retry pass.

const { getEarningsCalendarStore, LATEST_KEY } = require("./earnings-calendar-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getSurpriseStore, LATEST_KEY: SURPRISE_KEY } = require("./surprise-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const LOOKAHEAD_DAYS = 45;
const HISTORY_QUARTERS = 8; // beat-rate / average-surprise window
const MIN_ABS_EPS = 0.05; // estimate or year-ago EPS smaller than a nickel makes growth % divide-by-near-zero noise
const MAX_ABS_GROWTH_PCT = 200;
const MAX_ABS_SURPRISE_PCT = 200;
const YEAR_AGO_TOLERANCE_DAYS = 25;
const MIN_TEST_OBS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  if (v === null || v === undefined || v === "" || v === "None") return null;
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
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || "").split(/\r\n|\n/).filter((l) => l.length > 0);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i] !== undefined ? cols[i].trim() : ""));
    return row;
  });
}

function dayDiff(a, b) {
  return Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

// Large-sample normal approximation to the t-test on a correlation
// coefficient — n is in the hundreds here, where it matches the exact t
// distribution to well within what a descriptive p-value needs.
function corrP(r, n) {
  if (r === null || n < 4 || Math.abs(r) >= 1) return null;
  const t = (r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r);
  return round(2 * (1 - normalCdf(Math.abs(t))), 4);
}

async function fetchAv(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function fetchCalendar(apiKey) {
  const res = await fetchAv(`${ALPHA_VANTAGE_URL}?function=EARNINGS_CALENDAR&horizon=3month&apikey=${apiKey}`);
  const text = await res.text();
  if (text.trim().startsWith("{")) throw new Error(`EARNINGS_CALENDAR returned JSON, not CSV: ${text.slice(0, 200)}`);
  return parseCsv(text);
}

async function fetchEarnings(apiKey, symbol) {
  const res = await fetchAv(`${ALPHA_VANTAGE_URL}?function=EARNINGS&symbol=${symbol}&apikey=${apiKey}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const qs = payload.quarterlyEarnings;
  if (!Array.isArray(qs) || !qs.length) return null;
  return qs.map((q) => ({
    fiscalDateEnding: q.fiscalDateEnding,
    reportedEPS: num(q.reportedEPS),
    estimatedEPS: num(q.estimatedEPS),
    surprisePct: num(q.surprisePercentage),
  })); // newest first
}

function yearAgoEps(quarters, fiscalDateEnding) {
  let best = null;
  let bestGap = Infinity;
  for (const q of quarters) {
    if (q.reportedEPS === null) continue;
    const gap = Math.abs(dayDiff(fiscalDateEnding, q.fiscalDateEnding) - 365);
    if (gap <= YEAR_AGO_TOLERANCE_DAYS && gap < bestGap) {
      best = q.reportedEPS;
      bestGap = gap;
    }
  }
  return best;
}

function impliedGrowthPct(estimate, yearAgo) {
  if (estimate === null || yearAgo === null) return null;
  if (Math.abs(estimate) < MIN_ABS_EPS || Math.abs(yearAgo) < MIN_ABS_EPS) return null;
  const g = ((estimate - yearAgo) / Math.abs(yearAgo)) * 100;
  return Math.abs(g) <= MAX_ABS_GROWTH_PCT ? g : null;
}

exports.handler = async () => {
  console.log("scheduled-earnings-calendar-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const meta = (await getBeeswarmStore().get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};
    const sp500 = new Set(BREADTH_CONSTITUENTS);

    const today = new Date().toISOString().slice(0, 10);
    const calendarRows = await fetchCalendar(apiKey);

    const upcoming = new Map();
    for (const r of calendarRows) {
      const symbol = String(r.symbol || "").replace(/\./g, "-");
      if (!sp500.has(symbol) || !r.reportDate) continue;
      const d = dayDiff(r.reportDate, today);
      if (d < 0 || d > LOOKAHEAD_DAYS) continue;
      const prev = upcoming.get(symbol);
      if (prev && prev.reportDate <= r.reportDate) continue; // keep the earliest upcoming date
      upcoming.set(symbol, {
        ticker: symbol,
        reportDate: r.reportDate,
        fiscalDateEnding: r.fiscalDateEnding,
        estimate: num(r.estimate),
        timeOfTheDay: r.timeOfTheDay || null,
      });
    }
    if (!upcoming.size) throw new Error("No S&P 500 reporters found in the EARNINGS_CALENDAR look-ahead window");
    console.log(`scheduled-earnings-calendar-background: ${upcoming.size} S&P 500 reporters in the next ${LOOKAHEAD_DAYS} days`);

    const histories = new Map();
    let todo = [...upcoming.keys()];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-earnings-calendar-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        try {
          const q = await fetchEarnings(apiKey, symbol);
          if (q) histories.set(symbol, q);
        } catch (err) {
          console.error(`scheduled-earnings-calendar-background: ${symbol} failed: ${err.message}`);
          if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
          missed.push(symbol);
        }
        await sleep(1050);
      }
      todo = missed;
    }

    const rows = [];
    const testX = [];
    const testY = [];
    for (const u of upcoming.values()) {
      const m = metaTickers[u.ticker];
      const hist = histories.get(u.ticker);
      if (!m || !m.sector) continue;

      let yearAgo = null;
      let beatRate = null;
      let avgSurprise = null;
      let nHist = 0;
      if (hist) {
        yearAgo = u.fiscalDateEnding ? yearAgoEps(hist, u.fiscalDateEnding) : null;
        const usable = hist
          .filter((q) => q.surprisePct !== null && Math.abs(q.surprisePct) <= MAX_ABS_SURPRISE_PCT && q.estimatedEPS !== null && Math.abs(q.estimatedEPS) >= MIN_ABS_EPS)
          .slice(0, HISTORY_QUARTERS);
        nHist = usable.length;
        if (nHist >= 4) {
          beatRate = (usable.filter((q) => q.surprisePct > 0).length / nHist) * 100;
          avgSurprise = mean(usable.map((q) => q.surprisePct));
        }
        for (const q of hist) {
          if (q.surprisePct === null || Math.abs(q.surprisePct) > MAX_ABS_SURPRISE_PCT) continue;
          const g = impliedGrowthPct(q.estimatedEPS, yearAgoEps(hist, q.fiscalDateEnding));
          if (g === null) continue;
          testX.push(g);
          testY.push(q.surprisePct);
        }
      }
      rows.push({
        ticker: u.ticker,
        name: m.name || u.ticker,
        sector: m.sector,
        marketCap: Number.isFinite(m.marketCap) ? m.marketCap : null,
        reportDate: u.reportDate,
        timeOfTheDay: u.timeOfTheDay,
        estimate: u.estimate,
        yearAgoEps: round(yearAgo, 2),
        impliedGrowthPct: round(impliedGrowthPct(u.estimate, yearAgo), 1),
        beatRate: round(beatRate, 0),
        avgSurprisePct: round(avgSurprise, 2),
        historyQuarters: nHist,
      });
    }
    if (!rows.length) throw new Error("No upcoming reporters resolved with both metadata and earnings data");

    // Weekly load, Monday-anchored.
    const weekMap = new Map();
    for (const r of rows) {
      const wk = mondayOf(r.reportDate);
      if (!weekMap.has(wk)) weekMap.set(wk, { weekStart: wk, count: 0, pre: 0, post: 0, unspecified: 0, marketCap: 0 });
      const w = weekMap.get(wk);
      w.count++;
      if (r.timeOfTheDay === "pre-market") w.pre++;
      else if (r.timeOfTheDay === "post-market") w.post++;
      else w.unspecified++;
      w.marketCap += r.marketCap || 0;
    }
    const weeks = [...weekMap.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));

    // Per-sector aggregates.
    const sectorMap = new Map();
    for (const r of rows) {
      if (!sectorMap.has(r.sector)) sectorMap.set(r.sector, []);
      sectorMap.get(r.sector).push(r);
    }
    const sectors = [...sectorMap.entries()].map(([sector, rs]) => ({
      sector,
      count: rs.length,
      medianImpliedGrowthPct: round(median(rs.map((r) => r.impliedGrowthPct)), 1),
      growthCount: rs.filter((r) => r.impliedGrowthPct !== null).length,
      avgBeatRate: round(mean(rs.map((r) => r.beatRate)), 0),
    }));

    // Expectations-vs-surprise test on the pooled history.
    let test = null;
    if (testX.length >= MIN_TEST_OBS) {
      const rP = pearson(testX, testY);
      const rS = pearson(ranks(testX), ranks(testY));
      const order = testX.map((_, i) => i).sort((a, b) => testX[a] - testX[b]);
      const buckets = [];
      const size = Math.floor(order.length / 5);
      for (let b = 0; b < 5; b++) {
        const idxs = order.slice(b * size, b === 4 ? order.length : (b + 1) * size);
        const gs = idxs.map((i) => testX[i]);
        const ss = idxs.map((i) => testY[i]);
        buckets.push({
          quintile: b + 1,
          n: idxs.length,
          growthMin: round(Math.min(...gs), 1),
          growthMax: round(Math.max(...gs), 1),
          beatRate: round((ss.filter((s) => s > 0).length / ss.length) * 100, 1),
          avgSurprisePct: round(mean(ss), 2),
        });
      }
      test = {
        n: testX.length,
        pearson: { r: round(rP, 3), p: corrP(rP, testX.length) },
        spearman: { r: round(rS, 3), p: corrP(rS, testX.length) },
        buckets,
        scatter: testX.map((x, i) => [round(x, 1), round(testY[i], 1)]),
      };
    }

    // Season progress, if the surprise blob happens to be populated.
    let season = null;
    try {
      const sb = await getSurpriseStore().get(SURPRISE_KEY, { type: "json" });
      if (sb && Array.isArray(sb.companiesLatest)) {
        const reportedRecently = sb.companiesLatest.filter((c) => c.reportedDate && dayDiff(today, c.reportedDate) >= 0 && dayDiff(today, c.reportedDate) <= 45).length;
        season = { reportedLast45d: reportedRecently, trackedUniverse: sb.companiesLatest.length, surpriseSnapshotAt: sb.generated_at_utc || null };
      }
    } catch (err) {
      console.error(`scheduled-earnings-calendar-background: surprise blob read failed: ${err.message}`);
    }

    rows.sort((a, b) => a.reportDate.localeCompare(b.reportDate) || (b.marketCap || 0) - (a.marketCap || 0));

    const latest = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: today,
      lookaheadDays: LOOKAHEAD_DAYS,
      universeTotal: BREADTH_CONSTITUENTS.length,
      upcomingCount: rows.length,
      withHistory: rows.filter((r) => r.historyQuarters >= 4).length,
      medianImpliedGrowthPct: round(median(rows.map((r) => r.impliedGrowthPct)), 1),
      weeks,
      sectors,
      test,
      season,
      companies: rows,
    };

    await getEarningsCalendarStore().setJSON(LATEST_KEY, latest);
    console.log(`scheduled-earnings-calendar-background: wrote ${rows.length} upcoming reporters, test n=${test ? test.n : 0}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, upcoming: rows.length }) };
  } catch (err) {
    console.error(`scheduled-earnings-calendar-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
