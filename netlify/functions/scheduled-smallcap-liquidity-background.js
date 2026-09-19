// Scheduled Background Function (see [functions."scheduled-smallcap-
// liquidity-background"] in netlify.toml) for the Small-Cap Liquidity &
// Volume Trends page. Tracks how trading depth / transaction-cost proxies
// differ between the smallest and largest members of the S&P 500, and
// whether that gap widens when small-caps are underperforming.
//
// Cohort definition: reads scheduled-beeswarm-meta-background.js's weekly
// meta.json (name/sector/sharesOutstanding/marketCap for every current
// S&P 500 constituent) rather than paying for a second OVERVIEW sweep,
// ranks by marketCap, and takes the bottom quintile (~100 smallest) as
// "Small-Cap" and top quintile (~100 largest) as "Mega-Cap". This is a
// market-cap-within-the-S&P-500 proxy, NOT true Russell 2000 small caps —
// see the page's methodology blurb, and the code comment on COHORT_FRACTION
// below.
//
// For each of the ~200 tickers, fetches Yahoo Finance's full daily OHLCV
// history and computes, per day: dollar volume, the Amihud
// (2002) illiquidity ratio, and the Corwin & Schultz (2012) high-low
// spread estimator, then a 21-trading-day rolling average of each. Cohort
// series (equal-weighted average across ~100 tickers/day) are what's
// stored as history — NOT per-ticker full history — to keep the blob
// small; a latest-day-only snapshot per ticker is kept separately for the
// full sortable table.
//
// ~200 sequential calls, ~300ms apart with a retry pass.

const { getSmallcapLiquidityStore, LATEST_KEY } = require("./smallcap-liquidity-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { fetchDailyBars } = require("./yahoo-client");


// Bottom/top 1/5 of the S&P 500 by market cap — ~100 names each out of
// ~503 constituents. Not a true small-cap universe (see file header).
const COHORT_FRACTION = 5;
const ROLLING_WINDOW = 21; // trading days
const TRADING_DAYS_KEPT = 504; // ~2 years, per the page spec
const AMIHUD_SCALE = 1e6; // for readability — raw Amihud values are tiny

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

async function fetchDailyAdjusted(symbol) {
  return fetchDailyBars(symbol);
}

// Amihud (2002) illiquidity ratio: |daily return| / dollar volume, scaled
// ×1e6 for readability. Corwin & Schultz (2012), "A Simple Way to Estimate
// Bid-Ask Spreads from Daily High and Low Prices" (Journal of Finance),
// two-consecutive-day high/low estimator — implemented exactly per the
// paper's formula. K = 3 - 2*sqrt(2) is the constant in both the alpha
// numerator's denominator and the gamma term.
const CS_K = 3 - 2 * Math.SQRT2;

function computeTickerSeries(raw) {
  const n = raw.length;
  const dollarVolume = new Array(n).fill(null);
  const dailyReturn = new Array(n).fill(null);
  const amihud = new Array(n).fill(null);
  const csSpread = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (Number.isFinite(raw[i].adjClose) && Number.isFinite(raw[i].volume)) {
      dollarVolume[i] = raw[i].adjClose * raw[i].volume;
    }
  }
  for (let i = 1; i < n; i++) {
    const prev = raw[i - 1].adjClose;
    if (Number.isFinite(prev) && prev > 0 && Number.isFinite(raw[i].adjClose)) {
      dailyReturn[i] = raw[i].adjClose / prev - 1;
    }
  }
  for (let i = 0; i < n; i++) {
    if (dailyReturn[i] !== null && dollarVolume[i] > 0) {
      amihud[i] = (Math.abs(dailyReturn[i]) / dollarVolume[i]) * AMIHUD_SCALE;
    }
  }
  for (let i = 1; i < n; i++) {
    const H0 = raw[i - 1].high, L0 = raw[i - 1].low, H1 = raw[i].high, L1 = raw[i].low;
    if (![H0, L0, H1, L1].every((v) => Number.isFinite(v) && v > 0) || H0 < L0 || H1 < L1) continue;
    const beta = Math.log(H0 / L0) ** 2 + Math.log(H1 / L1) ** 2;
    const gamma = Math.log(Math.max(H0, H1) / Math.min(L0, L1)) ** 2;
    const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / CS_K - Math.sqrt(gamma / CS_K);
    let spread = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
    // The estimator can return a negative "spread" (a known property of
    // Corwin-Schultz — it happens when the two-day combined range is
    // tighter than what the two single-day components alone would imply,
    // typically in very low-volatility stretches). A negative bid-ask
    // spread isn't economically meaningful, so clamp to 0 per the paper's
    // own convention.
    if (spread < 0) spread = 0;
    csSpread[i] = spread; // attributed to the second day of the (t, t+1) pair
  }

  return { dates: raw.map((r) => r.date), dollarVolume, amihud, csSpread };
}

function rollingAvg(arr, window) {
  const out = new Array(arr.length).fill(null);
  for (let i = window - 1; i < arr.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (arr[j] !== null && Number.isFinite(arr[j])) { sum += arr[j]; count++; }
    }
    if (count === window) out[i] = sum / count; // require a full, gap-free window
  }
  return out;
}

// Trims a ticker's series to its trailing ~TRADING_DAYS_KEPT days that
// have all three rolling metrics populated (i.e. skips the ~20-day
// rolling-average warm-up at the very start of the raw history).
function trimTickerSeries(computed) {
  const rollDV = rollingAvg(computed.dollarVolume, ROLLING_WINDOW);
  const rollAmihud = rollingAvg(computed.amihud, ROLLING_WINDOW);
  const rollCS = rollingAvg(computed.csSpread, ROLLING_WINDOW);

  const out = [];
  for (let i = computed.dates.length - 1; i >= 0 && out.length < TRADING_DAYS_KEPT; i--) {
    if (rollDV[i] === null || rollAmihud[i] === null || rollCS[i] === null) continue;
    out.push({ date: computed.dates[i], dv: rollDV[i], amihud: rollAmihud[i], cs: rollCS[i] });
  }
  out.reverse();
  return out;
}

exports.handler = async () => {
  console.log("scheduled-smallcap-liquidity-background: starting");
  try {

    const beeswarmStore = getBeeswarmStore();
    const meta = await beeswarmStore.get(META_KEY, { type: "json" });
    if (!meta || !meta.tickers) throw new Error("beeswarm meta.json not populated — scheduled-beeswarm-meta-background hasn't run yet");

    const validEntries = Object.entries(meta.tickers)
      .filter(([, m]) => m && Number.isFinite(m.marketCap) && m.marketCap > 0)
      .sort((a, b) => b[1].marketCap - a[1].marketCap); // descending by market cap

    if (validEntries.length < 50) throw new Error(`only ${validEntries.length} constituents have marketCap — meta.json looks incomplete`);

    const cohortSize = Math.round(validEntries.length / COHORT_FRACTION);
    const megaEntries = validEntries.slice(0, cohortSize);
    const smallEntries = validEntries.slice(-cohortSize);

    const cohortOf = new Map();
    for (const [symbol] of megaEntries) cohortOf.set(symbol, "mega");
    for (const [symbol] of smallEntries) cohortOf.set(symbol, "small");
    const universe = [...megaEntries, ...smallEntries].map(([symbol]) => symbol);

    console.log(`scheduled-smallcap-liquidity-background: ${universe.length} tickers (${megaEntries.length} mega, ${smallEntries.length} small)`);

    const tickerSeries = new Map(); // symbol -> trimmed series

    async function fetchInto(symbol) {
      try {
        const raw = await fetchDailyAdjusted(symbol);
        if (raw.length < ROLLING_WINDOW + 5) return false; // too little history to be useful
        const series = trimTickerSeries(computeTickerSeries(raw));
        if (!series.length) return false;
        tickerSeries.set(symbol, series);
        return true;
      } catch (err) {
        console.error(`scheduled-smallcap-liquidity-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...universe];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-smallcap-liquidity-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got && !tickerSeries.has(symbol)) missed.push(symbol);
        await sleep(300);
      }
      todo = missed;
    }

    console.log(`scheduled-smallcap-liquidity-background: fetched ${tickerSeries.size}/${universe.length} tickers`);
    const minPerCohort = Math.max(10, Math.floor(cohortSize / 4));
    const loadedSmall = [...tickerSeries.keys()].filter((s) => cohortOf.get(s) === "small").length;
    const loadedMega = [...tickerSeries.keys()].filter((s) => cohortOf.get(s) === "mega").length;
    if (loadedSmall < minPerCohort || loadedMega < minPerCohort) {
      throw new Error(`insufficient data — loaded ${loadedSmall} small / ${loadedMega} mega (need ${minPerCohort} each)`);
    }

    // Cohort-level aggregation: equal-weighted average across every ticker
    // in the cohort that has a value for that date. Uses the intersection
    // of dates present in BOTH cohorts (not just one ticker's calendar) so
    // the small/mega day-by-day arrays — and the ratio series derived from
    // them — line up with no gaps.
    const dateAgg = { small: new Map(), mega: new Map() }; // date -> {dvSum,aSum,csSum,count}
    for (const [symbol, series] of tickerSeries.entries()) {
      const cohort = cohortOf.get(symbol);
      const agg = dateAgg[cohort];
      for (const pt of series) {
        let bucket = agg.get(pt.date);
        if (!bucket) { bucket = { dvSum: 0, aSum: 0, csSum: 0, count: 0 }; agg.set(pt.date, bucket); }
        bucket.dvSum += pt.dv;
        bucket.aSum += pt.amihud;
        bucket.csSum += pt.cs;
        bucket.count++;
      }
    }

    const commonDates = [...dateAgg.small.keys()]
      .filter((d) => dateAgg.mega.has(d))
      .sort()
      .slice(-TRADING_DAYS_KEPT);

    function cohortSeries(cohort) {
      const dv = [], amihud = [], cs = [];
      for (const d of commonDates) {
        const b = dateAgg[cohort].get(d);
        dv.push(round(b.dvSum / b.count, 0));
        amihud.push(round(b.aSum / b.count, 4));
        cs.push(round(b.csSum / b.count, 5));
      }
      return { dates: commonDates, dollarVolume: dv, amihud, corwinSchultz: cs };
    }

    const smallSeries = cohortSeries("small");
    const megaSeries = cohortSeries("mega");
    const ratioValues = commonDates.map((_, i) =>
      megaSeries.amihud[i] > 0 ? round(smallSeries.amihud[i] / megaSeries.amihud[i], 3) : null
    );

    const lastIdx = commonDates.length - 1;
    const latest = {
      asOfDate: commonDates[lastIdx],
      small: { avgDollarVolume: smallSeries.dollarVolume[lastIdx], avgAmihud: smallSeries.amihud[lastIdx], avgCorwinSchultz: smallSeries.corwinSchultz[lastIdx] },
      mega: { avgDollarVolume: megaSeries.dollarVolume[lastIdx], avgAmihud: megaSeries.amihud[lastIdx], avgCorwinSchultz: megaSeries.corwinSchultz[lastIdx] },
      ratioAmihud: ratioValues[lastIdx],
    };

    const tickers = universe
      .filter((symbol) => tickerSeries.has(symbol))
      .map((symbol) => {
        const m = meta.tickers[symbol];
        const series = tickerSeries.get(symbol);
        const last = series[series.length - 1];
        return {
          symbol,
          name: m.name || symbol,
          sector: m.sector || null,
          cohort: cohortOf.get(symbol),
          marketCap: m.marketCap,
          dollarVolume: round(last.dv, 0),
          amihud: round(last.amihud, 4),
          corwinSchultz: round(last.cs, 5),
        };
      });

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: latest.asOfDate,
      universeSize: universe.length,
      loadedCount: tickerSeries.size,
      cohortSize,
      cohorts: { small: smallSeries, mega: megaSeries },
      ratioAmihud: { dates: commonDates, values: ratioValues },
      latest,
      tickers,
    };

    await getSmallcapLiquidityStore().setJSON(LATEST_KEY, payload);
    console.log(`scheduled-smallcap-liquidity-background: wrote ${tickers.length} tickers, ${commonDates.length} common trading days`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, tickers: tickers.length, days: commonDates.length }) };
  } catch (err) {
    console.error(`scheduled-smallcap-liquidity-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
