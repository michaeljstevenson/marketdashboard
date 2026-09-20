// Scheduled Background Function (see [functions."scheduled-margin-leverage-
// background"] in netlify.toml) that sweeps Alpha Vantage's INCOME_STATEMENT
// and BALANCE_SHEET endpoints (quarterly) across the full S&P 500 to track
// corporate margins (gross/operating/net) and balance-sheet leverage
// (net debt / trailing-twelve-month EBITDA) through the recent rate cycle,
// for the margin-leverage.html page.
//
// Two statements per company (~1006 calls total, roughly double the size of
// scheduled-share-count-background.js's single-statement sweep) — see
// CALL_SLEEP_MS below for the pacing tradeoff this forces within a
// Background Function's ~15-minute ceiling.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than paying
// for a third ~503-call sweep just for labels — same pattern as
// scheduled-revisions-background.js, scheduled-insider-transactions-
// background.js and scheduled-share-count-background.js.
//
// Weekly, not daily: fundamentals only change when a company files a new
// 10-Q/10-K, so a daily re-sweep would refetch ~1000 unchanged numbers 6
// days out of 7.

const { getMarginLeverageStore, BLOB_KEY, CHECKPOINT_KEY } = require("./margin-leverage-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const QUARTERS_NEEDED = 28; // ~7 years — covers the 2019 cuts, the 2020 emergency cuts, the 2022-23 hikes, and the 2024-25 cuts in one window
const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3; // don't publish a sector-quarter median built off fewer than this many companies
const MARGIN_TREND_THRESHOLD = 1.0; // ppt over 4 quarters — smaller moves are quarter-to-quarter noise, not a real trend

// Two calls per company (~1006 total) at 800ms would run ~13.4 minutes on
// its own, leaving little room for a retry pass inside a Background
// Function's ~15-minute ceiling. 750ms keeps the main pass under ~12.6
// minutes so a short retry pass for whatever fails still fits.
const CALL_SLEEP_MS = 750;

// The two-call sweep needs ~16 minutes once each call's own latency is
// counted, which is over the 15-minute ceiling, so a single run can't
// finish it. Each run stops fetching new tickers at RUN_BUDGET_MS, saves
// what it has to CHECKPOINT_KEY, and the next run picks up the rest; a run
// that finishes the whole universe marks the checkpoint complete so the
// following one starts a fresh cycle instead of reusing stale data.
const RUN_BUDGET_MS = 12 * 60 * 1000;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 120;

// Only the fields the merge below (quarterly) and
// scheduled-quality-financials-background.js (annual) read, so a full
// checkpoint stays small. Each statement call returns both report sets, so
// keeping the annual rows here means that job needs no calls of its own.
const KEEP_FIELDS = {
  INCOME_STATEMENT: ["fiscalDateEnding", "totalRevenue", "grossProfit", "operatingIncome", "netIncome", "ebitda", "depreciationAndAmortization"],
  BALANCE_SHEET: ["fiscalDateEnding", "shortLongTermDebtTotal", "shortTermDebt", "currentDebt", "longTermDebt", "longTermDebtNoncurrent", "cashAndCashEquivalentsAtCarryingValue", "cashAndShortTermInvestments"],
};
const KEEP_FIELDS_ANNUAL = {
  INCOME_STATEMENT: ["fiscalDateEnding", "totalRevenue", "grossProfit", "netIncome"],
  BALANCE_SHEET: ["fiscalDateEnding", "totalAssets", "totalCurrentAssets", "totalCurrentLiabilities", "longTermDebt", "longTermDebtNoncurrent", "commonStockSharesOutstanding"],
};
const ANNUAL_YEARS_NEEDED = 2; // fiscal year T and T-1
const pick = (rows, keys) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on several fundamentals endpoints — same gotcha already
// guarded against elsewhere in this codebase (e.g. scheduled-share-count-
// background.js's shares > 0 filter).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchStatement(apiKey, fn, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=${fn}&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  const rows = payload.quarterlyReports;
  if (!Array.isArray(rows)) throw new Error(`${fn} unexpected response shape for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  const annual = Array.isArray(payload.annualReports) ? payload.annualReports : [];
  return {
    quarterly: pick(rows.slice(0, QUARTERS_NEEDED), KEEP_FIELDS[fn]), // most-recent-first, same as BALANCE_SHEET elsewhere in this codebase
    annual: pick(annual.slice(0, ANNUAL_YEARS_NEEDED), KEEP_FIELDS_ANNUAL[fn]),
  };
}

// Total debt: Alpha Vantage's BALANCE_SHEET exposes a combined
// shortLongTermDebtTotal field on most tickers — prefer it directly rather
// than summing shortTermDebt + longTermDebt ourselves, since one or the
// other line is frequently "None" for companies that report a single
// blended debt figure (financials especially). Only fall back to the sum
// when the combined field itself is missing.
function totalDebtOf(bal) {
  const direct = num(bal.shortLongTermDebtTotal);
  if (direct !== null) return direct;
  const short = num(bal.shortTermDebt) ?? num(bal.currentDebt);
  const long = num(bal.longTermDebt) ?? num(bal.longTermDebtNoncurrent);
  if (short === null && long === null) return null;
  return (short || 0) + (long || 0);
}

function cashOf(bal) {
  return num(bal.cashAndCashEquivalentsAtCarryingValue) ?? num(bal.cashAndShortTermInvestments);
}

// EBITDA: Alpha Vantage's INCOME_STATEMENT carries a direct "ebitda" field
// for most tickers, but it comes back "None" often enough (smaller names,
// some financials) that it needs a fallback — operatingIncome +
// depreciationAndAmortization, both on the same INCOME_STATEMENT report
// (CASH_FLOW also carries D&A, but pulling a third statement per company
// would push this sweep to ~1500 calls; INCOME_STATEMENT's own D&A line is
// populated often enough that a third statement isn't worth the extra
// rate-limit exposure).
function ebitdaOf(inc) {
  const direct = num(inc.ebitda);
  if (direct !== null && direct !== 0) return direct;
  const opInc = num(inc.operatingIncome);
  const dna = num(inc.depreciationAndAmortization);
  if (opInc === null || dna === null) return null;
  return opInc + dna;
}

// Buckets a fiscal quarter-end date into the calendar quarter its month
// falls in. Companies with non-calendar fiscal years (e.g. a Jan 31
// quarter-end) land in whichever calendar quarter that date sits in, which
// can read one quarter off from that company's own internal numbering —
// noted in the page's methodology blurb. Fine in aggregate for a sector
// median; not meant to reproduce any single company's own fiscal calendar.
function calendarQuarterKey(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y}-Q${q}`;
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Merges one company's INCOME_STATEMENT and BALANCE_SHEET rows on
// fiscalDateEnding, computes per-quarter margins and net-debt, then a
// trailing-twelve-month EBITDA and net-debt/EBITDA ratio once 4 consecutive
// quarters of EBITDA are available. Returns quarters ascending (oldest
// first) so TTM and QoQ-delta math below can walk forward.
function buildCompanyQuarters(incomeRows, balanceRows) {
  const balByDate = new Map(balanceRows.map((r) => [r.fiscalDateEnding, r]));
  const levels = [];
  for (const inc of incomeRows) {
    const bal = balByDate.get(inc.fiscalDateEnding);
    if (!bal) continue;
    const totalRevenue = num(inc.totalRevenue);
    if (!totalRevenue || totalRevenue <= 0) continue; // margins are meaningless without positive revenue

    const grossProfit = num(inc.grossProfit);
    const operatingIncome = num(inc.operatingIncome);
    const netIncome = num(inc.netIncome);

    const totalDebt = totalDebtOf(bal);
    const cash = cashOf(bal);
    const netDebt = totalDebt !== null && cash !== null ? totalDebt - cash : null;
    const ebitda = ebitdaOf(inc);

    levels.push({
      q: inc.fiscalDateEnding,
      grossMargin: grossProfit !== null ? round((grossProfit / totalRevenue) * 100) : null,
      operatingMargin: operatingIncome !== null ? round((operatingIncome / totalRevenue) * 100) : null,
      netMargin: netIncome !== null ? round((netIncome / totalRevenue) * 100) : null,
      netDebt,
      ebitda,
      netDebtEbitda: null, // filled in below once TTM EBITDA is known
    });
  }
  levels.sort((a, b) => (a.q < b.q ? -1 : 1)); // ascending

  for (let i = 3; i < levels.length; i++) {
    const window = [levels[i - 3], levels[i - 2], levels[i - 1], levels[i]];
    if (window.some((w) => w.ebitda === null)) continue;
    const ttmEbitda = window.reduce((s, w) => s + w.ebitda, 0);
    if (ttmEbitda > 0 && levels[i].netDebt !== null) {
      levels[i].netDebtEbitda = round(levels[i].netDebt / ttmEbitda);
    }
  }
  return levels;
}

exports.handler = async () => {
  console.log(`scheduled-margin-leverage-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    // Fed funds regime classification — identical thresholds and trailing
    // 3-month-change construction as buildMonthly() in
    // /small-cap-vs-large-cap.html, just computed server-side here since
    // this job already needs to join it against ~503 companies' quarters.
    await recordAvCall();
    const fedRes = await fetch(`${ALPHA_VANTAGE_URL}?function=FEDERAL_FUNDS_RATE&interval=monthly&apikey=${apiKey}`, { headers: { "User-Agent": USER_AGENT } });
    if (!fedRes.ok) throw new Error(`FEDERAL_FUNDS_RATE HTTP ${fedRes.status}`);
    const fedPayload = await fedRes.json();
    if (!Array.isArray(fedPayload.data)) throw new Error(`FEDERAL_FUNDS_RATE missing data array: ${JSON.stringify(fedPayload).slice(0, 160)}`);
    const fedRows = fedPayload.data
      .map((r) => ({ date: r.date, value: parseFloat(r.value) }))
      .filter((r) => Number.isFinite(r.value))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const regimeByMonth = new Map(); // "YYYY-MM" -> { regime, change }
    for (let i = 3; i < fedRows.length; i++) {
      const ym = fedRows[i].date.slice(0, 7);
      const change = round(fedRows[i].value - fedRows[i - 3].value, 3);
      const regime = change > 0.1 ? "Hiking" : change < -0.1 ? "Cutting" : "Holding";
      regimeByMonth.set(ym, { regime, change });
    }
    function regimeForQuarterKey(qk) {
      const [y, q] = qk.split("-Q").map(Number);
      const month = q * 3;
      const ym = `${y}-${String(month).padStart(2, "0")}`;
      return regimeByMonth.get(ym) || regimeByMonth.get(prevMonthKey(ym)) || null;
    }
    function prevMonthKey(ym) {
      let [y, m] = ym.split("-").map(Number);
      m -= 1;
      if (m < 1) { m = 12; y -= 1; }
      return `${y}-${String(m).padStart(2, "0")}`;
    }

    const startedAt = Date.now();
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
    const store = getMarginLeverageStore();
    const saved = await store.get(CHECKPOINT_KEY, { type: "json" });
    const resume = !!(saved && !saved.complete && Date.now() - Date.parse(saved.startedAt) < CHECKPOINT_MAX_AGE_MS);
    const cycleStartedAt = resume ? saved.startedAt : new Date().toISOString();
    const results = new Map(resume ? Object.entries(saved.results) : []); // symbol -> { income, balance }
    if (resume) console.log(`scheduled-margin-leverage-background: resuming checkpoint with ${results.size} ticker(s) already fetched`);

    const saveCheckpoint = (complete) =>
      store.setJSON(CHECKPOINT_KEY, { startedAt: cycleStartedAt, complete, results: Object.fromEntries(results) });

    async function fetchInto(symbol) {
      try {
        const inc = await fetchStatement(apiKey, "INCOME_STATEMENT", symbol);
        await sleep(CALL_SLEEP_MS);
        const bal = await fetchStatement(apiKey, "BALANCE_SHEET", symbol);
        results.set(symbol, { income: inc.quarterly, balance: bal.quarterly, annualIncome: inc.annual, annualBalance: bal.annual });
        return true;
      } catch (err) {
        console.error(`scheduled-margin-leverage-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = BREADTH_CONSTITUENTS.filter((s) => !results.has(s));
    let stoppedForTime = false;
    let sinceCheckpoint = 0;
    for (let pass = 0; pass < 2 && todo.length && !stoppedForTime; pass++) {
      if (pass > 0) {
        console.log(`scheduled-margin-leverage-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(45000);
      }
      const missed = [];
      for (const symbol of todo) {
        if (outOfTime()) { stoppedForTime = true; break; }
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        if (got && ++sinceCheckpoint >= CHECKPOINT_EVERY) { await saveCheckpoint(false); sinceCheckpoint = 0; }
        await sleep(CALL_SLEEP_MS);
      }
      todo = missed;
    }
    await saveCheckpoint(!stoppedForTime);
    if (stoppedForTime) console.log(`scheduled-margin-leverage-background: out of time with ${results.size}/${BREADTH_CONSTITUENTS.length} fetched — run again to finish`);

    console.log(`scheduled-margin-leverage-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, { income, balance }] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const levels = buildCompanyQuarters(income, balance);
      if (levels.length < 2) continue; // need at least one QoQ pair
      companies.push({ symbol, name: m.name || symbol, sector: m.sector, levels });
    }
    if (!companies.length) throw new Error("No tickers resolved with both statement history and sector metadata");

    // ---- Sector-level quarterly median margin/leverage series ----
    const allQuarterKeys = new Set();
    for (const c of companies) for (const lv of c.levels) allQuarterKeys.add(calendarQuarterKey(lv.q));
    const quarters = [...allQuarterKeys].sort();

    const sectorSeries = {};
    for (const sector of SECTOR_ORDER) {
      const inSector = companies.filter((c) => c.sector === sector);
      if (!inSector.length) continue;
      sectorSeries[sector] = quarters.map((qk) => {
        const gross = [], oper = [], net = [], lev = [];
        for (const c of inSector) {
          for (const lv of c.levels) {
            if (calendarQuarterKey(lv.q) !== qk) continue;
            if (lv.grossMargin !== null) gross.push(lv.grossMargin);
            if (lv.operatingMargin !== null) oper.push(lv.operatingMargin);
            if (lv.netMargin !== null) net.push(lv.netMargin);
            if (lv.netDebtEbitda !== null) lev.push(lv.netDebtEbitda);
          }
        }
        return {
          quarter: qk,
          n: oper.length,
          medianGrossMargin: gross.length >= MIN_SECTOR_N ? round(median(gross)) : null,
          medianOperatingMargin: oper.length >= MIN_SECTOR_N ? round(median(oper)) : null,
          medianNetMargin: net.length >= MIN_SECTOR_N ? round(median(net)) : null,
          medianNetDebtEbitda: lev.length >= MIN_SECTOR_N ? round(median(lev)) : null,
        };
      });
    }

    // ---- Market-level quarterly QoQ deltas, for the regime comparison ----
    // One row per calendar quarter: the cross-company median change in
    // operating margin and in net-debt/EBITDA since the prior quarter,
    // paired with that quarter's Fed-funds regime. Aggregated to one point
    // per quarter (not one point per company-quarter) deliberately — a raw
    // per-company panel would pseudo-replicate the same macro quarter
    // ~500 times and mechanically inflate significance.
    const marginDeltasByQuarter = new Map(); // qk -> [deltas]
    const leverageDeltasByQuarter = new Map();
    for (const c of companies) {
      for (let i = 1; i < c.levels.length; i++) {
        const cur = c.levels[i], prev = c.levels[i - 1];
        const qk = calendarQuarterKey(cur.q);
        if (cur.operatingMargin !== null && prev.operatingMargin !== null) {
          const arr = marginDeltasByQuarter.get(qk) || [];
          arr.push(round(cur.operatingMargin - prev.operatingMargin));
          marginDeltasByQuarter.set(qk, arr);
        }
        if (cur.netDebtEbitda !== null && prev.netDebtEbitda !== null) {
          const arr = leverageDeltasByQuarter.get(qk) || [];
          arr.push(round(cur.netDebtEbitda - prev.netDebtEbitda));
          leverageDeltasByQuarter.set(qk, arr);
        }
      }
    }
    const marketQuarterly = quarters
      .map((qk) => {
        const marginArr = marginDeltasByQuarter.get(qk) || [];
        const leverageArr = leverageDeltasByQuarter.get(qk) || [];
        const regimeInfo = regimeForQuarterKey(qk);
        return {
          quarter: qk,
          regime: regimeInfo ? regimeInfo.regime : null,
          fedFundsChange3m: regimeInfo ? regimeInfo.change : null,
          medianMarginDelta: marginArr.length >= MIN_SECTOR_N ? round(median(marginArr)) : null,
          medianLeverageDelta: leverageArr.length >= MIN_SECTOR_N ? round(median(leverageArr)) : null,
          nMargin: marginArr.length,
          nLeverage: leverageArr.length,
        };
      })
      .filter((r) => r.regime !== null && (r.medianMarginDelta !== null || r.medianLeverageDelta !== null));

    // ---- Latest-quarter cross-company scatter + sector-relative leaderboards ----
    const sectorAsOf = {}; // sector -> latest non-null {operatingMargin, netDebtEbitda} medians
    for (const sector of Object.keys(sectorSeries)) {
      const series = sectorSeries[sector];
      let opMed = null, levMed = null;
      for (let i = series.length - 1; i >= 0; i--) {
        if (opMed === null && series[i].medianOperatingMargin !== null) opMed = series[i].medianOperatingMargin;
        if (levMed === null && series[i].medianNetDebtEbitda !== null) levMed = series[i].medianNetDebtEbitda;
        if (opMed !== null && levMed !== null) break;
      }
      sectorAsOf[sector] = { operatingMargin: opMed, netDebtEbitda: levMed };
    }

    const companyRows = [];
    for (const c of companies) {
      const latest = c.levels[c.levels.length - 1];
      const last4 = c.levels.slice(-4).map((lv) => lv.operatingMargin);
      let marginTrend = null;
      if (last4.length === 4 && last4[0] !== null && last4[3] !== null) {
        const change = round(last4[3] - last4[0]);
        marginTrend = change > MARGIN_TREND_THRESHOLD ? "up" : change < -MARGIN_TREND_THRESHOLD ? "down" : "flat";
      }
      const sectorRef = sectorAsOf[c.sector] || { operatingMargin: null, netDebtEbitda: null };
      companyRows.push({
        symbol: c.symbol,
        name: c.name,
        sector: c.sector,
        latestQuarter: latest.q,
        grossMargin: latest.grossMargin,
        operatingMargin: latest.operatingMargin,
        netMargin: latest.netMargin,
        netDebtEbitda: latest.netDebtEbitda,
        marginTrend4q: last4,
        marginTrendDirection: marginTrend,
        sectorRelMarginPpt: latest.operatingMargin !== null && sectorRef.operatingMargin !== null
          ? round(latest.operatingMargin - sectorRef.operatingMargin) : null,
        sectorRelLeverageX: latest.netDebtEbitda !== null && sectorRef.netDebtEbitda !== null
          ? round(latest.netDebtEbitda - sectorRef.netDebtEbitda) : null,
      });
    }

    const scatterLatest = companyRows
      .filter((r) => r.operatingMargin !== null && r.netDebtEbitda !== null)
      .map((r) => ({ symbol: r.symbol, sector: r.sector, operatingMargin: r.operatingMargin, netDebtEbitda: r.netDebtEbitda }));

    const marginLeadersHigh = [...companyRows].filter((r) => r.sectorRelMarginPpt !== null)
      .sort((a, b) => b.sectorRelMarginPpt - a.sectorRelMarginPpt).slice(0, NOTABLE_COUNT);
    const marginLeadersLow = [...companyRows].filter((r) => r.sectorRelMarginPpt !== null)
      .sort((a, b) => a.sectorRelMarginPpt - b.sectorRelMarginPpt).slice(0, NOTABLE_COUNT);
    const leverageLeadersHigh = [...companyRows].filter((r) => r.sectorRelLeverageX !== null)
      .sort((a, b) => b.sectorRelLeverageX - a.sectorRelLeverageX).slice(0, NOTABLE_COUNT);
    const leverageLeadersLow = [...companyRows].filter((r) => r.sectorRelLeverageX !== null)
      .sort((a, b) => a.sectorRelLeverageX - b.sectorRelLeverageX).slice(0, NOTABLE_COUNT);

    const sectorsSummary = SECTOR_ORDER
      .filter((s) => sectorSeries[s])
      .map((sector) => ({
        sector,
        companyCount: companies.filter((c) => c.sector === sector).length,
        latestOperatingMargin: sectorAsOf[sector].operatingMargin,
        latestNetDebtEbitda: sectorAsOf[sector].netDebtEbitda,
      }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      partial: stoppedForTime,
      companyCount: companies.length,
      quarters,
      sectors: sectorsSummary,
      sectorSeries,
      marketQuarterly,
      scatterLatest,
      marginLeaders: { high: marginLeadersHigh, low: marginLeadersLow },
      leverageLeaders: { high: leverageLeadersHigh, low: leverageLeadersLow },
      companies: companyRows,
    };

    if (stoppedForTime) {
      const published = await store.get(BLOB_KEY, { type: "json" });
      if (published && !published.partial) {
        console.log("scheduled-margin-leverage-background: partial run, keeping the last complete published snapshot until the next run finishes the cycle");
        return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, fetched: results.size, published: false }) };
      }
    }
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-margin-leverage-background: wrote ${companies.length} companies across ${sectorsSummary.length} sectors, ${quarters.length} quarters`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial: stoppedForTime, fetched: results.size, companies: companies.length, sectors: sectorsSummary.length }) };
  } catch (err) {
    console.error(`scheduled-margin-leverage-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
