// Scheduled Background Function (see [functions."scheduled-smallcap-
// background"] in netlify.toml) that builds the daily small-cap-vs-large-
// cap dataset behind /small-cap-vs-large-cap.html: aligned, indexed daily
// price history for IWM (small-cap proxy, Russell 2000), MDY (mid-cap
// proxy, S&P MidCap 400) and SPY (large-cap proxy, S&P 500), a trailing-
// return ladder for all three, plus the full monthly history of the
// effective Fed funds rate and the 10-year Treasury yield — the two macro
// series the page correlates against the small/large spread. Writes the
// result to Netlify Blobs for smallcap-largecap.js to serve.
//
// Only 5 Alpha Vantage calls (3x TIME_SERIES_DAILY_ADJUSTED full history +
// FEDERAL_FUNDS_RATE + TREASURY_YIELD, both monthly), so unlike the site's
// full-S&P-500-sweep jobs this doesn't need heavy rate-limit pacing — just
// simple spacing between the 5 sequential calls. Runs daily (not weekly)
// since, unlike a sparse-event dataset (insider filings, earnings
// estimates), index levels genuinely move every trading day.

const { getSmallcapStore, BLOB_KEY } = require("./smallcap-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SMALL = "IWM";
const MID = "MDY";
const LARGE = "SPY";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error_message) {
    throw new Error(payload.Note || payload.Information || payload.error_message);
  }
  return payload;
}

// Full daily adjusted-close history -> { dates:[asc], closes:[parallel] }.
// Adjusted close (dividends + splits) so this is a true total-return series
// — same reasoning as scheduled-sectors-background.js and
// scheduled-beeswarm-annual-background.js.
async function fetchDailyAdjusted(apiKey, symbol) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${apiKey}`
  );
  const series = payload["Time Series (Daily)"];
  if (!series) throw new Error(`TIME_SERIES_DAILY_ADJUSTED missing for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  const rows = Object.entries(series)
    .map(([date, r]) => ({ date, close: parseFloat(r["5. adjusted close"]) }))
    .filter((r) => Number.isFinite(r.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { dates: rows.map((r) => r.date), closes: rows.map((r) => r.close) };
}

async function fetchMonthlySeries(apiKey, fn, extraParams) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=${fn}&interval=monthly${extraParams || ""}&apikey=${apiKey}`
  );
  if (!Array.isArray(payload.data)) throw new Error(`${fn} missing data array: ${JSON.stringify(payload).slice(0, 160)}`);
  return payload.data
    .map((r) => ({ date: r.date, value: parseFloat(r.value) }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Latest close on or before targetDate (dates ascending). Binary search —
// same helper as scheduled-beeswarm-annual-background.js.
function closeOnOrBefore(hist, targetDate) {
  const { dates, closes } = hist;
  let lo = 0;
  let hi = dates.length - 1;
  if (!dates.length || dates[0] > targetDate) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (dates[mid] <= targetDate) lo = mid;
    else hi = mid - 1;
  }
  return { date: dates[lo], close: closes[lo] };
}

function addCalendarMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

// Cumulative % return for periods under a year, calendar-day-annualized
// return for periods of a year or more (standard "trailing returns" table
// convention) — using the actual elapsed days between the located trading
// days, not the nominal period, since closeOnOrBefore may land a few days
// short of the exact anniversary (weekends/holidays).
function trailingReturn(hist, latestDate, latestClose, monthsBack) {
  const targetDate = addCalendarMonths(latestDate, monthsBack);
  const found = closeOnOrBefore(hist, targetDate);
  if (!found) return null;
  const elapsedDays = (new Date(latestDate) - new Date(found.date)) / 86400000;
  if (elapsedDays <= 0) return null;
  const cumPct = (latestClose / found.close - 1) * 100;
  if (monthsBack < 12) return { cumPct: Math.round(cumPct * 100) / 100, annualized: false };
  const annPct = (Math.pow(latestClose / found.close, 365.25 / elapsedDays) - 1) * 100;
  return { cumPct: Math.round(annPct * 100) / 100, annualized: true };
}

exports.handler = async () => {
  console.log("scheduled-smallcap-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const histSmall = await fetchDailyAdjusted(apiKey, SMALL);
    await sleep(900);
    const histMid = await fetchDailyAdjusted(apiKey, MID);
    await sleep(900);
    const histLarge = await fetchDailyAdjusted(apiKey, LARGE);
    await sleep(900);
    const fedFundsMonthly = await fetchMonthlySeries(apiKey, "FEDERAL_FUNDS_RATE");
    await sleep(900);
    const treasury10yMonthly = await fetchMonthlySeries(apiKey, "TREASURY_YIELD", "&maturity=10year");

    // Common trading-day calendar: SPY's own dates (longest history),
    // restricted to on/after the later of IWM's and MDY's first date —
    // IWM (inception May 2000) is the binding constraint since MDY started
    // trading in 1995.
    const commonStart = histSmall.dates[0] > histMid.dates[0] ? histSmall.dates[0] : histMid.dates[0];
    const dates = histLarge.dates.filter((d) => d >= commonStart);
    if (!dates.length) throw new Error("no overlapping trading days across IWM/MDY/SPY");

    const smallBase = closeOnOrBefore(histSmall, dates[0]).close;
    const midBase = closeOnOrBefore(histMid, dates[0]).close;
    const largeBase = closeOnOrBefore(histLarge, dates[0]).close;

    const small = [];
    const mid = [];
    const large = [];
    const ratioSmallLarge = [];
    const ratioMidLarge = [];
    for (const d of dates) {
      const s = (closeOnOrBefore(histSmall, d).close / smallBase) * 100;
      const m = (closeOnOrBefore(histMid, d).close / midBase) * 100;
      const l = (closeOnOrBefore(histLarge, d).close / largeBase) * 100;
      small.push(Math.round(s * 100) / 100);
      mid.push(Math.round(m * 100) / 100);
      large.push(Math.round(l * 100) / 100);
      ratioSmallLarge.push(Math.round((s / l) * 100 * 100) / 100);
      ratioMidLarge.push(Math.round((m / l) * 100 * 100) / 100);
    }

    const latestDate = dates[dates.length - 1];
    const periods = [
      { key: "1M", months: 1 },
      { key: "3M", months: 3 },
      { key: "6M", months: 6 },
      { key: "1Y", months: 12 },
      { key: "3Y", months: 36 },
      { key: "5Y", months: 60 },
      { key: "10Y", months: 120 },
    ];
    const ladder = { periods: periods.map((p) => p.key) };
    for (const [label, hist] of [["small", histSmall], ["mid", histMid], ["large", histLarge]]) {
      const latestClose = closeOnOrBefore(hist, latestDate).close;
      ladder[label] = periods.map((p) => trailingReturn(hist, latestDate, latestClose, p.months));
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: latestDate,
      commonStartDate: dates[0],
      symbols: { small: SMALL, mid: MID, large: LARGE },
      dates,
      small,
      mid,
      large,
      ratioSmallLarge,
      ratioMidLarge,
      ladder,
      fedFundsMonthly,
      treasury10yMonthly,
    };

    await getSmallcapStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-smallcap-background: wrote ${dates.length} trading days, as of ${latestDate}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, days: dates.length, asOfDate: latestDate }) };
  } catch (err) {
    console.error(`scheduled-smallcap-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
