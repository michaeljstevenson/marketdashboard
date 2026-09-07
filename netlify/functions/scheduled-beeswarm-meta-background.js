// Scheduled Background Function (see netlify.toml) that refreshes the
// slow-moving per-company metadata the daily sector-beeswarm view needs:
// display name, GICS sector, and shares outstanding, for every S&P 500
// constituent (reusing the list in breadth-constituents.js). Written to
// Netlify Blobs as meta.json for scheduled-beeswarm-daily-background.js to
// join against each afternoon.
//
// Split out from the daily job because this is the expensive half —
// ~503 COMPANY_OVERVIEW calls, paced ~800ms apart to stay under Alpha
// Vantage's burst limiter, ~7 minutes per run — and it barely changes day
// to day (shares outstanding drift slowly; sector reassignments are rare).
// Runs weekly. The daily job only needs a cheap GLOBAL_QUOTE per name.
//
// A ticker whose OVERVIEW comes back empty (happens for some dual-class
// lines and very recent additions) keeps whatever entry a prior run stored
// rather than being dropped — see the merge-with-previous logic below.

const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { normalizeSector } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOverview(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=OVERVIEW&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const p = await res.json();
  if (p.Note || p.Information || p.error) throw new Error(p.Note || p.Information || JSON.stringify(p.error));
  if (!p.Symbol) return null; // empty body — no data for this symbol
  return {
    name: p.Name || symbol,
    sector: normalizeSector(symbol, p.Sector),
    sharesOutstanding: parseFloat(p.SharesOutstanding) || null,
    marketCap: parseFloat(p.MarketCapitalization) || null,
  };
}

exports.handler = async () => {
  console.log(`scheduled-beeswarm-meta-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const store = getBeeswarmStore();
    const previous = (await store.get(META_KEY, { type: "json" })) || { tickers: {} };
    const prevTickers = previous.tickers || {};

    const tickers = {};
    let ok = 0;
    let carried = 0;
    let sectorless = 0;

    for (const symbol of BREADTH_CONSTITUENTS) {
      let entry = null;
      try {
        entry = await fetchOverview(apiKey, symbol);
      } catch (err) {
        console.error(`scheduled-beeswarm-meta-background: ${symbol} failed: ${err.message}`);
      }
      if (entry && entry.sharesOutstanding) {
        // Fall back to the previous run's sector if OVERVIEW gave one we
        // couldn't map (and we had a good one before).
        if (!entry.sector && prevTickers[symbol] && prevTickers[symbol].sector) {
          entry.sector = prevTickers[symbol].sector;
        }
        tickers[symbol] = entry;
        ok++;
      } else if (prevTickers[symbol]) {
        tickers[symbol] = prevTickers[symbol];
        carried++;
      }
      if (tickers[symbol] && !tickers[symbol].sector) sectorless++;
      await sleep(800);
    }

    const payload = {
      generated_at_utc: new Date().toISOString(),
      count: Object.keys(tickers).length,
      tickers,
    };
    await store.setJSON(META_KEY, payload);
    console.log(
      `scheduled-beeswarm-meta-background: wrote ${payload.count} tickers (${ok} fresh, ${carried} carried, ${sectorless} still sectorless)`
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true, count: payload.count, sectorless }) };
  } catch (err) {
    console.error(`scheduled-beeswarm-meta-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
