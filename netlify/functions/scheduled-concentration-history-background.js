// Builds the long-history concentration series for concentration.html
// (charts G and H) and writes it to Netlify Blobs for
// concentration-history.js to serve.
//
//   G — quarterly, 2000 to present: the 10 largest S&P 500 companies at
//       each quarter-end (whoever they were then) as a share of the
//       index's total market capitalization.
//   H — annual, 2000 to present: each calendar year's S&P 500 total
//       return split into the contribution from that year's 10 largest
//       companies (by start-of-year weight) and the contribution from
//       everyone else.
//
// Data:
//   - Per-company historical market caps and the annual year-end S&P 500
//     aggregate market cap are frozen in concentration-static-data.js
//     (companiesmarketcap.com + finhacker.cz — see that file). Quarter-end
//     index totals are interpolated between the annual anchors by the SPY
//     price level.
//   - Per-company and index total returns for chart H come live from
//     Alpha Vantage (split/dividend-adjusted monthly closes).

const { getConcentrationStore } = require("./concentration-blob-store");
const { recordAvCall } = require("./av-call-counter");
const { SP500_TOTAL_ANNUAL, MEMBERSHIP_START, MCAP_HISTORY } = require("./concentration-static-data");

const HISTORY_BLOB_KEY = "history.json";
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Alpha Vantage symbol overrides (class shares etc.).
const AV_SYMBOL = { BRK: "BRK-B" };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchMonthlyAdj(apiKey, ticker) {
  const sym = AV_SYMBOL[ticker] || ticker;
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${sym}&apikey=${apiKey}`,
    { headers: { "User-Agent": UA } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${sym}`);
  const payload = await res.json();
  const series = payload["Monthly Adjusted Time Series"];
  if (!series) {
    throw new Error(
      `MONTHLY_ADJUSTED missing for ${sym}: ` +
        (payload.Note || payload.Information || payload.error_message || JSON.stringify(payload).slice(0, 140))
    );
  }
  // month "YYYY-MM" -> { close, adj }
  const out = new Map();
  for (const [date, row] of Object.entries(series)) {
    out.set(date.slice(0, 7), {
      close: parseFloat(row["4. close"]),
      adj: parseFloat(row["5. adjusted close"]),
    });
  }
  return out;
}

// last market-cap point at or before month `ym` ("YYYY-MM")
function mcapAsOf(ticker, ym) {
  const arr = MCAP_HISTORY[ticker];
  if (!arr) return null;
  let v = null;
  for (const [unix, val] of arr) {
    const key = new Date(unix * 1000).toISOString().slice(0, 7);
    if (key <= ym) v = val;
    else break;
  }
  return v;
}

function isMember(ticker, ym) {
  const start = MEMBERSHIP_START[ticker];
  return !start || ym >= start;
}

// quarter-ends we report
function quarterEnds(firstYear, lastYm) {
  const out = [];
  for (let y = firstYear; y <= parseInt(lastYm.slice(0, 4), 10); y++) {
    for (const m of ["03", "06", "09", "12"]) {
      const ym = `${y}-${m}`;
      if (ym <= lastYm) out.push(ym);
    }
  }
  return out;
}

exports.handler = async () => {
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const tickers = Object.keys(MCAP_HISTORY);

    // ---- Alpha Vantage: SPY + every candidate name ------------------
    const spy = await fetchMonthlyAdj(apiKey, "SPY");
    await sleep(800);
    const adj = {};
    const failed = [];
    for (const t of tickers) {
      try { adj[t] = await fetchMonthlyAdj(apiKey, t); }
      catch (e) { console.error(`concentration-history: ${t} AV failed: ${e.message}`); failed.push(t); }
      await sleep(800);
    }
    for (const t of failed) {
      try { adj[t] = await fetchMonthlyAdj(apiKey, t); await sleep(800); }
      catch (e) { console.error(`concentration-history: ${t} AV failed on retry: ${e.message}`); }
    }

    const spyClose = (ym) => (spy.get(ym) ? spy.get(ym).close : null);
    const anchorByYear = new Map(SP500_TOTAL_ANNUAL);
    const anchorYears = SP500_TOTAL_ANNUAL.map((r) => r[0]);
    const lastAnchorYear = anchorYears[anchorYears.length - 1];

    // quarter-end total S&P 500 market cap, interpolated between annual
    // year-end anchors by the SPY price move within the year.
    function sp500Total(ym) {
      const y = parseInt(ym.slice(0, 4), 10);
      const decPrev = `${y - 1}-12`, decThis = `${y}-12`;
      if (y > lastAnchorYear) {
        const base = anchorByYear.get(lastAnchorYear);
        const p0 = spyClose(`${lastAnchorYear}-12`), p1 = spyClose(ym);
        return p0 && p1 ? base * (p1 / p0) : base;
      }
      const aPrev = anchorByYear.get(y - 1);
      const aThis = anchorByYear.get(y);
      if (aPrev == null || aThis == null) return aThis ?? aPrev ?? null;
      const p0 = spyClose(decPrev), p1 = spyClose(decThis), pn = spyClose(ym);
      if (!p0 || !p1 || !pn || p1 === p0) return (aPrev + aThis) / 2;
      let f = (pn - p0) / (p1 - p0);
      f = Math.max(-0.5, Math.min(1.5, f));
      return aPrev + f * (aThis - aPrev);
    }

    // latest complete month across SPY
    const spyMonths = [...spy.keys()].sort();
    const lastYm = spyMonths[spyMonths.length - 1];

    // ---- G: quarterly top-10 share ---------------------------------
    const quarterly = [];
    for (const ym of quarterEnds(2000, lastYm)) {
      const ranked = tickers
        .filter((t) => isMember(t, ym))
        .map((t) => [t, mcapAsOf(t, ym)])
        .filter(([, v]) => v && v > 0)
        .sort((a, b) => b[1] - a[1]);
      if (ranked.length < 10) continue;
      const total = sp500Total(ym);
      if (!total) continue;
      const top10 = ranked.slice(0, 10);
      const top10Sum = top10.reduce((s, r) => s + r[1], 0);
      const top3Sum = top10.slice(0, 3).reduce((s, r) => s + r[1], 0);
      quarterly.push({
        date: ym,
        sp500_total: Math.round(total / 1e9),           // $B
        top10_share: Math.round((top10Sum / total) * 1e4) / 100,  // %
        top3_share: Math.round((top3Sum / total) * 1e4) / 100,
        top10: top10.map(([t, v]) => ({ t, mcap: Math.round(v / 1e9) })),
      });
    }

    // ---- H: annual return contribution ----------------------------
    const annual = [];
    const firstH = 2000;
    const lastCompleteYear =
      lastYm.slice(5) === "12" ? parseInt(lastYm.slice(0, 4), 10) : parseInt(lastYm.slice(0, 4), 10) - 1;
    for (let y = firstH; y <= lastCompleteYear; y++) {
      const decPrev = `${y - 1}-12`, decThis = `${y}-12`;
      const totalPrev = sp500Total(decPrev);
      if (!totalPrev) continue;
      const spyPrev = spy.get(decPrev), spyThis = spy.get(decThis);
      if (!spyPrev || !spyThis) continue;
      const sp500TR = spyThis.adj / spyPrev.adj - 1;

      const ranked = tickers
        .filter((t) => isMember(t, decPrev))
        .map((t) => [t, mcapAsOf(t, decPrev)])
        .filter(([, v]) => v && v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      const perName = [];
      let contribSum = 0;
      for (const [t, mc] of ranked) {
        const a0 = adj[t] && adj[t].get(decPrev);
        const a1 = adj[t] && adj[t].get(decThis);
        if (!a0 || !a1) continue;
        const w = mc / totalPrev;
        const r = a1.adj / a0.adj - 1;
        const c = w * r;
        contribSum += c;
        perName.push({ t, w: Math.round(w * 1e4) / 100, r: Math.round(r * 1e3) / 10, c: Math.round(c * 1e4) / 100 });
      }
      annual.push({
        year: y,
        sp500_tr: Math.round(sp500TR * 1e3) / 10,
        top10_contrib: Math.round(contribSum * 1e3) / 10,
        rest_contrib: Math.round((sp500TR - contribSum) * 1e3) / 10,
        names: perName,
      });
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      note:
        "Quarter-end top-10 = the 10 largest members at that date, by market cap (companiesmarketcap.com), " +
        "over total S&P 500 market cap (finhacker.cz annual anchors, SPY-interpolated to quarter-ends). " +
        "Chart H uses Alpha Vantage adjusted monthly closes for total returns.",
      quarterly,
      annual,
    };

    const store = getConcentrationStore();
    await store.setJSON(HISTORY_BLOB_KEY, payload);
    console.log(`concentration-history: wrote ${quarterly.length} quarters, ${annual.length} years`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, quarters: quarterly.length, years: annual.length }) };
  } catch (err) {
    console.error(`concentration-history: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
