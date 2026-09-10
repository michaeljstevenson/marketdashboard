// Builds the "Magnificent Seven" concentration series for
// concentration.html (charts C and F) and writes it to Netlify Blobs for
// concentration-mag7.js to serve.
//
// What it computes, monthly from year-end 2014:
//   - mag7      : cap-weighted basket of AAPL MSFT GOOGL AMZN NVDA META
//                 TSLA, rebalanced to market-cap weights each quarter-end,
//                 total-return basis, indexed to 100 at 2014-12-31.
//   - sp500     : S&P 500 total return (SPY adjusted close), indexed to 100.
//   - weights   : the seven's basket weights at the latest rebalance.
//
// The S&P 493 line (index ex-those-seven) is intentionally NOT computed
// here — it needs the seven's *index* weight, i.e. a total-S&P-500
// market-cap series, which no free feed provides. That line is added
// separately once that series exists.
//
// Market-cap weights use the UNADJUSTED close ("4. close") times the
// point-in-time share count from SEC filings; total-return math uses the
// split/dividend-ADJUSTED close ("5. adjusted close"). Mixing an adjusted
// price with a then-actual share count would misstate every historical
// market cap by the cumulative split factor (e.g. 28x for pre-2014 AAPL).
//
// Named "-background" so Netlify runs it as a Background Function; it's
// only ~8 Alpha Vantage + ~7 SEC calls so it's quick, but keeping it off
// the request path matches the other data feeds on this site.

const { getConcentrationStore, BLOB_KEY } = require("./concentration-blob-store");
const { recordAvCall } = require("./av-call-counter");
const { SP500_TOTAL_ANNUAL } = require("./concentration-static-data");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SEC_UA = "market-dashboard research contact michaelj.stevenson@outlook.com";

const BASE_DATE = "2014-12-01"; // first monthly bar we keep (Dec-2014 close = index 100)

// dei:EntityCommonStockSharesOutstanding is the cover-page share count and
// works cleanly for most. Alphabet only tags it under us-gaap; Meta
// doesn't XBRL-tag a period-end share count at all, so we fall back to its
// basic weighted-average share count (within ~1% of period-end — fine for
// cap weighting).
const MAG7 = [
  { sym: "AAPL",  cik: "0000320193", concept: "dei/EntityCommonStockSharesOutstanding" },
  { sym: "MSFT",  cik: "0000789019", concept: "dei/EntityCommonStockSharesOutstanding" },
  { sym: "GOOGL", cik: "0001652044", concept: "us-gaap/CommonStockSharesOutstanding" },
  { sym: "AMZN",  cik: "0001018724", concept: "dei/EntityCommonStockSharesOutstanding" },
  { sym: "NVDA",  cik: "0001045810", concept: "dei/EntityCommonStockSharesOutstanding" },
  { sym: "META",  cik: "0001326801", concept: "us-gaap/WeightedAverageNumberOfSharesOutstandingBasic" },
  { sym: "TSLA",  cik: "0001318605", concept: "dei/EntityCommonStockSharesOutstanding" },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchMonthly(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": UA } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  const payload = await res.json();
  const series = payload["Monthly Adjusted Time Series"];
  if (!series) {
    throw new Error(
      `Alpha Vantage MONTHLY_ADJUSTED missing data for ${symbol}: ` +
        (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 160))
    );
  }
  // date -> { close (unadjusted), adj (adjusted) }
  const out = new Map();
  for (const [date, row] of Object.entries(series)) {
    const close = parseFloat(row["4. close"]);
    const adj = parseFloat(row["5. adjusted close"]);
    if (Number.isFinite(close) && Number.isFinite(adj)) out.set(date, { close, adj });
  }
  return out;
}

async function fetchShares(cik, concept) {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${concept}.json`;
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA, "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error(`SEC HTTP ${res.status} for ${cik}/${concept}`);
  const payload = await res.json();
  const arr = (payload.units && payload.units.shares) || [];
  // One value per period end. Prefer rows carrying a `frame` (SEC's
  // deduplicated set); collapse to the largest value seen for each end
  // date (identical filings sometimes repeat; different-class rows for
  // Alphabet report the same total).
  const byEnd = new Map();
  for (const row of arr) {
    if (!row.end || !Number.isFinite(row.val)) continue;
    const prev = byEnd.get(row.end);
    if (prev === undefined || row.val > prev) byEnd.set(row.end, row.val);
  }
  return [...byEnd.entries()]
    .map(([end, val]) => ({ end, val }))
    .sort((a, b) => (a.end < b.end ? -1 : 1));
}

function sharesAsOf(sharesList, date) {
  let val = null;
  for (const s of sharesList) {
    if (s.end <= date) val = s.val;
    else break;
  }
  return val;
}

function isQuarterEndMonth(dateStr) {
  const m = parseInt(dateStr.slice(5, 7), 10);
  return m === 3 || m === 6 || m === 9 || m === 12;
}

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    // ---- fetch prices (7 names + SPY) --------------------------------
    const prices = {};
    for (const { sym } of MAG7) {
      prices[sym] = await fetchMonthly(apiKey, sym);
      await sleep(800);
    }
    prices.SPY = await fetchMonthly(apiKey, "SPY");
    await sleep(300);

    // ---- fetch share counts -----------------------------------------
    const shares = {};
    for (const { sym, cik, concept } of MAG7) {
      shares[sym] = await fetchShares(cik, concept);
      await sleep(250);
    }

    // ---- month grid: month-ends present for SPY and all 7, >= base ---
    let months = [...prices.SPY.keys()].filter((d) => d >= BASE_DATE);
    for (const { sym } of MAG7) {
      const have = prices[sym];
      months = months.filter((d) => have.has(d));
    }
    months.sort();
    if (months.length < 12) throw new Error(`only ${months.length} common monthly bars`);

    const baseMonth = months[0];

    // Quarter-end total S&P 500 market cap: interpolate between annual
    // year-end anchors (finhacker.cz) by the SPY price move within the
    // year. Used only for the seven's index weight (the S&P 493 line).
    const anchorByYear = new Map(SP500_TOTAL_ANNUAL);
    const lastAnchorYear = SP500_TOTAL_ANNUAL[SP500_TOTAL_ANNUAL.length - 1][0];
    const spyCloseAt = (ym) => {
      // `months` are "YYYY-MM-DD"; find the bar in that calendar month.
      const hit = months.find((d) => d.slice(0, 7) === ym);
      return hit ? prices.SPY.get(hit).close : null;
    };
    function sp500TotalAsOf(dateStr) {
      const y = parseInt(dateStr.slice(0, 4), 10);
      const pn = prices.SPY.get(dateStr).close;
      if (y > lastAnchorYear) {
        const base = anchorByYear.get(lastAnchorYear);
        const p0 = spyCloseAt(`${lastAnchorYear}-12`);
        return p0 && pn ? base * (pn / p0) : base;
      }
      const aPrev = anchorByYear.get(y - 1);
      const aThis = anchorByYear.get(y);
      if (aPrev == null || aThis == null) return aThis ?? aPrev ?? null;
      const p0 = spyCloseAt(`${y - 1}-12`);
      const p1 = spyCloseAt(`${y}-12`);
      if (!p0 || !p1 || !pn || p1 === p0) return (aPrev + aThis) / 2;
      let f = (pn - p0) / (p1 - p0);
      f = Math.max(-0.5, Math.min(1.5, f));
      return aPrev + f * (aThis - aPrev);
    }

    // ---- cap-weighted basket, quarterly rebalance --------------------
    // Between rebalances, basket value = baseValue * Σ w_i * adj_i(t)/adj_i(R).
    let basketLevel = 100;
    let rebalW = null;      // { sym: weight } fixed at last rebalance
    let rebalAdj = null;    // { sym: adjClose at last rebalance }
    let lastWeights = null;
    let w7 = null;          // the seven's combined S&P 500 weight, fixed at last rebalance

    const spyBaseAdj = prices.SPY.get(baseMonth).adj;

    const rows = [];
    let prevMag7 = null;
    let prevSpyAdj = null;
    let sp493Level = 100;

    const setRebalance = (date) => {
      const mcap = {};
      let mcapSum = 0;
      for (const { sym } of MAG7) {
        const sh = sharesAsOf(shares[sym], date);
        const m = sh ? prices[sym].get(date).close * sh : 0;
        mcap[sym] = m;
        mcapSum += m;
      }
      rebalW = {};
      rebalAdj = {};
      for (const { sym } of MAG7) {
        rebalW[sym] = mcapSum ? mcap[sym] / mcapSum : 1 / MAG7.length;
        rebalAdj[sym] = prices[sym].get(date).adj;
      }
      lastWeights = { asOf: date, weights: { ...rebalW } };
      const total = sp500TotalAsOf(date);
      w7 = total ? Math.min(0.6, mcapSum / total) : w7;
    };

    months.forEach((date, i) => {
      const spyAdj = prices.SPY.get(date).adj;
      let mag7;
      if (i === 0) {
        mag7 = 100;
        basketLevel = 100;
        setRebalance(date); // weights effective for the next bar onward
      } else {
        // This month's move uses the weights fixed at the last rebalance.
        let factor = 0;
        for (const { sym } of MAG7) {
          factor += rebalW[sym] * (prices[sym].get(date).adj / rebalAdj[sym]);
        }
        mag7 = basketLevel * factor;

        // S&P 493 = index return stripped of the seven's contribution:
        //   r493 = (r500 - w7 * r7) / (1 - w7)
        const r500 = spyAdj / prevSpyAdj - 1;
        const r7 = mag7 / prevMag7 - 1;
        const r493 = w7 != null && w7 < 0.999 ? (r500 - w7 * r7) / (1 - w7) : r500;
        sp493Level *= 1 + r493;

        // Quarter-end: re-weight to current market caps for the next quarter.
        if (isQuarterEndMonth(date)) {
          basketLevel = mag7;
          setRebalance(date);
        }
      }

      const sp500 = 100 * spyAdj / spyBaseAdj;
      rows.push({
        date,
        mag7: Math.round(mag7 * 1e4) / 1e4,
        sp500: Math.round(sp500 * 1e4) / 1e4,
        sp493: Math.round(sp493Level * 1e4) / 1e4,
        mag7RetMoM: prevMag7 ? Math.round((mag7 / prevMag7 - 1) * 1e6) / 1e6 : null,
      });
      prevMag7 = mag7;
      prevSpyAdj = spyAdj;
    });

    const payload = {
      generated_at_utc: new Date().toISOString(),
      base_date: baseMonth,
      note:
        "Cap-weighted Magnificent Seven basket (quarterly rebalance, total return) vs S&P 500 total return (SPY) " +
        "and vs S&P 493 (index return with the seven's contribution removed), indexed to 100 at the base date. " +
        "Basket weights from unadjusted close x SEC-filing share counts; the seven's index weight uses the " +
        "interpolated S&P 500 total market cap (finhacker.cz annual anchors).",
      constituents: MAG7.map((m) => m.sym),
      latest_weights: lastWeights,
      rows,
    };

    const store = getConcentrationStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-concentration-background: wrote ${rows.length} monthly rows`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, rows: rows.length }) };
  } catch (err) {
    console.error(`scheduled-concentration-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
