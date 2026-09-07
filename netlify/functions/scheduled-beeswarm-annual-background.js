// Scheduled Background Function (see netlify.toml) that computes calendar-
// year total returns for the 11 SPDR sector ETFs plus SPY, for roughly the
// last 15 full calendar years plus the current year-to-date, and writes the
// result to Netlify Blobs for beeswarm-annual.js to serve.
//
// This is the "annual" mode of the sector-beeswarm page — the individual-
// company daily view can't go back 15 years (no such intraday/constituent
// history is obtainable at that scale), so the historical view drops to
// sector-ETF granularity at annual resolution instead.
//
// Only ~12 Alpha Vantage calls per run (TIME_SERIES_MONTHLY_ADJUSTED,
// which returns full history in one call per symbol), so this could be a
// standard function — it's a Background Function only for consistency with
// the other scheduled jobs and headroom if pacing ever needs to grow.
// Runs weekly; the underlying data only changes meaningfully once a year
// (at each year-end close) plus a slow YTD drift the rest of the time.

const { getBeeswarmStore, ANNUAL_KEY } = require("./beeswarm-blob-store");
const { SECTOR_ORDER, SECTOR_ETF } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const BENCHMARK = "SPY";
const YEARS_BACK = 15;

// Approximate S&P 500 year-end GICS sector weights (%), used only to size
// the bubbles in the annual view — not a precise figure and not shown as a
// number anywhere. Real Estate broke out of Financials in Sep 2016 and
// Communication Services replaced Telecom in Sep 2018; for years before an
// ETF existed the weight is irrelevant (no bubble is drawn). Sourced from
// S&P / SPDR sector weightings, rounded.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Monthly adjusted close series -> { "YYYY-MM": adjClose }, ascending.
async function fetchMonthlyAdjusted(apiKey, symbol) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${symbol}&apikey=${apiKey}`
  );
  const series = payload["Monthly Adjusted Time Series"];
  if (!series) {
    throw new Error(
      `TIME_SERIES_MONTHLY_ADJUSTED missing for ${symbol}: ` +
        (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 160))
    );
  }
  const byMonth = {};
  for (const [date, row] of Object.entries(series)) {
    byMonth[date.slice(0, 7)] = parseFloat(row["5. adjusted close"]);
  }
  return byMonth;
}

// Calendar-year total return for year Y = last available month-end of Y
// over last available month-end of Y-1. Returns null if either anchor is
// missing (e.g. the ETF didn't trade yet).
function yearReturn(byMonth, year) {
  const endThis = latestMonthInYear(byMonth, year);
  const endPrev = latestMonthInYear(byMonth, year - 1);
  if (!endThis || !endPrev) return null;
  return (byMonth[endThis] / byMonth[endPrev] - 1) * 100;
}

function latestMonthInYear(byMonth, year) {
  let best = null;
  for (const ym of Object.keys(byMonth)) {
    if (ym.startsWith(String(year)) && (!best || ym > best)) best = ym;
  }
  return best;
}

exports.handler = async () => {
  console.log("scheduled-beeswarm-annual-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const firstYear = currentYear - YEARS_BACK;

    const symbols = [BENCHMARK, ...SECTOR_ORDER.map((s) => SECTOR_ETF[s])];
    const monthlyBySymbol = new Map();
    for (const sym of symbols) {
      try {
        monthlyBySymbol.set(sym, await fetchMonthlyAdjusted(apiKey, sym));
      } catch (err) {
        console.error(`scheduled-beeswarm-annual-background: ${sym} failed: ${err.message}`);
      }
      await sleep(900);
    }

    const spy = monthlyBySymbol.get(BENCHMARK);
    if (!spy) throw new Error("SPY failed to load — cannot build annual payload");

    const years = [];
    for (let y = firstYear; y <= currentYear; y++) {
      const spyRet = yearReturn(spy, y);
      if (spyRet === null) continue;

      const sectors = [];
      for (const sectorName of SECTOR_ORDER) {
        const etf = SECTOR_ETF[sectorName];
        const byMonth = monthlyBySymbol.get(etf);
        if (!byMonth) continue;
        const ret = yearReturn(byMonth, y);
        if (ret === null) continue;
        const weight =
          (SECTOR_WEIGHTS_BY_YEAR[y] && SECTOR_WEIGHTS_BY_YEAR[y][sectorName]) ||
          (SECTOR_WEIGHTS_BY_YEAR[2025] && SECTOR_WEIGHTS_BY_YEAR[2025][sectorName]) ||
          5;
        sectors.push({
          ticker: etf,
          sector: sectorName,
          ret: Math.round(ret * 100) / 100,
          weight,
        });
      }

      years.push({
        year: y,
        ytd: y === currentYear,
        asOfMonth: latestMonthInYear(spy, y),
        spyReturn: Math.round(spyRet * 100) / 100,
        sectors,
      });
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      benchmark: BENCHMARK,
      years,
    };

    await getBeeswarmStore().setJSON(ANNUAL_KEY, payload);
    console.log(`scheduled-beeswarm-annual-background: wrote ${years.length} years`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, years: years.length }) };
  } catch (err) {
    console.error(`scheduled-beeswarm-annual-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
