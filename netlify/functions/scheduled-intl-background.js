// Scheduled Background Function (see [functions."scheduled-intl-
// background"] in netlify.toml) that builds the daily international-vs-US
// dataset behind /international-vs-us.html: aligned, indexed daily price
// history for SPY (US large-cap), EFA (MSCI EAFE developed ex-US proxy),
// EEM (MSCI Emerging Markets proxy) and UUP (US Dollar Index bullish fund,
// the page's dollar-strength proxy), plus a trailing-return ladder for the
// three equity legs. Writes the result to Netlify Blobs for
// international-vs-us.js to serve.
//
// Only 4 Alpha Vantage calls (4x TIME_SERIES_DAILY_ADJUSTED full history),
// so like scheduled-smallcap-background.js this doesn't need heavy
// rate-limit pacing — just simple spacing between the sequential calls.
// Runs daily (not weekly) since index levels genuinely move every trading
// day. Deliberately doesn't pull a separate FX/dollar-index series: UUP's
// own indexed daily closes double as the page's dollar-strength measure
// (month-over-month % change), so there's no fifth call needed.

const { getIntlStore, BLOB_KEY } = require("./intl-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const US = "SPY";
const DEV = "EFA";
const EM = "EEM";
const USD = "UUP";

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
  console.log("scheduled-intl-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const histUs = await fetchDailyAdjusted(apiKey, US);
    await sleep(900);
    const histDev = await fetchDailyAdjusted(apiKey, DEV);
    await sleep(900);
    const histEm = await fetchDailyAdjusted(apiKey, EM);
    await sleep(900);
    const histUsd = await fetchDailyAdjusted(apiKey, USD);

    // Common trading-day calendar: SPY's own dates (longest history),
    // restricted to on/after the latest of EFA's/EEM's/UUP's first date —
    // UUP (inception Feb 2007) is the binding constraint since EFA and EEM
    // both started trading years earlier (2001 and 2003 respectively).
    let commonStart = histDev.dates[0];
    if (histEm.dates[0] > commonStart) commonStart = histEm.dates[0];
    if (histUsd.dates[0] > commonStart) commonStart = histUsd.dates[0];
    const dates = histUs.dates.filter((d) => d >= commonStart);
    if (!dates.length) throw new Error("no overlapping trading days across SPY/EFA/EEM/UUP");

    const usBase = closeOnOrBefore(histUs, dates[0]).close;
    const devBase = closeOnOrBefore(histDev, dates[0]).close;
    const emBase = closeOnOrBefore(histEm, dates[0]).close;
    const usdBase = closeOnOrBefore(histUsd, dates[0]).close;

    const us = [];
    const dev = [];
    const em = [];
    const usd = [];
    const ratioDevUs = [];
    const ratioEmUs = [];
    for (const d of dates) {
      const u = (closeOnOrBefore(histUs, d).close / usBase) * 100;
      const de = (closeOnOrBefore(histDev, d).close / devBase) * 100;
      const e = (closeOnOrBefore(histEm, d).close / emBase) * 100;
      const us$ = (closeOnOrBefore(histUsd, d).close / usdBase) * 100;
      us.push(Math.round(u * 100) / 100);
      dev.push(Math.round(de * 100) / 100);
      em.push(Math.round(e * 100) / 100);
      usd.push(Math.round(us$ * 100) / 100);
      ratioDevUs.push(Math.round((de / u) * 100 * 100) / 100);
      ratioEmUs.push(Math.round((e / u) * 100 * 100) / 100);
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
    for (const [label, hist] of [["us", histUs], ["dev", histDev], ["em", histEm]]) {
      const latestClose = closeOnOrBefore(hist, latestDate).close;
      ladder[label] = periods.map((p) => trailingReturn(hist, latestDate, latestClose, p.months));
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: latestDate,
      commonStartDate: dates[0],
      symbols: { us: US, dev: DEV, em: EM, usd: USD },
      dates,
      us,
      dev,
      em,
      usd,
      ratioDevUs,
      ratioEmUs,
      ladder,
    };

    await getIntlStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-intl-background: wrote ${dates.length} trading days, as of ${latestDate}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, days: dates.length, asOfDate: latestDate }) };
  } catch (err) {
    console.error(`scheduled-intl-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
