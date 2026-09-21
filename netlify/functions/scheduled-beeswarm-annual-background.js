// Scheduled Background Function (see netlify.toml) that builds the "annual"
// mode of the sector-beeswarm page: the year-by-year path of each of the 11
// SPDR sector ETFs (plus SPY), for roughly the last 15 full calendar years
// plus the current year-to-date, and writes it to Netlify Blobs for
// beeswarm-annual.js to serve.
//
// The individual-company daily view can't go back 15 years (no such
// constituent history is obtainable at that scale), so the historical view
// drops to sector-ETF granularity — but NOT to a single year-end snapshot.
// It carries every trading day's cumulative calendar-year total return (the
// return resets each Jan 1), so the page can animate the bubbles drifting
// through each year the way the Chartfleau reference animates through a day,
// rather than snapping between 12 year-end dots.
//
// ~12 Alpha Vantage calls per run (TIME_SERIES_DAILY_ADJUSTED, outputsize
// full — same endpoint scheduled-sectors-background.js uses). Runs weekly;
// the shape of a completed year never changes and the current year only
// drifts slowly.

const { getBeeswarmStore, ANNUAL_KEY } = require("./beeswarm-blob-store");
const { SECTOR_ORDER, SECTOR_ETF } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const BENCHMARK = "SPY";
const YEARS_BACK = 15;

// Approximate S&P 500 year-end GICS sector weights (%), used only to size
// the bubbles — not a precise figure and not shown as a number. Real Estate
// broke out of Financials in Sep 2016 and Communication Services replaced
// Telecom in Sep 2018; for years before an ETF traded the weight is unused
// (no bubble is drawn). Sourced from S&P / SPDR sector weightings, rounded.
const SECTOR_WEIGHTS_BY_YEAR = {
  2010: { "Information Technology": 18.7, "Health Care": 10.9, Financials: 16.1, "Consumer Discretionary": 10.6, "Communication Services": 3.1, Industrials: 11.3, "Consumer Staples": 10.6, Energy: 12.0, Utilities: 3.3, "Real Estate": 0, Materials: 3.7 },
  2011: { "Information Technology": 19.0, "Health Care": 11.9, Financials: 13.4, "Consumer Discretionary": 10.7, "Communication Services": 3.2, Industrials: 10.7, "Consumer Staples": 11.5, Energy: 12.3, Utilities: 3.9, "Real Estate": 0, Materials: 3.5 },
  2012: { "Information Technology": 19.0, "Health Care": 12.0, Financials: 15.6, "Consumer Discretionary": 11.5, "Communication Services": 3.1, Industrials: 10.0, "Consumer Staples": 10.6, Energy: 11.0, Utilities: 3.4, "Real Estate": 0, Materials: 3.5 },
  2013: { "Information Technology": 18.6, "Health Care": 13.0, Financials: 16.2, "Consumer Discretionary": 12.5, "Communication Services": 2.4, Industrials: 10.9, "Consumer Staples": 9.8, Energy: 10.3, Utilities: 2.9, "Real Estate": 0, Materials: 3.5 },
  2014: { "Information Technology": 19.7, "Health Care": 14.2, Financials: 16.7, "Consumer Discretionary": 11.9, "Communication Services": 2.3, Industrials: 10.4, "Consumer Staples": 9.8, Energy: 8.4, Utilities: 3.2, "Real Estate": 0, Materials: 3.2 },
  2015: { "Information Technology": 20.7, "Health Care": 15.2, Financials: 16.5, "Consumer Discretionary": 12.9, "Communication Services": 2.4, Industrials: 10.1, "Consumer Staples": 10.1, Energy: 6.5, Utilities: 3.0, "Real Estate": 0, Materials: 2.8 },
  2016: { "Information Technology": 20.8, "Health Care": 13.6, Financials: 14.8, "Consumer Discretionary": 12.0, "Communication Services": 2.8, Industrials: 10.3, "Consumer Staples": 9.4, Energy: 7.6, Utilities: 3.2, "Real Estate": 2.9, Materials: 2.8 },
  2017: { "Information Technology": 23.8, "Health Care": 13.8, Financials: 14.8, "Consumer Discretionary": 12.2, "Communication Services": 2.1, Industrials: 10.2, "Consumer Staples": 8.2, Energy: 6.1, Utilities: 2.9, "Real Estate": 2.9, Materials: 3.0 },
  2018: { "Information Technology": 20.1, "Health Care": 15.6, Financials: 13.3, "Consumer Discretionary": 9.9, "Communication Services": 10.0, Industrials: 9.1, "Consumer Staples": 7.4, Energy: 5.3, Utilities: 3.3, "Real Estate": 2.9, Materials: 2.7 },
  2019: { "Information Technology": 23.2, "Health Care": 14.2, Financials: 13.0, "Consumer Discretionary": 9.8, "Communication Services": 10.4, Industrials: 9.1, "Consumer Staples": 7.2, Energy: 4.3, Utilities: 3.3, "Real Estate": 2.9, Materials: 2.7 },
  2020: { "Information Technology": 27.6, "Health Care": 13.5, Financials: 10.4, "Consumer Discretionary": 12.7, "Communication Services": 10.8, Industrials: 8.4, "Consumer Staples": 6.5, Energy: 2.3, Utilities: 2.8, "Real Estate": 2.4, Materials: 2.6 },
  2021: { "Information Technology": 29.2, "Health Care": 13.3, Financials: 11.7, "Consumer Discretionary": 12.5, "Communication Services": 10.2, Industrials: 7.8, "Consumer Staples": 5.9, Energy: 2.7, Utilities: 2.5, "Real Estate": 2.7, Materials: 2.6 },
  2022: { "Information Technology": 25.7, "Health Care": 15.8, Financials: 11.7, "Consumer Discretionary": 9.8, "Communication Services": 7.3, Industrials: 8.7, "Consumer Staples": 7.2, Energy: 5.2, Utilities: 3.2, "Real Estate": 2.7, Materials: 2.7 },
  2023: { "Information Technology": 28.9, "Health Care": 12.6, Financials: 13.0, "Consumer Discretionary": 10.9, "Communication Services": 8.6, Industrials: 8.8, "Consumer Staples": 6.1, Energy: 3.9, Utilities: 2.3, "Real Estate": 2.5, Materials: 2.4 },
  2024: { "Information Technology": 32.5, "Health Care": 10.1, Financials: 13.6, "Consumer Discretionary": 11.3, "Communication Services": 9.4, Industrials: 8.2, "Consumer Staples": 5.5, Energy: 3.2, Utilities: 2.5, "Real Estate": 2.1, Materials: 1.9 },
  2025: { "Information Technology": 33.0, "Health Care": 9.5, Financials: 13.5, "Consumer Discretionary": 10.5, "Communication Services": 9.7, Industrials: 8.5, "Consumer Staples": 5.4, Energy: 3.0, Utilities: 2.5, "Real Estate": 2.0, Materials: 1.8 },
};
const weightsFor = (year) =>
  SECTOR_WEIGHTS_BY_YEAR[year] ||
  SECTOR_WEIGHTS_BY_YEAR[Math.max(...Object.keys(SECTOR_WEIGHTS_BY_YEAR).map(Number))];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Full daily adjusted-close history -> { dates:[asc], closes:[parallel] }.
// Adjusted close (dividends + splits) so these are true total returns —
// same reasoning as scheduled-sectors-background.js.
async function fetchDailyAdjusted(apiKey, symbol) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${apiKey}`
  );
  const series = payload["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      `TIME_SERIES_DAILY_ADJUSTED missing for ${symbol}: ` +
        (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 160))
    );
  }
  const rows = Object.entries(series)
    .map(([date, r]) => ({ date, close: parseFloat(r["5. adjusted close"]) }))
    .filter((r) => Number.isFinite(r.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { dates: rows.map((r) => r.date), closes: rows.map((r) => r.close) };
}

// Latest close on or before targetDate (dates ascending). Binary search.
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
  return closes[lo];
}

exports.handler = async () => {
  console.log("scheduled-beeswarm-annual-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const currentYear = new Date().getUTCFullYear();
    const firstYear = currentYear - YEARS_BACK;

    const etfBySector = SECTOR_ORDER.map((s) => ({ sector: s, etf: SECTOR_ETF[s] }));
    const symbols = [BENCHMARK, ...etfBySector.map((e) => e.etf)];

    const histBySymbol = new Map();
    for (const sym of symbols) {
      try {
        histBySymbol.set(sym, await fetchDailyAdjusted(apiKey, sym));
      } catch (err) {
        console.error(`scheduled-beeswarm-annual-background: ${sym} failed: ${err.message}`);
      }
      await sleep(900);
    }

    const spyHist = histBySymbol.get(BENCHMARK);
    if (!spyHist) throw new Error("SPY failed to load, cannot build annual payload");

    // SPY drives the shared trading-day calendar, from firstYear on.
    const firstDate = `${firstYear}-01-01`;
    const dates = spyHist.dates.filter((d) => d >= firstDate);

    // Year-end base close (last trading day <= Dec 31 of `year`).
    const baseClose = (hist, year) => closeOnOrBefore(hist, `${year}-12-31`);

    // Cumulative calendar-year total return (%) for one symbol across `dates`.
    // null until the symbol has a real prior-year-end anchor.
    function ytdSeries(hist) {
      if (!hist) return dates.map(() => null);
      const baseByYear = {};
      return dates.map((d) => {
        const year = +d.slice(0, 4);
        if (!(year in baseByYear)) baseByYear[year] = baseClose(hist, year - 1);
        const base = baseByYear[year];
        if (!base) return null;
        const c = closeOnOrBefore(hist, d);
        return c ? Math.round((c / base - 1) * 10000) / 100 : null;
      });
    }

    const spy = ytdSeries(spyHist);
    const series = {};
    for (const { etf } of etfBySector) series[etf] = ytdSeries(histBySymbol.get(etf));

    // Per-year slider metadata: index span, a stable y-axis envelope for
    // that year (so the axis holds still while a year animates), and the
    // sector weights used for bubble size.
    const years = [];
    for (let y = firstYear; y <= currentYear; y++) {
      let start = -1;
      let end = -1;
      for (let i = 0; i < dates.length; i++) {
        if (+dates[i].slice(0, 4) !== y) continue;
        if (start < 0) start = i;
        end = i;
      }
      if (start < 0 || spy[end] === null) continue;

      // Per-sector peak / trough across the year, then drop the single most
      // extreme sector on each side before setting the axis. One sector that
      // runs away (energy 2022, +60%+) otherwise stretches the axis so far
      // that the other ten sit squashed in a thin band; the runaway just
      // clamps to the edge on the page instead. SPY's range is always kept.
      const peaks = [];
      const troughs = [];
      for (const e of etfBySector) {
        let p = null;
        let t = null;
        for (let i = start; i <= end; i++) {
          const v = series[e.etf][i];
          if (v === null) continue;
          if (p === null || v > p) p = v;
          if (t === null || v < t) t = v;
        }
        if (p !== null) peaks.push(p);
        if (t !== null) troughs.push(t);
      }
      peaks.sort((a, b) => a - b);
      troughs.sort((a, b) => a - b);
      let spyLo = 0;
      let spyHi = 0;
      for (let i = start; i <= end; i++) {
        if (spy[i] === null) continue;
        if (spy[i] < spyLo) spyLo = spy[i];
        if (spy[i] > spyHi) spyHi = spy[i];
      }
      const hi = Math.max(spyHi, peaks.length > 1 ? peaks[peaks.length - 2] : peaks[peaks.length - 1] || 0);
      const lo = Math.min(spyLo, troughs.length > 1 ? troughs[1] : troughs[0] || 0);

      const wt = weightsFor(y);
      years.push({
        year: y,
        ytd: y === currentYear,
        startIndex: start,
        endIndex: end,
        yLo: Math.max(-55, Math.min(-10, Math.floor(lo / 5) * 5 - 5)),
        yHi: Math.max(12, Math.min(55, Math.ceil(hi / 5) * 5 + 5)),
        weights: Object.fromEntries(etfBySector.map((e) => [e.sector, wt[e.sector] || 5])),
      });
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      benchmark: BENCHMARK,
      sectorOrder: SECTOR_ORDER,
      etf: Object.fromEntries(etfBySector.map((e) => [e.sector, e.etf])),
      dates,
      spy,
      series,
      years,
    };

    await getBeeswarmStore().setJSON(ANNUAL_KEY, payload);
    console.log(
      `scheduled-beeswarm-annual-background: wrote ${dates.length} trading days across ${years.length} years`
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true, days: dates.length, years: years.length }) };
  } catch (err) {
    console.error(`scheduled-beeswarm-annual-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
