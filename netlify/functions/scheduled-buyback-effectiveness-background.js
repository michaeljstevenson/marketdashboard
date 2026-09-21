// Scheduled Background Function (see [functions."scheduled-buyback-
// effectiveness-background"] in netlify.toml) that sweeps Alpha Vantage's
// CASH_FLOW endpoint (quarterly) across the full S&P 500 for the backlog's
// "Buyback Announcements" idea — built here as actual trailing-12-month
// buyback dollar spend, not forward-looking announcements (no free,
// maintained ticker-level dataset of announced buyback programs was found;
// see ROUTINE_BRIEF.md's "Already attempted, skipped" history for the two
// prior sessions' dead-end searches, including this one's own confirmation
// that this sandbox's network egress still blocks SEC EDGAR and every other
// non-Alpha-Vantage domain it tried).
//
// The real find this session made: Alpha Vantage's CASH_FLOW endpoint
// already carries dollar buyback spend, just not under an obviously-named
// field. Every mega-cap checked during design (AAPL, MSFT) reports "None"
// for paymentsForRepurchaseOfCommonStock/paymentsForRepurchaseOfEquity but
// a populated proceedsFromRepurchaseOfEquity — negative when cash went OUT
// for repurchases, positive when net share-issuance proceeds (ATM equity
// programs, common at REITs like O) exceeded any repurchases that quarter.
// See buybackSpendOf() below for how that sign convention is turned into a
// clean, always-non-negative "buyback spend" figure, and the page's own
// methodology blurb for the same explanation in plain language.
//
// This page's actual contribution, distinct from the already-shipped
// Share Count Trends (net share COUNT change only, nets out every buyback,
// issuance, and SBC grant into one number) and Shareholder Yield (buyback
// YIELD derived FROM that same share-count change, never real cash spend):
// real dollar buyback spend, plus how much of it actually shows up as a
// smaller share count vs. gets offset by stock-based-comp dilution. Reuses
// Share Count Trends' own trailing-12-month change1Y (via its Netlify Blobs
// store, same cross-page reuse pattern as scheduled-shareholder-yield-
// background.js) rather than re-deriving it from a second BALANCE_SHEET
// sweep.
//
// Also reuses the Fed-funds regime classification (identical thresholds
// and trailing-3-month-change construction as buildMonthly() in
// /small-cap-vs-large-cap.html) to test whether buyback intensity actually
// pulls back when rates rise — same construction as
// scheduled-margin-leverage-background.js.
//
// One-time snapshot, no recurring schedule — matches the convention this
// site settled into for every page added since 2026-09-16 (see this
// function's own entry in netlify.toml). ~503 sequential CASH_FLOW calls
// at 1050ms spacing plus a retry pass, plus one FEDERAL_FUNDS_RATE call —
// the same pacing already proven safe at this exact universe size by
// scheduled-share-count-background.js's BALANCE_SHEET sweep.

const { getBuybackEffectivenessStore, BLOB_KEY } = require("./buyback-effectiveness-blob-store");
const { getShareCountStore, BLOB_KEY: SHARE_COUNT_KEY } = require("./share-count-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_NEEDED = 24; // ~6 years — TTM needs the first 4; the rest feed the quarterly market-intensity/regime series
const NOTABLE_COUNT = 15;
const MIN_QUARTER_N = 40; // don't publish a market-quarter median built off fewer than this many companies
const MIN_YIELD_FOR_OFFSET = 0.1; // % of market cap — below this, dividing by a near-zero dollar yield produces noise, not signal

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on this endpoint — same gotcha guarded against elsewhere
// in this codebase (e.g. scheduled-margin-leverage-background.js's num()).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// See the file header for the field-by-field reasoning. Always returns a
// non-negative "cash spent on repurchases this quarter" figure, or null if
// the quarter's cash flow statement carries none of the three candidate
// fields at all (a genuine data gap, not a real zero — left out of TTM
// sums rather than treated as $0).
function buybackSpendOf(row) {
  const p = num(row.proceedsFromRepurchaseOfEquity);
  if (p !== null) return p < 0 ? -p : 0; // positive = net issuer that quarter (e.g. a REIT ATM program), not a negative buyback
  const a = num(row.paymentsForRepurchaseOfCommonStock);
  if (a !== null) return Math.abs(a);
  const b = num(row.paymentsForRepurchaseOfEquity);
  if (b !== null) return Math.abs(b);
  return null;
}

function calendarQuarterKey(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

async function fetchQuarterlyCashFlow(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=CASH_FLOW&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 160)}`);

  // Alpha Vantage returns quarterlyReports most-recent-first already.
  return rows.slice(0, QUARTERS_NEEDED).map((r) => ({
    fiscalDateEnding: r.fiscalDateEnding,
    buybackSpend: buybackSpendOf(r),
    operatingCashflow: num(r.operatingCashflow),
  }));
}

exports.handler = async () => {
  console.log(`scheduled-buyback-effectiveness-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const [beeswarmMeta, shareCountData] = await Promise.all([
      getBeeswarmStore().get(META_KEY, { type: "json" }),
      getShareCountStore().get(SHARE_COUNT_KEY, { type: "json" }),
    ]);
    const metaTickers = (beeswarmMeta && beeswarmMeta.tickers) || {};
    if (!shareCountData || !Array.isArray(shareCountData.companies)) {
      throw new Error("share-count-trends data not available yet, scheduled-share-count-background must run first");
    }
    const netBuybackYieldByTicker = new Map(
      shareCountData.companies
        .filter((c) => c.change1Y !== null && c.change1Y !== undefined)
        .map((c) => [c.symbol, -c.change1Y]) // same convention as scheduled-shareholder-yield-background.js
    );

    // Fed funds regime classification — identical construction to
    // scheduled-margin-leverage-background.js (see that file's own comment
    // for why: same thresholds and trailing-3-month-change as
    // buildMonthly() in /small-cap-vs-large-cap.html).
    await recordAvCall();
    const fedRes = await fetch(`${ALPHA_VANTAGE_URL}?function=FEDERAL_FUNDS_RATE&interval=monthly&apikey=${apiKey}`, { headers: { "User-Agent": USER_AGENT } });
    if (!fedRes.ok) throw new Error(`FEDERAL_FUNDS_RATE HTTP ${fedRes.status}`);
    const fedPayload = await fedRes.json();
    if (!Array.isArray(fedPayload.data)) throw new Error(`FEDERAL_FUNDS_RATE missing data array: ${JSON.stringify(fedPayload).slice(0, 160)}`);
    const fedRows = fedPayload.data
      .map((r) => ({ date: r.date, value: parseFloat(r.value) }))
      .filter((r) => Number.isFinite(r.value))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const regimeByMonth = new Map();
    for (let i = 3; i < fedRows.length; i++) {
      const ym = fedRows[i].date.slice(0, 7);
      const change = round(fedRows[i].value - fedRows[i - 3].value, 3);
      const regime = change > 0.1 ? "Hiking" : change < -0.1 ? "Cutting" : "Holding";
      regimeByMonth.set(ym, { regime, change });
    }
    function prevMonthKey(ym) {
      let [y, m] = ym.split("-").map(Number);
      m -= 1;
      if (m < 1) { m = 12; y -= 1; }
      return `${y}-${String(m).padStart(2, "0")}`;
    }
    function regimeForQuarterKey(qk) {
      const [y, q] = qk.split("-Q").map(Number);
      const month = q * 3;
      const ym = `${y}-${String(month).padStart(2, "0")}`;
      return regimeByMonth.get(ym) || regimeByMonth.get(prevMonthKey(ym)) || null;
    }

    const results = new Map();

    async function fetchInto(symbol) {
      try {
        const quarters = await fetchQuarterlyCashFlow(apiKey, symbol);
        if (quarters.length >= 4) results.set(symbol, quarters);
        return true;
      } catch (err) {
        console.error(`scheduled-buyback-effectiveness-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-buyback-effectiveness-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(1050);
      }
      todo = missed;
    }

    console.log(`scheduled-buyback-effectiveness-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed. Refusing to write an empty snapshot");

    const companies = [];
    const allQuarterKeys = new Set();
    for (const [symbol, quarters] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      for (const q of quarters) allQuarterKeys.add(calendarQuarterKey(q.fiscalDateEnding));

      const last4 = quarters.slice(0, 4);
      const ttmBuybackSpend = last4.every((q) => q.buybackSpend !== null)
        ? last4.reduce((s, q) => s + q.buybackSpend, 0)
        : null;
      const ttmOperatingCashflow = last4.every((q) => q.operatingCashflow !== null)
        ? last4.reduce((s, q) => s + q.operatingCashflow, 0)
        : null;

      const buybackIntensity = ttmBuybackSpend !== null && ttmOperatingCashflow !== null && ttmOperatingCashflow > 0
        ? round((ttmBuybackSpend / ttmOperatingCashflow) * 100)
        : null;
      const marketCap = m.marketCap;
      const dollarBuybackYield = ttmBuybackSpend !== null && marketCap && marketCap > 0
        ? round((ttmBuybackSpend / marketCap) * 100, 3)
        : null;
      const netBuybackYield = netBuybackYieldByTicker.has(symbol) ? round(netBuybackYieldByTicker.get(symbol), 3) : null;
      const dilutionOffsetPct = dollarBuybackYield !== null && dollarBuybackYield >= MIN_YIELD_FOR_OFFSET && netBuybackYield !== null
        ? round((1 - netBuybackYield / dollarBuybackYield) * 100, 1)
        : null;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        quarters, // kept for the market-quarterly aggregation below, stripped before writing the payload
        ttmBuybackSpend: ttmBuybackSpend !== null ? Math.round(ttmBuybackSpend) : null,
        ttmOperatingCashflow: ttmOperatingCashflow !== null ? Math.round(ttmOperatingCashflow) : null,
        buybackIntensity,
        marketCap,
        dollarBuybackYield,
        netBuybackYield,
        dilutionOffsetPct,
      });
    }

    if (!companies.length) throw new Error("No tickers resolved with both CASH_FLOW history and sector metadata");

    // ---- Market + sector aggregates (TTM snapshot) ----
    const market = {
      companyCount: companies.length,
      totalTtmBuybackSpend: companies.reduce((s, c) => s + (c.ttmBuybackSpend || 0), 0),
      avgBuybackIntensity: round(mean(companies.map((c) => c.buybackIntensity))),
      avgDollarBuybackYield: round(mean(companies.map((c) => c.dollarBuybackYield)), 3),
      medianDilutionOffsetPct: round(median(companies.map((c) => c.dilutionOffsetPct)), 1),
    };

    const sectors = SECTOR_ORDER.map((sector) => {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) return null;
      return {
        sector,
        count: inSector.length,
        totalTtmBuybackSpend: inSector.reduce((s, c) => s + (c.ttmBuybackSpend || 0), 0),
        avgBuybackIntensity: round(mean(inSector.map((c) => c.buybackIntensity))),
        avgDollarBuybackYield: round(mean(inSector.map((c) => c.dollarBuybackYield)), 3),
      };
    }).filter(Boolean);

    // ---- Cross-sectional dilution-offset test: does dollar buyback yield
    // actually predict net share-count reduction? Pearson+Spearman,
    // computed client-side from these raw pairs (same convention as
    // /factor-analysis and every other page this codebase has built). ----
    const scatter = companies
      .filter((c) => c.dollarBuybackYield !== null && c.dollarBuybackYield >= MIN_YIELD_FOR_OFFSET && c.netBuybackYield !== null)
      .map((c) => ({ symbol: c.symbol, sector: c.sector, dollarBuybackYield: c.dollarBuybackYield, netBuybackYield: c.netBuybackYield }));

    // ---- Market-level quarterly buyback intensity vs. Fed-funds regime ----
    // One point per calendar quarter (cross-company median of that
    // quarter's own buybackSpend/operatingCashflow), not one point per
    // company-quarter — a raw per-company panel would pseudo-replicate the
    // same macro quarter ~500 times and mechanically inflate significance,
    // same reasoning as scheduled-margin-leverage-background.js.
    const quarters = [...allQuarterKeys].sort();
    const intensityByQuarter = new Map();
    for (const c of companies) {
      for (const q of c.quarters) {
        if (q.buybackSpend === null || q.operatingCashflow === null || q.operatingCashflow <= 0) continue;
        const qk = calendarQuarterKey(q.fiscalDateEnding);
        const arr = intensityByQuarter.get(qk) || [];
        arr.push((q.buybackSpend / q.operatingCashflow) * 100);
        intensityByQuarter.set(qk, arr);
      }
    }
    const marketQuarterly = quarters
      .map((qk) => {
        const arr = intensityByQuarter.get(qk) || [];
        const regimeInfo = regimeForQuarterKey(qk);
        return {
          quarter: qk,
          regime: regimeInfo ? regimeInfo.regime : null,
          fedFundsChange3m: regimeInfo ? regimeInfo.change : null,
          medianBuybackIntensity: arr.length >= MIN_QUARTER_N ? round(median(arr)) : null,
          n: arr.length,
        };
      })
      .filter((r) => r.regime !== null && r.medianBuybackIntensity !== null);

    // ---- Leaderboards ----
    const spenderRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, ttmBuybackSpend: c.ttmBuybackSpend, dollarBuybackYield: c.dollarBuybackYield });
    const topSpenders = [...companies].filter((c) => c.ttmBuybackSpend !== null).sort((a, b) => b.ttmBuybackSpend - a.ttmBuybackSpend).slice(0, NOTABLE_COUNT).map(spenderRow);

    const intensityRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, buybackIntensity: c.buybackIntensity, ttmBuybackSpend: c.ttmBuybackSpend });
    const topIntensity = [...companies].filter((c) => c.buybackIntensity !== null).sort((a, b) => b.buybackIntensity - a.buybackIntensity).slice(0, NOTABLE_COUNT).map(intensityRow);

    const offsetRow = (c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, dollarBuybackYield: c.dollarBuybackYield, netBuybackYield: c.netBuybackYield, dilutionOffsetPct: c.dilutionOffsetPct });
    const withOffset = companies.filter((c) => c.dilutionOffsetPct !== null);
    const mostDiluted = [...withOffset].sort((a, b) => b.dilutionOffsetPct - a.dilutionOffsetPct).slice(0, NOTABLE_COUNT).map(offsetRow);
    const leastDiluted = [...withOffset].sort((a, b) => a.dilutionOffsetPct - b.dilutionOffsetPct).slice(0, NOTABLE_COUNT).map(offsetRow);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      market,
      sectors,
      scatter,
      marketQuarterly,
      topSpenders,
      topIntensity,
      mostDiluted,
      leastDiluted,
      companies: companies.map((c) => ({
        symbol: c.symbol, name: c.name, sector: c.sector,
        ttmBuybackSpend: c.ttmBuybackSpend, buybackIntensity: c.buybackIntensity,
        dollarBuybackYield: c.dollarBuybackYield, netBuybackYield: c.netBuybackYield,
        dilutionOffsetPct: c.dilutionOffsetPct,
      })),
    };

    await getBuybackEffectivenessStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-buyback-effectiveness-background: wrote ${companies.length} companies across ${sectors.length} sectors, ${marketQuarterly.length} market-quarters`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-buyback-effectiveness-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
