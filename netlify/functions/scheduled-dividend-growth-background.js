// Scheduled Background Function (see [functions."scheduled-dividend-growth-background"]
// in netlify.toml) that builds the S&P 500 dividend-growth panel for the
// dividend-growth-screener.html page: which payers have raised their
// dividend, for how long, and how fast, by sector and market-wide over
// time.
//
// For each constituent (reusing breadth-constituents.js), pulls Alpha
// Vantage's DIVIDENDS endpoint — every historical ex-dividend payment, in
// one call, going back as far as the company's listing (decades, for a
// name like Coca-Cola). Payments are summed into calendar-year totals
// (independent of whether a company pays quarterly, semi-annually,
// annually, or has changed frequency over time — a calendar-year sum is
// frequency-agnostic where a per-payment comparison wouldn't be), and from
// that per-company year series comes: the current streak of consecutive
// calendar years with a higher total than the year before (the
// "Dividend Aristocrat" style metric), a 5-year CAGR, and the latest
// year-over-year growth rate.
//
// Sector and company name come from the beeswarm store's meta.json, same
// reuse pattern as the other weekly full-sweep jobs on this site.
//
// Runs weekly (Saturday), in the slot after scheduled-surprise-background
// (11:10 UTC) finishes — see netlify.toml. A company's dividend history
// only gains a new data point a few times a year at most, so weekly
// recomputation is about capturing newly-announced increases promptly,
// not because anything here goes stale faster than that.
//
// Pacing mirrors the other full-sweep jobs on this site: ~1.05s between
// calls, two passes with a 65s cooling-off between them.

const { getDividendStore, LATEST_KEY } = require("./dividend-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MIN_FULL_YEARS = 3; // fewer than this and a CAGR/streak isn't meaningful
const CAGR_WINDOW_YEARS = 5; // use up to this many years back for the CAGR, fewer if that's all there is
const MIN_STREAK_FOR_LEADERBOARD = 3;
const TREND_YEARS = 10;
const DIST_BINS = [-Infinity, -100, -10, 0, 5, 10, 20, Infinity];

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

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

async function fetchDividends(apiKey, symbol, currentYear) {
  await recordAvCall();
  const res = await fetch(`${ALPHA_VANTAGE_URL}?function=DIVIDENDS&symbol=${symbol}&apikey=${apiKey}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.data;
  if (!Array.isArray(rows) || !rows.length) return null;

  const byYear = new Map();
  for (const r of rows) {
    const amt = num(r.amount);
    const exDate = r.ex_dividend_date;
    if (amt === null || amt <= 0 || !exDate) continue;
    const y = parseInt(exDate.slice(0, 4), 10);
    if (!Number.isFinite(y) || y >= currentYear) continue; // exclude the in-progress year
    byYear.set(y, (byYear.get(y) || 0) + amt);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b).map((y) => ({ year: y, total: round(byYear.get(y), 4) }));
  return years.length >= MIN_FULL_YEARS ? years : null;
}

// Consecutive calendar years, walking backward from the most recent, where
// each year's total exceeds the one before it. Breaks on the first
// non-increase or on any gap year (a company that skipped a year entirely
// isn't mid-streak).
function computeStreak(years) {
  let streak = 0;
  for (let i = years.length - 1; i > 0; i--) {
    const curr = years[i];
    const prev = years[i - 1];
    if (curr.year - prev.year !== 1) break;
    if (curr.total > prev.total) streak++;
    else break;
  }
  return streak;
}

function computeCagr(years, maxYears) {
  const n = Math.min(maxYears, years.length - 1);
  if (n < 2) return null;
  const start = years[years.length - 1 - n];
  const end = years[years.length - 1];
  if (!start || start.total <= 0) return null;
  return round((Math.pow(end.total / start.total, 1 / n) - 1) * 100, 2);
}

function latestYoyGrowth(years) {
  if (years.length < 2) return null;
  const curr = years[years.length - 1];
  const prev = years[years.length - 2];
  if (curr.year - prev.year !== 1 || prev.total <= 0) return null;
  return round(((curr.total - prev.total) / prev.total) * 100, 2);
}

exports.handler = async () => {
  console.log(`scheduled-dividend-growth-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const currentYear = new Date().getUTCFullYear();

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const years = await fetchDividends(apiKey, symbol, currentYear);
        if (years) results.set(symbol, years);
        return true;
      } catch (err) {
        console.error(`scheduled-dividend-growth-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-dividend-growth-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-dividend-growth-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers with usable dividend history`);

    const companies = [];
    for (const [symbol, years] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const streak = computeStreak(years);
      const cagr5y = computeCagr(years, CAGR_WINDOW_YEARS);
      const yoyGrowth = latestYoyGrowth(years);
      companies.push({
        ticker: symbol,
        name: m.name || symbol,
        sector: m.sector,
        years,
        latestYear: years[years.length - 1].year,
        latestAnnualTotal: years[years.length - 1].total,
        streak,
        cagr5y,
        yoyGrowth,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with both dividend history and sector metadata");

    // Sector aggregation: among payers with a usable 5yr CAGR / streak.
    const sectorAgg = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      const withCagr = inSector.filter((c) => c.cagr5y !== null);
      return {
        sector,
        count: inSector.length,
        avgCagr5y: round(mean(withCagr.map((c) => c.cagr5y)), 2),
        avgStreak: round(mean(inSector.map((c) => c.streak)), 1),
        longGrowers: inSector.filter((c) => c.streak >= 5).length,
      };
    }).filter(Boolean);

    const withCagr = companies.filter((c) => c.cagr5y !== null);
    const marketMedianCagr = round(median(withCagr.map((c) => c.cagr5y)), 2);
    const longGrowerCount = companies.filter((c) => c.streak >= 5).length;
    const longestStreakCompany = [...companies].sort((a, b) => b.streak - a.streak)[0];

    // Distribution of latest YoY growth, all payers with a usable figure.
    const withYoy = companies.filter((c) => c.yoyGrowth !== null);
    const distribution = [];
    for (let i = 0; i < DIST_BINS.length - 1; i++) {
      const lo = DIST_BINS[i];
      const hi = DIST_BINS[i + 1];
      const count = withYoy.filter((c) => c.yoyGrowth >= lo && c.yoyGrowth < hi).length;
      const label = lo === -Infinity ? `< ${hi}%` : hi === Infinity ? `≥ ${lo}%` : `${lo}% to ${hi}%`;
      distribution.push({ label, lo, hi, count });
    }

    // Market-wide trend: median YoY dividend growth among payers with data
    // in both a given year and the year before, for each of the last
    // TREND_YEARS calendar years.
    const trend = [];
    for (let y = currentYear - TREND_YEARS; y < currentYear; y++) {
      const growthRates = [];
      for (const c of companies) {
        const curr = c.years.find((yr) => yr.year === y);
        const prev = c.years.find((yr) => yr.year === y - 1);
        if (curr && prev && prev.total > 0) growthRates.push(((curr.total - prev.total) / prev.total) * 100);
      }
      if (growthRates.length >= 30) {
        trend.push({ year: y, medianGrowth: round(median(growthRates), 2), count: growthRates.length });
      }
    }

    const leaderboardRow = (c) => ({
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      streak: c.streak,
      cagr5y: c.cagr5y,
      yoyGrowth: c.yoyGrowth,
      latestYear: c.latestYear,
    });

    const topGrowers = [...withCagr].sort((a, b) => b.cagr5y - a.cagr5y).slice(0, 10).map(leaderboardRow);
    const longestStreaks = companies
      .filter((c) => c.streak >= MIN_STREAK_FOR_LEADERBOARD)
      .sort((a, b) => b.streak - a.streak || (b.cagr5y ?? -Infinity) - (a.cagr5y ?? -Infinity))
      .slice(0, 10)
      .map(leaderboardRow);
    const biggestCutters = [...withYoy]
      .filter((c) => c.yoyGrowth < 0)
      .sort((a, b) => a.yoyGrowth - b.yoyGrowth)
      .slice(0, 10)
      .map(leaderboardRow);

    const latest = {
      generated_at_utc: new Date().toISOString(),
      universe_size: companies.length,
      universe_total: BREADTH_CONSTITUENTS.length,
      market: {
        medianCagr5y: marketMedianCagr,
        longGrowerCount,
        longestStreak: longestStreakCompany
          ? { ticker: longestStreakCompany.ticker, name: longestStreakCompany.name, streak: longestStreakCompany.streak }
          : null,
      },
      sectors: sectorAgg,
      distribution,
      trend,
      topGrowers,
      longestStreaks,
      biggestCutters,
    };

    const store = getDividendStore();
    await store.setJSON(LATEST_KEY, latest);

    console.log(
      `scheduled-dividend-growth-background: wrote ${companies.length} payers, ${longGrowerCount} with a 5yr+ streak, longest streak ${longestStreakCompany ? longestStreakCompany.streak : 0}`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length }) };
  } catch (err) {
    console.error(`scheduled-dividend-growth-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
