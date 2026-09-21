// Scheduled Background Function (see [functions."scheduled-pe-divergence-
// background"] in netlify.toml) for the /pe-divergence.html page.
//
// Sweeps Alpha Vantage's OVERVIEW endpoint across the full S&P 500 (~503
// calls) for TrailingPE and ForwardPE. Kept as its own standalone sweep
// rather than piggybacking on scheduled-beeswarm-meta-background.js's own
// weekly OVERVIEW pass — that job doesn't persist the PE fields this page
// needs, and CLAUDE.md's boundary rule against touching an already-live
// page's backend rules out just adding them there. Same tradeoff already
// made by scheduled-dispersion-background.js for the same reason (see its
// header comment) — a second, otherwise-redundant sweep of one endpoint.
//
// Both P/E ratios share the same numerator (today's share price), so their
// ratio directly recovers the market's implied year-ahead EPS growth rate:
//   TrailingPE / ForwardPE - 1
//     = (Price / EPS_trailing) / (Price / EPS_forward) - 1
//     = EPS_forward / EPS_trailing - 1
// No separate EPS-estimate data needed — it falls straight out of the two
// P/E numbers Alpha Vantage already reports. OVERVIEW also reports trailing
// QuarterlyEarningsGrowthYOY, so this page can test how the market's
// *implied* forward growth relates to the company's most recent *actual*
// growth — a momentum-vs-mean-reversion question — at zero extra API cost.
//
// Since OVERVIEW is a current-state snapshot (not a time series), the
// market-wide weekly median is appended to a running history each run —
// same "accumulates real history over successive runs" pattern used by
// scheduled-revisions-background.js and scheduled-dispersion-background.js.

const { getPeDivergenceStore, BLOB_KEY } = require("./pe-divergence-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER, normalizeSector } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_MEANINGFUL_PE = 300; // beyond this, a near-zero-earnings distortion, not a real valuation signal
const NOTABLE_COUNT = 15;
const MAX_HISTORY_WEEKS = 104;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function mean(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

async function fetchOverview(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(`${ALPHA_VANTAGE_URL}?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = await res.json();
  if (p.Note || p.Information || p.error) throw new Error(p.Note || p.Information || JSON.stringify(p.error));
  if (!p.Symbol) return null;
  const trailingPE = parseFloat(p.TrailingPE) || parseFloat(p.PERatio) || null;
  const forwardPE = parseFloat(p.ForwardPE) || null;
  return {
    name: p.Name || symbol,
    sector: normalizeSector(symbol, p.Sector),
    trailingPE: Number.isFinite(trailingPE) ? trailingPE : null,
    forwardPE: Number.isFinite(forwardPE) ? forwardPE : null,
    quarterlyEarningsGrowthYoY: Number.isFinite(parseFloat(p.QuarterlyEarningsGrowthYOY)) ? parseFloat(p.QuarterlyEarningsGrowthYOY) * 100 : null,
  };
}

exports.handler = async () => {
  console.log(`scheduled-pe-divergence-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const results = new Map();
    async function fetchInto(symbol) {
      try {
        const entry = await fetchOverview(apiKey, symbol);
        if (entry) results.set(symbol, entry);
        return true;
      } catch (err) {
        console.error(`scheduled-pe-divergence-background: ${symbol} failed: ${err.message}`);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-pe-divergence-background: retry pass for ${todo.length} ticker(s)`);
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

    console.log(`scheduled-pe-divergence-background: fetched ${results.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (results.size === 0) throw new Error("Every ticker failed. Refusing to write an empty snapshot");

    const companies = [];
    for (const [symbol, e] of results.entries()) {
      if (!e.sector) continue;
      const validPE = e.trailingPE !== null && e.forwardPE !== null && e.trailingPE > 0 && e.trailingPE <= MAX_MEANINGFUL_PE && e.forwardPE > 0 && e.forwardPE <= MAX_MEANINGFUL_PE;
      const impliedEpsGrowth = validPE ? round((e.trailingPE / e.forwardPE - 1) * 100) : null;
      companies.push({
        symbol,
        name: e.name,
        sector: e.sector,
        trailingPE: e.trailingPE !== null ? round(e.trailingPE) : null,
        forwardPE: e.forwardPE !== null ? round(e.forwardPE) : null,
        impliedEpsGrowth,
        quarterlyEarningsGrowthYoY: e.quarterlyEarningsGrowthYoY !== null ? round(e.quarterlyEarningsGrowthYoY) : null,
        hasMeaningfulPE: validPE,
      });
    }
    if (!companies.length) throw new Error("No tickers resolved with sector metadata");

    const withPE = companies.filter((c) => c.hasMeaningfulPE);

    const market = {
      companyCount: companies.length,
      meaningfulPeCount: withPE.length,
      medianImpliedEpsGrowth: round(median(withPE.map((c) => c.impliedEpsGrowth))),
      meanTrailingPE: round(mean(withPE.map((c) => c.trailingPE))),
      meanForwardPE: round(mean(withPE.map((c) => c.forwardPE))),
    };

    const sectors = SECTOR_ORDER
      .map((sector) => {
        const inSector = withPE.filter((c) => c.sector === sector);
        if (!inSector.length) return null;
        return {
          sector,
          companyCount: inSector.length,
          medianImpliedEpsGrowth: round(median(inSector.map((c) => c.impliedEpsGrowth))),
          meanTrailingPE: round(mean(inSector.map((c) => c.trailingPE))),
          meanForwardPE: round(mean(inSector.map((c) => c.forwardPE))),
        };
      })
      .filter(Boolean);

    // Implied (forward-looking) vs. actual (trailing) growth — one point
    // per company, both fields from the same OVERVIEW call.
    const growthPairs = withPE
      .filter((c) => c.quarterlyEarningsGrowthYoY !== null && Math.abs(c.quarterlyEarningsGrowthYoY) < 500 && Math.abs(c.impliedEpsGrowth) < 500)
      .map((c) => ({ symbol: c.symbol, x: c.quarterlyEarningsGrowthYoY, y: c.impliedEpsGrowth }));

    const growthLeaders = [...withPE].sort((a, b) => b.impliedEpsGrowth - a.impliedEpsGrowth).slice(0, NOTABLE_COUNT)
      .map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, trailingPE: c.trailingPE, forwardPE: c.forwardPE, impliedEpsGrowth: c.impliedEpsGrowth }));
    const declineLeaders = [...withPE].sort((a, b) => a.impliedEpsGrowth - b.impliedEpsGrowth).slice(0, NOTABLE_COUNT)
      .map((c) => ({ symbol: c.symbol, name: c.name, sector: c.sector, trailingPE: c.trailingPE, forwardPE: c.forwardPE, impliedEpsGrowth: c.impliedEpsGrowth }));

    const store = getPeDivergenceStore();
    const previous = (await store.get(BLOB_KEY, { type: "json" })) || { history: [] };
    const history = Array.isArray(previous.history) ? previous.history : [];
    const weekKey = new Date().toISOString().slice(0, 10);
    if (!history.length || history[history.length - 1].week !== weekKey) {
      history.push({ week: weekKey, medianImpliedEpsGrowth: market.medianImpliedEpsGrowth, meanTrailingPE: market.meanTrailingPE, meanForwardPE: market.meanForwardPE });
    } else {
      history[history.length - 1] = { week: weekKey, medianImpliedEpsGrowth: market.medianImpliedEpsGrowth, meanTrailingPE: market.meanTrailingPE, meanForwardPE: market.meanForwardPE };
    }
    while (history.length > MAX_HISTORY_WEEKS) history.shift();

    const payload = {
      generated_at_utc: new Date().toISOString(),
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: results.size,
      market,
      sectors,
      history,
      growthPairs,
      growthLeaders,
      declineLeaders,
      companies: withPE.map((c) => ({
        symbol: c.symbol, name: c.name, sector: c.sector, trailingPE: c.trailingPE, forwardPE: c.forwardPE,
        impliedEpsGrowth: c.impliedEpsGrowth, quarterlyEarningsGrowthYoY: c.quarterlyEarningsGrowthYoY,
      })),
    };

    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-pe-divergence-background: wrote ${withPE.length} companies with meaningful P/E across ${sectors.length} sectors, ${history.length}-week history`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, companies: withPE.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-pe-divergence-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
