// Scheduled Background Function (see [functions."scheduled-international-
// background"] in netlify.toml) that builds the daily international-vs-US
// dataset behind /international-vs-us.html: aligned, indexed daily price
// history for EFA (developed-markets-ex-US proxy), EEM (emerging-markets
// proxy) and SPY (US large-cap proxy), a trailing-return ladder for all
// three, plus the full monthly EUR/USD history used as the page's dollar-
// direction proxy. Writes the result to Netlify Blobs for
// international-us.js to serve.
//
// Only 4 Alpha Vantage calls (3x TIME_SERIES_DAILY_ADJUSTED full history +
// 1x FX_MONTHLY), so like scheduled-smallcap-background.js this doesn't
// need heavy rate-limit pacing — just simple spacing between the 4
// sequential calls. Runs daily since index levels move every trading day.

const { getInternationalStore, BLOB_KEY } = require("./international-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DEVELOPED = "EFA"; // iShares MSCI EAFE ETF — developed markets ex-US, inception Aug 2001
const EMERGING = "EEM"; // iShares MSCI Emerging Markets ETF, inception Apr 2003
const US = "SPY";

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
// — same reasoning as scheduled-smallcap-background.js.
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

// EUR/USD monthly close history — a single, simple dollar-direction proxy
// (rising EUR/USD = dollar weakening) in the same spirit as the small-cap
// page's single-variable Fed-funds/Treasury-yield check: one macro variable
// rarely explains much on its own, and the point of showing it is honesty
// about that, not oversell.
async function fetchEurUsdMonthly(apiKey) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=FX_MONTHLY&from_symbol=EUR&to_symbol=USD&apikey=${apiKey}`
  );
  const series = payload["Time Series FX (Monthly)"];
  if (!series) throw new Error(`FX_MONTHLY missing: ${JSON.stringify(payload).slice(0, 160)}`);
  return Object.entries(series)
    .map(([date, r]) => ({ date, value: parseFloat(r["4. close"]) }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Latest close on or before targetDate (dates ascending). Binary search —
// same helper as scheduled-smallcap-background.js.
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
// return for periods of a year or more — same convention as
// scheduled-smallcap-background.js.
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
  console.log("scheduled-international-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const histDeveloped = await fetchDailyAdjusted(apiKey, DEVELOPED);
    await sleep(900);
    const histEmerging = await fetchDailyAdjusted(apiKey, EMERGING);
    await sleep(900);
    const histUS = await fetchDailyAdjusted(apiKey, US);
    await sleep(900);
    const eurUsdMonthly = await fetchEurUsdMonthly(apiKey);

    // Common trading-day calendar: SPY's own dates (longest history),
    // restricted to on/after the later of EFA's and EEM's first date — EEM
    // (inception Apr 2003) is the binding constraint since EFA started in
    // Aug 2001.
    const commonStart = histDeveloped.dates[0] > histEmerging.dates[0] ? histDeveloped.dates[0] : histEmerging.dates[0];
    const dates = histUS.dates.filter((d) => d >= commonStart);
    if (!dates.length) throw new Error("no overlapping trading days across EFA/EEM/SPY");

    const developedBase = closeOnOrBefore(histDeveloped, dates[0]).close;
    const emergingBase = closeOnOrBefore(histEmerging, dates[0]).close;
    const usBase = closeOnOrBefore(histUS, dates[0]).close;

    const developed = [];
    const emerging = [];
    const us = [];
    const ratioDevelopedUS = [];
    const ratioEmergingUS = [];
    for (const d of dates) {
      const dv = (closeOnOrBefore(histDeveloped, d).close / developedBase) * 100;
      const em = (closeOnOrBefore(histEmerging, d).close / emergingBase) * 100;
      const us_ = (closeOnOrBefore(histUS, d).close / usBase) * 100;
      developed.push(Math.round(dv * 100) / 100);
      emerging.push(Math.round(em * 100) / 100);
      us.push(Math.round(us_ * 100) / 100);
      ratioDevelopedUS.push(Math.round((dv / us_) * 100 * 100) / 100);
      ratioEmergingUS.push(Math.round((em / us_) * 100 * 100) / 100);
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
    for (const [label, hist] of [["developed", histDeveloped], ["emerging", histEmerging], ["us", histUS]]) {
      const latestClose = closeOnOrBefore(hist, latestDate).close;
      ladder[label] = periods.map((p) => trailingReturn(hist, latestDate, latestClose, p.months));
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: latestDate,
      commonStartDate: dates[0],
      symbols: { developed: DEVELOPED, emerging: EMERGING, us: US },
      dates,
      developed,
      emerging,
      us,
      ratioDevelopedUS,
      ratioEmergingUS,
      ladder,
      eurUsdMonthly,
    };

    await getInternationalStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-international-background: wrote ${dates.length} trading days, as of ${latestDate}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, days: dates.length, asOfDate: latestDate }) };
  } catch (err) {
    console.error(`scheduled-international-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
