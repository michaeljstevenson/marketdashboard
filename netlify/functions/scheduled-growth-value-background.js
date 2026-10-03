// Scheduled Background Function (see [functions."scheduled-growth-value-
// background"] in netlify.toml) that builds the daily growth-vs-value
// dataset behind /growth-vs-value.html: aligned, indexed daily adjusted
// price history for IWF (Russell 1000 Growth), IWD (Russell 1000 Value) and
// SPY (blend benchmark), a trailing-return ladder, and the full monthly
// 10-year Treasury yield history the page regresses the style spread on.
//
// Only 4 Alpha Vantage calls (3x TIME_SERIES_DAILY_ADJUSTED full history +
// TREASURY_YIELD monthly), so simple spacing between calls is enough.

const { getGrowthValueStore, BLOB_KEY } = require("./growthvalue-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const GROWTH = "IWF";
const VALUE = "IWD";
const BLEND = "SPY";

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
  console.log("scheduled-growth-value-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const histGrowth = await fetchDailyAdjusted(apiKey, GROWTH);
    await sleep(900);
    const histValue = await fetchDailyAdjusted(apiKey, VALUE);
    await sleep(900);
    const histBlend = await fetchDailyAdjusted(apiKey, BLEND);
    await sleep(900);
    const treasury10yMonthly = await fetchMonthlySeries(apiKey, "TREASURY_YIELD", "&maturity=10year");

    // IWF and IWD both launched May 2000; SPY's calendar is the master one,
    // restricted to on/after the later of the two style ETFs' first dates.
    const commonStart = histGrowth.dates[0] > histValue.dates[0] ? histGrowth.dates[0] : histValue.dates[0];
    const dates = histBlend.dates.filter((d) => d >= commonStart);
    if (!dates.length) throw new Error("no overlapping trading days across IWF/IWD/SPY");

    const growthBase = closeOnOrBefore(histGrowth, dates[0]).close;
    const valueBase = closeOnOrBefore(histValue, dates[0]).close;
    const blendBase = closeOnOrBefore(histBlend, dates[0]).close;

    const growth = [];
    const value = [];
    const blend = [];
    const ratioGrowthValue = [];
    for (const d of dates) {
      const g = (closeOnOrBefore(histGrowth, d).close / growthBase) * 100;
      const v = (closeOnOrBefore(histValue, d).close / valueBase) * 100;
      const b = (closeOnOrBefore(histBlend, d).close / blendBase) * 100;
      growth.push(Math.round(g * 100) / 100);
      value.push(Math.round(v * 100) / 100);
      blend.push(Math.round(b * 100) / 100);
      ratioGrowthValue.push(Math.round((g / v) * 100 * 100) / 100);
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
    for (const [label, hist] of [["growth", histGrowth], ["value", histValue], ["blend", histBlend]]) {
      const latestClose = closeOnOrBefore(hist, latestDate).close;
      ladder[label] = periods.map((p) => trailingReturn(hist, latestDate, latestClose, p.months));
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: latestDate,
      commonStartDate: dates[0],
      symbols: { growth: GROWTH, value: VALUE, blend: BLEND },
      dates,
      growth,
      value,
      blend,
      ratioGrowthValue,
      ladder,
      treasury10yMonthly,
    };

    await getGrowthValueStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-growth-value-background: wrote ${dates.length} trading days, as of ${latestDate}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, days: dates.length, asOfDate: latestDate }) };
  } catch (err) {
    console.error(`scheduled-growth-value-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
