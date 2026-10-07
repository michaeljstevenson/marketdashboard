// Scheduled Background Function (see [functions."scheduled-international-
// background"] in netlify.toml) that builds the daily international-vs-US
// dataset behind /international-vs-us.html: aligned, indexed daily price
// history for EFA (developed-markets-ex-US proxy), EEM (emerging-markets
// proxy) and SPY (US large-cap proxy), a trailing-return ladder for all
// three, plus the full monthly EUR/USD history used as the page's dollar-
// direction proxy. Writes the result to Netlify Blobs for
// international-us.js to serve.
//
// On top of that it adds:
//   - a currency vs. local-market split of the EFA-minus-SPY gap, using the
//     currency-hedged HEFA as the local-currency stand-in (2015 on), and Ken
//     French's Major Markets index, which publishes dollar and local returns
//     side by side, for 1975 on;
//   - leadership cycles on a monthly international/US relative line back to
//     1975 (Ken French spliced to EFA/SPY once Ken French's months run out);
//   - rolling 36-month correlations (ETFs and Ken French);
//   - a country ETF return heat map. Tickers the Country / Sector Scorecard
//     job already stores are read from its blob (it runs at 21:45 UTC on
//     weekdays, before this job), the rest are fetched here.
//
// About 20 sequential Yahoo calls a day plus three small Ken French zips
// at most once a calendar month (cached in this job's own store).

const { getInternationalStore, BLOB_KEY, KF_BLOB_KEY } = require("./international-blob-store");
const { getCountryStore, BLOB_KEY: COUNTRY_BLOB_KEY } = require("./country-blob-store");
const { fetchDailyHistory, fetchMonthEndCloses } = require("./yahoo-client");
const {
  fetchKenFrenchLongHistory,
  monthEnds,
  monthlyReturns,
  splice,
  findCycles,
  rollingCorrelation,
} = require("./international-long-history");

const DEVELOPED = "EFA"; // iShares MSCI EAFE ETF — developed markets ex-US, inception Aug 2001
const EMERGING = "EEM"; // iShares MSCI Emerging Markets ETF, inception Apr 2003
const US = "SPY";
const HEDGED = "HEFA"; // iShares Currency Hedged MSCI EAFE ETF, inception Jan 2014
const DOLLAR_INDEX = "DX-Y.NYB"; // ICE US Dollar Index, daily from 1971 on Yahoo

// A leadership leg ends once the relative line reverses 20% from its
// extreme. At 15% a one-month 1990 rebound and the 2008-09 crash swings
// count as separate legs. At 30% the 1983-88 run swallows its 1984 pause.
// 20% keeps the multi-year swings and drops the noise.
const CYCLE_THRESHOLD = 0.2;
const CORR_WINDOW = 36;
const HEAT_PERIODS = ["1M", "3M", "YTD", "1Y", "3Y", "5Y"];

const HEATMAP_UNIVERSE = [
  { ticker: "SPY", name: "United States", group: "Benchmarks" },
  { ticker: "EFA", name: "Developed ex-US", group: "Benchmarks" },
  { ticker: "EEM", name: "Emerging markets", group: "Benchmarks" },
  { ticker: "EWJ", name: "Japan", group: "Developed" },
  { ticker: "EWU", name: "United Kingdom", group: "Developed" },
  { ticker: "EWG", name: "Germany", group: "Developed" },
  { ticker: "EWQ", name: "France", group: "Developed" },
  { ticker: "EWL", name: "Switzerland", group: "Developed" },
  { ticker: "EWN", name: "Netherlands", group: "Developed" },
  { ticker: "EWI", name: "Italy", group: "Developed" },
  { ticker: "EWP", name: "Spain", group: "Developed" },
  { ticker: "EWD", name: "Sweden", group: "Developed" },
  { ticker: "EWC", name: "Canada", group: "Developed" },
  { ticker: "EWA", name: "Australia", group: "Developed" },
  { ticker: "EWH", name: "Hong Kong", group: "Developed" },
  { ticker: "MCHI", name: "China", group: "Emerging" },
  { ticker: "INDA", name: "India", group: "Emerging" },
  { ticker: "EWT", name: "Taiwan", group: "Emerging" },
  { ticker: "EWY", name: "South Korea", group: "Emerging" },
  { ticker: "EWZ", name: "Brazil", group: "Emerging" },
  { ticker: "EWW", name: "Mexico", group: "Emerging" },
  { ticker: "EZA", name: "South Africa", group: "Emerging" },
  { ticker: "KSA", name: "Saudi Arabia", group: "Emerging" },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const round = (v, dp = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

// Full daily adjusted-close history -> { dates:[asc], closes:[parallel] }.
// Adjusted close (dividends + splits) so this is a true total-return series
// — same reasoning as scheduled-smallcap-background.js.
async function fetchDailyAdjusted(symbol, opts) {
  const rows = await fetchDailyHistory(symbol, opts);
  return { dates: rows.map((r) => r.date), closes: rows.map((r) => r.close) };
}

// EUR/USD monthly close history — a single, simple dollar-direction proxy
// (rising EUR/USD = dollar weakening) in the same spirit as the small-cap
// page's single-variable Fed-funds/Treasury-yield check: one macro variable
// rarely explains much on its own, and the point of showing it is honesty
// about that, not oversell.
async function fetchEurUsdMonthly() {
  const rows = await fetchMonthEndCloses("EURUSD=X");
  return rows.map((r) => ({ date: r.date, value: r.close }));
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

// A 5-year window that starts before a fund existed would silently measure
// a shorter period, so a period only counts when the history reaches back
// to within a week of its start.
function periodReturn(hist, latestDate, latestClose, months) {
  const target = addCalendarMonths(latestDate, months);
  const found = closeOnOrBefore(hist, target);
  if (!found || (new Date(target) - new Date(found.date)) / 86400000 > 7) return null;
  const r = trailingReturn(hist, latestDate, latestClose, months);
  return r ? r.cumPct : null;
}

function heatRow(hist) {
  const latestDate = hist.dates[hist.dates.length - 1];
  const latestClose = hist.closes[hist.closes.length - 1];
  const yearBase = closeOnOrBefore(hist, `${Number(latestDate.slice(0, 4)) - 1}-12-31`);
  const ytd = yearBase && yearBase.date.slice(0, 4) === String(Number(latestDate.slice(0, 4)) - 1)
    ? round((latestClose / yearBase.close - 1) * 100)
    : null;
  return {
    asOfDate: latestDate,
    values: [
      periodReturn(hist, latestDate, latestClose, 1),
      periodReturn(hist, latestDate, latestClose, 3),
      ytd,
      periodReturn(hist, latestDate, latestClose, 12),
      periodReturn(hist, latestDate, latestClose, 36),
      periodReturn(hist, latestDate, latestClose, 60),
    ],
  };
}

async function buildHeatmap(ownHistories, latestDate) {
  let countryRegions = new Map();
  try {
    const blob = await getCountryStore().get(COUNTRY_BLOB_KEY, { type: "json" });
    if (blob && Array.isArray(blob.regions)) countryRegions = new Map(blob.regions.map((r) => [r.ticker, r]));
  } catch (err) {
    console.error(`scheduled-international-background: country blob unreadable, fetching all heat-map tickers: ${err.message}`);
  }

  const histories = new Map(Object.entries(ownHistories));
  const sourceOf = {};
  const toFetch = [];
  for (const { ticker } of HEATMAP_UNIVERSE) {
    if (histories.has(ticker)) { sourceOf[ticker] = "own"; continue; }
    const stored = countryRegions.get(ticker);
    if (stored && stored.asOfDate >= latestDate && stored.history && stored.history.length) {
      histories.set(ticker, { dates: stored.history.map((h) => h.date), closes: stored.history.map((h) => h.close) });
      sourceOf[ticker] = "countries-blob";
    } else {
      toFetch.push(ticker);
    }
  }

  const sinceUnix = Math.floor(Date.now() / 1000) - Math.round(6.2 * 365.25 * 86400);
  const failed = [];
  for (const pass of [0, 1]) {
    const list = pass === 0 ? toFetch : failed.splice(0);
    if (pass === 1 && list.length) await sleep(2000);
    for (const ticker of list) {
      try {
        histories.set(ticker, await fetchDailyAdjusted(ticker, { sinceUnix }));
        sourceOf[ticker] = "yahoo";
      } catch (err) {
        console.error(`scheduled-international-background: heat map ${ticker} failed (pass ${pass + 1}): ${err.message}`);
        if (pass === 0) failed.push(ticker);
      }
      await sleep(300);
    }
  }

  const rows = HEATMAP_UNIVERSE.map(({ ticker, name, group }) => {
    const hist = histories.get(ticker);
    if (!hist || !hist.dates.length) return { ticker, name, group, asOfDate: null, values: HEAT_PERIODS.map(() => null) };
    return { ticker, name, group, ...heatRow(hist) };
  });
  console.log(`scheduled-international-background: heat map ${rows.filter((r) => r.asOfDate).length}/${rows.length} tickers, ${Object.values(sourceOf).filter((s) => s === "countries-blob").length} from the country blob`);
  return { periods: HEAT_PERIODS, rows, sourceOf };
}

// Ken French files change about once a month, so the cached copy is reused
// for the rest of the calendar month it was fetched in. A failed download
// falls back to whatever is cached.
async function loadKenFrench(store) {
  let cached = null;
  try {
    cached = await store.get(KF_BLOB_KEY, { type: "json" });
  } catch (err) {
    console.error(`scheduled-international-background: Ken French cache unreadable: ${err.message}`);
  }
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (cached && cached.fetchedAt && cached.fetchedAt.slice(0, 7) === thisMonth) return cached;
  try {
    const fresh = await fetchKenFrenchLongHistory();
    await store.setJSON(KF_BLOB_KEY, fresh);
    console.log(`scheduled-international-background: refreshed Ken French (Major Markets through ${fresh.majorDollar.at(-1).ym}, US through ${fresh.us.at(-1).ym}, emerging through ${fresh.emerging.at(-1).ym})`);
    return fresh;
  } catch (err) {
    console.error(`scheduled-international-background: Ken French download failed: ${err.message}`);
    return cached;
  }
}

function pctChange(hist, fromDate, toDate) {
  const a = closeOnOrBefore(hist, fromDate);
  const b = closeOnOrBefore(hist, toDate);
  if (!a || !b) return null;
  return (b.close / a.close - 1) * 100;
}

// gap = EFA - SPY, split exactly into (HEFA - SPY) + (EFA - HEFA). The
// second piece is the unhedged-minus-hedged return, i.e. the currency move
// net of the hedge's forward points.
function splitWindow(h, fromDate, toDate) {
  const efa = pctChange(h.efa, fromDate, toDate);
  const spy = pctChange(h.spy, fromDate, toDate);
  const hefa = pctChange(h.hefa, fromDate, toDate);
  if (efa == null || spy == null || hefa == null) return null;
  return {
    efa: round(efa), spy: round(spy), hefa: round(hefa),
    gap: round(efa - spy), local: round(hefa - spy), currency: round(efa - hefa),
    dxy: round(pctChange(h.dxy, fromDate, toDate)),
  };
}

function etfYearSplits(h, latestDate) {
  const firstFullYear = Number(h.hefa.dates[0].slice(0, 4)) + 1;
  const lastYear = Number(latestDate.slice(0, 4));
  const out = [];
  for (let year = firstFullYear; year <= lastYear; year++) {
    const partial = year === lastYear && latestDate.slice(5) < "12-31";
    const s = splitWindow(h, `${year - 1}-12-31`, partial ? latestDate : `${year}-12-31`);
    if (s) out.push({ year, partial, throughDate: partial ? latestDate : null, ...s });
  }
  return out;
}

function compound(rets) {
  return (rets.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100;
}

// Exact split for an index that publishes both versions: dollar return =
// (1 + local)(1 + currency) - 1. Additive pieces in percentage points:
// local vs US = local - US, currency = dollar - local (which keeps the small
// local x currency cross term).
function kfYearSplits(kf, dxyMonthEnd) {
  const byYear = new Map();
  const local = new Map(kf.majorLocal.map((r) => [r.ym, r.ret]));
  const us = new Map(kf.us.map((r) => [r.ym, r.ret]));
  for (const r of kf.majorDollar) {
    if (!local.has(r.ym) || !us.has(r.ym)) continue;
    const y = r.ym.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, { d: [], l: [], u: [] });
    const b = byYear.get(y);
    b.d.push(r.ret); b.l.push(local.get(r.ym)); b.u.push(us.get(r.ym));
  }
  const out = [];
  for (const [y, b] of byYear) {
    if (b.d.length !== 12) continue;
    const intl = compound(b.d), loc = compound(b.l), usr = compound(b.u);
    const d0 = dxyMonthEnd.get(`${Number(y) - 1}-12`), d1 = dxyMonthEnd.get(`${y}-12`);
    out.push({
      year: Number(y), intl: round(intl), intlLocal: round(loc), us: round(usr),
      gap: round(intl - usr), local: round(loc - usr), currency: round(intl - loc),
      dxy: d0 && d1 ? round((d1 / d0 - 1) * 100) : null,
    });
  }
  return out;
}

// Whether `date` is the last weekday of its month (holidays aside), so its
// month-end return is complete.
function monthComplete(date) {
  const d = new Date(date + "T00:00:00Z");
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 7) !== date.slice(0, 7);
}

function buildLongHistory(kf, monthly, dxyMonthEnd, latestDate) {
  const intl = splice(kf.majorDollar, monthly.efa, "kf", "etf");
  const local = new Map(splice(kf.majorLocal, monthly.hefa, "kf", "etf").map((r) => [r.ym, r]));
  const us = new Map(splice(kf.us.filter((r) => r.ym >= kf.majorDollar[0].ym), monthly.spy, "kf", "etf").map((r) => [r.ym, r]));

  const firstYm = intl[0].ym;
  const [fy, fm] = firstYm.split("-").map(Number);
  const baseYm = fm === 1 ? `${fy - 1}-12` : `${fy}-${String(fm - 1).padStart(2, "0")}`;
  const months = [baseYm];
  const relative = [100];
  const rIntl = [null], rLocal = [null], rUs = [null];
  for (const r of intl) {
    const u = us.get(r.ym);
    if (!u) continue;
    months.push(r.ym);
    relative.push(relative[relative.length - 1] * (1 + r.ret / 100) / (1 + u.ret / 100));
    rIntl.push(r.ret);
    rUs.push(u.ret);
    rLocal.push(local.has(r.ym) ? local.get(r.ym).ret : null);
  }

  const legs = findCycles(relative, CYCLE_THRESHOLD).map((g) => {
    const span = [];
    for (let i = g.startIdx + 1; i <= g.endIdx; i++) span.push(i);
    const intlC = compound(span.map((i) => rIntl[i]));
    const usC = compound(span.map((i) => rUs[i]));
    const hasLocal = span.every((i) => rLocal[i] != null);
    const locC = hasLocal ? compound(span.map((i) => rLocal[i])) : null;
    const endYm = months[g.endIdx];
    const d0 = dxyMonthEnd.get(months[g.startIdx]);
    const d1 = g.ongoing ? dxyMonthEnd.get(latestDate.slice(0, 7)) : dxyMonthEnd.get(endYm);
    const leg = {
      leader: g.leader,
      start: months[g.startIdx],
      end: endYm,
      endDate: g.ongoing ? latestDate : null,
      months: g.endIdx - g.startIdx,
      relChange: round((relative[g.endIdx] / relative[g.startIdx] - 1) * 100, 1),
      intlReturn: round(intlC, 1),
      usReturn: round(usC, 1),
      currency: hasLocal ? round(((1 + intlC / 100) / (1 + locC / 100) - 1) * 100, 1) : null,
      localVsUs: hasLocal ? round(((1 + locC / 100) / (1 + usC / 100) - 1) * 100, 1) : null,
      dxy: d0 && d1 ? round((d1 / d0 - 1) * 100, 1) : null,
      ongoing: g.ongoing,
      fromDataStart: g.fromDataStart,
    };
    if (g.ongoing) {
      let ext = g.startIdx;
      for (let i = g.startIdx; i <= g.endIdx; i++) {
        if (g.leader === "international" ? relative[i] > relative[ext] : relative[i] < relative[ext]) ext = i;
      }
      leg.extreme = months[ext];
      leg.extremeChange = round((relative[ext] / relative[g.startIdx] - 1) * 100, 1);
      leg.fromExtreme = round((relative[g.endIdx] / relative[ext] - 1) * 100, 1);
    }
    return leg;
  });

  return {
    threshold: CYCLE_THRESHOLD,
    baseMonth: baseYm,
    lastDate: latestDate,
    splice: {
      intlKfThrough: kf.majorDollar.at(-1).ym,
      localKfThrough: kf.majorLocal.at(-1).ym,
      usKfThrough: kf.us.at(-1).ym,
      emergingKfThrough: kf.emerging.at(-1).ym,
      kfFetchedAt: kf.fetchedAt,
    },
    months,
    relative: relative.map((v) => round(v, 3)),
    legs,
  };
}

exports.handler = async () => {
  console.log("scheduled-international-background: starting");
  const t0 = Date.now();
  try {
    const store = getInternationalStore();

    const histDeveloped = await fetchDailyAdjusted(DEVELOPED);
    await sleep(900);
    const histEmerging = await fetchDailyAdjusted(EMERGING);
    await sleep(900);
    const histUS = await fetchDailyAdjusted(US);
    await sleep(900);
    const eurUsdMonthly = await fetchEurUsdMonthly();
    await sleep(900);
    const histHedged = await fetchDailyAdjusted(HEDGED);
    await sleep(900);
    const dxyDaily = await fetchDailyHistory(DOLLAR_INDEX, { adjusted: false });
    const histDxy = { dates: dxyDaily.map((r) => r.date), closes: dxyDaily.map((r) => r.close) };

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

    // Currency vs. local split, ETF version. The trailing window matches the
    // page's 252-trading-day 12-month relative return.
    const h = { efa: histDeveloped, spy: histUS, hefa: histHedged, dxy: histDxy };
    const trailingStart = dates[Math.max(0, dates.length - 1 - 252)];
    const currencySplit = {
      hedgedSymbol: HEDGED,
      hedgedFirstDate: histHedged.dates[0],
      trailing12m: { startDate: trailingStart, endDate: latestDate, ...splitWindow(h, trailingStart, latestDate) },
      etfYears: etfYearSplits(h, latestDate),
      kfYears: null,
    };

    const monthly = {
      efa: monthlyReturns(monthEnds(histDeveloped.dates.map((d, i) => ({ date: d, close: histDeveloped.closes[i] })))),
      eem: monthlyReturns(monthEnds(histEmerging.dates.map((d, i) => ({ date: d, close: histEmerging.closes[i] })))),
      spy: monthlyReturns(monthEnds(histUS.dates.map((d, i) => ({ date: d, close: histUS.closes[i] })))),
      hefa: monthlyReturns(monthEnds(histHedged.dates.map((d, i) => ({ date: d, close: histHedged.closes[i] })))),
    };
    const dxyMonthEnd = new Map(monthEnds(dxyDaily).map((r) => [r.ym, r.close]));

    // Correlations use complete months only.
    const partialYm = monthComplete(latestDate) ? null : latestDate.slice(0, 7);
    const complete = (rows) => rows.filter((r) => r.ym !== partialYm);
    const correlation = {
      window: CORR_WINDOW,
      developedEtf: rollingCorrelation(complete(monthly.efa), complete(monthly.spy), CORR_WINDOW),
      emergingEtf: rollingCorrelation(complete(monthly.eem), complete(monthly.spy), CORR_WINDOW),
      developedKf: null,
      emergingKf: null,
    };

    let long = null;
    const kf = await loadKenFrench(store);
    if (kf) {
      currencySplit.kfYears = kfYearSplits(kf, dxyMonthEnd);
      long = buildLongHistory(kf, monthly, dxyMonthEnd, latestDate);
      correlation.developedKf = rollingCorrelation(kf.majorDollar, kf.us, CORR_WINDOW);
      correlation.emergingKf = rollingCorrelation(kf.emerging, kf.us, CORR_WINDOW);
    }

    await sleep(900);
    const heatmap = await buildHeatmap({ SPY: histUS, EFA: histDeveloped, EEM: histEmerging }, latestDate);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: latestDate,
      commonStartDate: dates[0],
      symbols: { developed: DEVELOPED, emerging: EMERGING, us: US, hedged: HEDGED, dollarIndex: DOLLAR_INDEX },
      dates,
      developed,
      emerging,
      us,
      ratioDevelopedUS,
      ratioEmergingUS,
      ladder,
      eurUsdMonthly,
      currencySplit,
      long,
      correlation,
      heatmap,
    };

    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-international-background: wrote ${dates.length} trading days, as of ${latestDate}, in ${Math.round((Date.now() - t0) / 1000)}s`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, days: dates.length, asOfDate: latestDate, longHistory: !!long }) };
  } catch (err) {
    console.error(`scheduled-international-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
