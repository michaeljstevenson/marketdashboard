// Scheduled Background Function (see [functions."scheduled-roic-wacc-
// background"] in netlify.toml) for the ROIC vs. Cost of Capital page —
// the "is this company actually creating economic value" screen. Sweeps
// Alpha Vantage's INCOME_STATEMENT and BALANCE_SHEET endpoints (quarterly)
// across the full S&P 500, same two endpoints scheduled-margin-leverage-
// background.js already sweeps for a different purpose. Deliberately runs
// its own independent sweep rather than reading that job's checkpoint —
// margin-leverage's KEEP_FIELDS only keeps the handful of fields its own
// margin/leverage math needs (no interest expense, no tax figures, no
// shareholder equity), and this page needs several more, so extending a
// checkpoint another already-shipped page's own job depends on
// (scheduled-quality-financials-background.js reads it too) felt riskier
// than paying for a second ~1006-call sweep. One-time snapshot, no
// schedule — matches this file's current convention for new full-universe
// Equities jobs (run manually via the Netlify dashboard "Run now").
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob, same pattern as every other full-universe sweep in this
// codebase. Also does two *optional*, read-only cross-page reads — each
// with a graceful fallback if the blob isn't populated yet, so this job
// never hard-depends on another one-time-snapshot job having run first:
//   - equity-risk-premium's latest.json, for each company's Beta (used in
//     the CAPM cost-of-equity estimate) and the risk-free rate / market
//     median earnings-yield-based ERP (used as the CAPM market-premium
//     assumption, rather than introducing a third, unrelated ERP source).
//   - relative-strength's latest.json, for each company's 3-month relative
//     price return, used only in this page's "does the market actually
//     reward value creation" regression, not in the ROIC/WACC math itself.

const { getRoicWaccStore, BLOB_KEY, CHECKPOINT_KEY } = require("./roic-wacc-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getErpStore, LATEST_KEY: ERP_LATEST_KEY } = require("./equity-risk-premium-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Only the most recent 4 quarters (for trailing-twelve-month NOPAT/interest)
// plus one spare for alignment gaps — this page is a single cross-sectional
// snapshot, not a multi-year trend like margin-leverage's, so it needs far
// fewer quarters kept.
const QUARTERS_NEEDED = 6;
const NOTABLE_COUNT = 15;
const MIN_SECTOR_N = 3;
const STATUTORY_TAX_RATE = 0.21; // US federal statutory rate, used whenever a company's own effective TTM rate isn't usable (negative/zero pretax income, a one-time tax benefit, etc.)
const FALLBACK_MARKET_ERP = 5.0; // used only if the equity-risk-premium blob isn't populated yet
const FALLBACK_DEBT_SPREAD = 1.5; // pp over the risk-free rate, used only when a company reports debt but no usable interest expense across the trailing year

// Same pacing tradeoff as scheduled-margin-leverage-background.js: two
// calls per company (~1006 total) needs pacing tight enough to leave room
// for a retry pass inside a Background Function's ~15-minute ceiling.
const CALL_SLEEP_MS = 750;
const RUN_BUDGET_MS = 12 * 60 * 1000;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_EVERY = 120;

const KEEP_FIELDS = {
  INCOME_STATEMENT: ["fiscalDateEnding", "ebit", "operatingIncome", "incomeBeforeTax", "incomeTaxExpense", "interestExpense"],
  BALANCE_SHEET: ["fiscalDateEnding", "totalShareholderEquity", "shortLongTermDebtTotal", "shortTermDebt", "currentDebt", "longTermDebt", "longTermDebtNoncurrent", "cashAndCashEquivalentsAtCarryingValue", "cashAndShortTermInvestments"],
};
const pick = (rows, keys) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Alpha Vantage returns the string "None" (not null/omitted) for a missing
// numeric field on several fundamentals endpoints — same gotcha guarded
// against elsewhere in this codebase (e.g. scheduled-margin-leverage-
// background.js's num() helper).
function num(v) {
  if (v === null || v === undefined || v === "None" || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function totalDebtOf(bal) {
  const direct = num(bal.shortLongTermDebtTotal);
  if (direct !== null) return direct;
  const short = num(bal.shortTermDebt) ?? num(bal.currentDebt);
  const long = num(bal.longTermDebt) ?? num(bal.longTermDebtNoncurrent);
  if (short === null && long === null) return null;
  return (short || 0) + (long || 0);
}

function cashOf(bal) {
  return num(bal.cashAndCashEquivalentsAtCarryingValue) ?? num(bal.cashAndShortTermInvestments) ?? 0;
}

function ebitOf(inc) {
  return num(inc.ebit) ?? num(inc.operatingIncome);
}

function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
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
  return pick(rows.slice(0, QUARTERS_NEEDED), KEEP_FIELDS[fn]); // most-recent-first
}

// Computes trailing-twelve-month NOPAT/interest and a latest-quarter
// balance-sheet snapshot for one company. Returns null when there isn't a
// clean 4-consecutive-quarter TTM window with both statements present, or
// when the resulting invested-capital base is unusable (missing debt data,
// non-positive book equity — common for heavy-buyback names like MCD or
// SBUX where treasury-stock repurchases have driven equity negative, which
// breaks the ROIC/WACC weighting this page uses, so those names are
// excluded rather than shown with a distorted ratio).
function computeCompanyMetrics(incomeRows, balanceRows) {
  const balByDate = new Map(balanceRows.map((r) => [r.fiscalDateEnding, r]));
  const matched = incomeRows.filter((inc) => balByDate.has(inc.fiscalDateEnding)).slice(0, 4);
  if (matched.length < 4) return null;

  let ttmEbit = 0, ttmPretax = 0, ttmTax = 0, ttmInterest = 0;
  for (const inc of matched) {
    const ebitQ = ebitOf(inc);
    if (ebitQ === null) return null; // need a complete trailing-year EBIT figure
    ttmEbit += ebitQ;
    ttmPretax += num(inc.incomeBeforeTax) ?? 0;
    ttmTax += num(inc.incomeTaxExpense) ?? 0;
    ttmInterest += num(inc.interestExpense) ?? 0; // "None"/missing treated as no reported interest cost that quarter, not as unknown — see methodology note on the page
  }

  const effectiveTaxRate = ttmPretax > 0 ? clamp(ttmTax / ttmPretax, 0, 0.5) : null;
  const taxRate = effectiveTaxRate ?? STATUTORY_TAX_RATE;
  const nopatTtm = ttmEbit * (1 - taxRate);

  const latestBal = balByDate.get(matched[0].fiscalDateEnding);
  const totalDebt = totalDebtOf(latestBal);
  const totalEquity = num(latestBal.totalShareholderEquity);
  const cash = cashOf(latestBal);
  if (totalDebt === null || totalEquity === null || totalEquity <= 0) return null;

  const investedCapital = totalDebt + totalEquity - cash;
  if (investedCapital <= 0) return null;

  const roic = (nopatTtm / investedCapital) * 100;
  const costOfDebtPretaxRaw = totalDebt > 0 ? (ttmInterest / totalDebt) * 100 : 0;

  return {
    fiscalQuarter: matched[0].fiscalDateEnding,
    nopatTtm,
    totalDebt,
    totalEquity,
    cash,
    investedCapital,
    roic,
    taxRate,
    costOfDebtPretaxRaw, // may need the risk-free-plus-spread fallback applied by the caller, which knows the risk-free rate
    interestReported: ttmInterest > 0,
  };
}

exports.handler = async () => {
  console.log(`scheduled-roic-wacc-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    // Risk-free rate: same direct TREASURY_YIELD call equity-risk-premium's
    // own job makes, rather than depending on that job's blob for it — this
    // page stays independently buildable even if that one hasn't run yet.
    let riskFreeRate = null;
    for (let attempt = 0; attempt < 3 && riskFreeRate === null; attempt++) {
      try {
        await recordAvCall();
        const res = await fetch(`${ALPHA_VANTAGE_URL}?function=TREASURY_YIELD&interval=monthly&maturity=10year&apikey=${apiKey}`, { headers: { "User-Agent": USER_AGENT } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const rows = Array.isArray(payload.data) ? payload.data : [];
        const latest = rows.find((r) => r.value !== "." && r.value !== undefined);
        if (latest) riskFreeRate = parseFloat(latest.value);
      } catch (err) {
        console.error(`scheduled-roic-wacc-background: TREASURY_YIELD fetch failed (attempt ${attempt + 1}): ${err.message}`);
        await sleep(5000);
      }
    }
    if (riskFreeRate === null) throw new Error("Could not fetch TREASURY_YIELD after 3 attempts");
    await sleep(1050);

    // Optional cross-page reads — beta/market-ERP and 3-month relative
    // return. Both degrade gracefully rather than failing this job.
    let betaBySymbol = {}, marketErp = FALLBACK_MARKET_ERP;
    try {
      const erpLatest = await getErpStore().get(ERP_LATEST_KEY, { type: "json" });
      if (erpLatest && Array.isArray(erpLatest.companies)) {
        for (const c of erpLatest.companies) if (c.beta !== null && c.beta !== undefined) betaBySymbol[c.symbol] = c.beta;
        if (erpLatest.market && erpLatest.market.medianErp !== null && erpLatest.market.medianErp !== undefined) {
          marketErp = erpLatest.market.medianErp;
        }
      }
    } catch (err) {
      console.error("scheduled-roic-wacc-background: could not read equity-risk-premium blob, using beta=1 and a fallback market ERP:", err.message);
    }
    const hasBetaData = Object.keys(betaBySymbol).length > 0;

    let rel3MBySymbol = {};
    try {
      const rsLatest = await getRelativeStrengthStore().get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) if (c.rel3M !== null && c.rel3M !== undefined) rel3MBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-roic-wacc-background: could not read relative-strength blob, continuing without the value-creation-vs-return test:", err.message);
    }
    const hasRel3M = Object.keys(rel3MBySymbol).length > 0;

    const startedAt = Date.now();
    const outOfTime = () => Date.now() - startedAt > RUN_BUDGET_MS;
    const store = getRoicWaccStore();
    const saved = await store.get(CHECKPOINT_KEY, { type: "json" });
    const resume = !!(saved && !saved.complete && Date.now() - Date.parse(saved.startedAt) < CHECKPOINT_MAX_AGE_MS);
    const cycleStartedAt = resume ? saved.startedAt : new Date().toISOString();
    const results = new Map(resume ? Object.entries(saved.results) : []); // symbol -> { income, balance }
    if (resume) console.log(`scheduled-roic-wacc-background: resuming checkpoint with ${results.size} ticker(s) already fetched`);

    const failures = resume ? { ...(saved.failed || {}) } : {};
    const saveCheckpoint = (complete) =>
      store.setJSON(CHECKPOINT_KEY, { startedAt: cycleStartedAt, complete, results: Object.fromEntries(results), failed: failures });

    async function fetchInto(symbol) {
      try {
        const income = await fetchStatement(apiKey, "INCOME_STATEMENT", symbol);
        await sleep(CALL_SLEEP_MS);
        const balance = await fetchStatement(apiKey, "BALANCE_SHEET", symbol);
        delete failures[symbol];
        results.set(symbol, { income, balance });
        return true;
      } catch (err) {
        console.error(`scheduled-roic-wacc-background: ${symbol} failed: ${err.message}`);
        failures[symbol] = String(err.message).slice(0, 200);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = BREADTH_CONSTITUENTS.filter((s) => !results.has(s));
    let stoppedForTime = false;
    let sinceCheckpoint = 0;
    for (let pass = 0; pass < 2 && todo.length && !stoppedForTime; pass++) {
      if (pass > 0) {
        console.log(`scheduled-roic-wacc-background: retry pass for ${todo.length} ticker(s)`);
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
    if (stoppedForTime) console.log(`scheduled-roic-wacc-background: out of time with ${results.size}/${BREADTH_CONSTITUENTS.length} fetched — run again to finish`);

    console.log(`scheduled-roic-wacc-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, { income, balance }] of results.entries()) {
      const m = metaTickers[symbol];
      if (!m || !m.sector) continue;
      const metrics = computeCompanyMetrics(income, balance);
      if (!metrics) continue;

      const beta = betaBySymbol[symbol] ?? 1; // market-average assumption when beta isn't available
      const costOfEquity = riskFreeRate + beta * marketErp;
      const costOfDebtPretax = metrics.totalDebt > 0 && !metrics.interestReported
        ? riskFreeRate + FALLBACK_DEBT_SPREAD
        : metrics.costOfDebtPretaxRaw;
      const costOfDebtAfterTax = costOfDebtPretax * (1 - metrics.taxRate);
      const weightDebt = metrics.totalDebt / (metrics.totalDebt + metrics.totalEquity);
      const weightEquity = 1 - weightDebt;
      const wacc = weightEquity * costOfEquity + weightDebt * costOfDebtAfterTax;
      const spread = metrics.roic - wacc;

      companies.push({
        symbol,
        name: m.name || symbol,
        sector: m.sector,
        fiscalQuarter: metrics.fiscalQuarter,
        roic: round(metrics.roic),
        wacc: round(wacc),
        spread: round(spread),
        costOfEquity: round(costOfEquity),
        costOfDebtAfterTax: round(costOfDebtAfterTax),
        beta: round(beta),
        betaEstimated: !(symbol in betaBySymbol),
        taxRate: round(metrics.taxRate * 100),
        investedCapitalUsd: metrics.investedCapital,
        nopatTtmUsd: metrics.nopatTtm,
        rel3M: rel3MBySymbol[symbol] ?? null,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with usable statement history and sector metadata");

    const rankedBySpread = [...companies].filter((c) => c.spread !== null).sort((a, b) => b.spread - a.spread);
    rankedBySpread.forEach((c, i) => { c.rankSpread = i + 1; });

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = companies.filter((c) => c.sector === sector);
        if (inSector.length < MIN_SECTOR_N) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianRoic: round(median(inSector.map((c) => c.roic))),
          medianWacc: round(median(inSector.map((c) => c.wacc))),
          medianSpread: round(median(inSector.map((c) => c.spread))),
          valueCreatorPct: round((inSector.filter((c) => c.spread > 0).length / inSector.length) * 100, 1),
        };
      })
      .filter(Boolean);

    const market = {
      companyCount: companies.length,
      riskFreeRate: round(riskFreeRate),
      marketErpAssumption: round(marketErp),
      marketErpSource: hasBetaData ? "equity-risk-premium page (median earnings-yield-based ERP)" : "fallback constant (equity-risk-premium blob not yet populated)",
      medianRoic: round(median(companies.map((c) => c.roic))),
      medianWacc: round(median(companies.map((c) => c.wacc))),
      medianSpread: round(median(companies.map((c) => c.spread))),
      valueCreatorPct: round((companies.filter((c) => c.spread > 0).length / companies.length) * 100, 1),
    };

    const creators = rankedBySpread.slice(0, NOTABLE_COUNT);
    const destroyers = rankedBySpread.slice(-NOTABLE_COUNT).reverse();

    const betaSpreadPairs = hasBetaData
      ? companies.filter((c) => !c.betaEstimated && c.spread !== null).map((c) => ({ x: c.beta, y: c.spread, symbol: c.symbol }))
      : [];
    const rel3MSpreadPairs = hasRel3M
      ? companies.filter((c) => c.rel3M !== null && c.spread !== null).map((c) => ({ x: c.spread, y: c.rel3M, symbol: c.symbol }))
      : [];

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      partial: stoppedForTime,
      hasBetaData,
      hasRel3M,
      market,
      sectors,
      creators,
      destroyers,
      betaSpreadPairs,
      rel3MSpreadPairs,
      companies,
    };

    if (stoppedForTime) {
      const published = await store.get(BLOB_KEY, { type: "json" });
      if (published && !published.partial) {
        console.log("scheduled-roic-wacc-background: partial run, keeping the last complete published snapshot until the next run finishes the cycle");
        return { statusCode: 200, body: JSON.stringify({ ok: true, partial: true, fetched: results.size, published: false }) };
      }
    }
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-roic-wacc-background: wrote ${companies.length} companies across ${sectors.length} sectors`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, partial: stoppedForTime, fetched: results.size, companies: companies.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-roic-wacc-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
