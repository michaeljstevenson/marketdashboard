// Scheduled Background Function (see [functions."scheduled-congressional-
// trading-background"] in netlify.toml) that sweeps Alpha Vantage's
// CONGRESS_TRADES endpoint across the full S&P 500 (BREADTH_CONSTITUENTS),
// one `symbol=<ticker>` call per company, for the "Congressional Trading
// Tracker" page — a stock-centric view of US congressional stock-trading
// disclosures (STOCK Act filings), the same positioning-by-a-specific-
// market-participant-population concept as scheduled-insider-transactions-
// background.js (Form 4 corporate insiders), just a different filer
// population. This page is strictly neutral/descriptive: party (D/R) is
// reported only as one cross-tab among several, per the page's own
// methodology section, never as commentary.
//
// CONGRESS_TRADES has no from_date filter (unlike INSIDER_TRANSACTIONS) —
// it always returns a company's full disclosed trading history, so the
// trailing-12-month window below is applied client-side after the fetch,
// same as every other "full history per call, filter locally" endpoint on
// this site.
//
// Real data-quality findings from inspecting live responses during this
// page's build (confirmed against AAPL/KO/DXCM before writing this filter):
//   - asset_type_code is NOT consistently "ST". Recent House filings (the
//     STOCK Act's newer structured PTR format) report "ST"; Senate filings
//     (an older/different disclosure pipeline) report the SAME common-stock
//     trades as "Stock" instead — confirmed on real Tina Smith (D-MN) and
//     John Boozman (R-AR) trades from 2026, well inside this page's own
//     trailing-12-month window. A strict `asset_type_code === "ST"` filter,
//     as this page's own brief originally assumed from a single House-filing
//     example, would silently drop EVERY Senate trade — in one real 138-
//     trade sample (KO) that was 39 trades (28% of the total, all Senate).
//     This job instead accepts "ST" and "Stock" case-insensitively (a rare
//     "sT" casing variant was also observed) and excludes "Stock Option"
//     (a real, distinct value seen in the same sample) and any missing/
//     unrecognized code.
//   - filing_status is NOT a reliable "is this a real transaction" filter
//     either: it's "NEW" on House filings but consistently null on EVERY
//     Senate filing (Senate disclosures don't populate that field at all),
//     so filtering on filing_status would also silently drop all Senate
//     activity. The real "this isn't a disclosed buy/sell" signal in the
//     data is transaction_type — most rows are BUY or SELL, but a real
//     minority (31 of 138 in the same KO sample) are "OTHER": subholding/
//     account-transfer disclosures with garbled asset_name text (e.g.
//     "... FILING STATUS: New SubHOLDING OF: Morgan Stanley - Select UMA")
//     that don't represent a discretionary buy or sell decision at all. This
//     job keeps only transaction_type BUY/SELL and drops OTHER.
//
// Every dollar figure on this page is a rough ESTIMATE, not an exact
// reported amount: the STOCK Act discloses trade size as a bracketed range
// (e.g. "$1,001-$15,000"), never an exact dollar figure — a hard limit of
// the source data, not something this job can improve on. This job uses the
// midpoint of amount_min/amount_max as the estimate for every trade, per
// company and in aggregate, and the page says so prominently.
//
// Trailing 12 months (not 90 days like Insider Buying/Selling): the STOCK
// Act allows a filer up to 45 days to disclose a trade (see
// notification_date/filed_date vs. transaction_date in the raw data), and
// this dataset is far sparser per-company than corporate Form 4 activity, so
// a shorter window risks too few trades per company for meaningful sector
// aggregates. A "recent" 12-month window can still be systematically missing
// the newest transactions still inside their up-to-45-day notification
// window — the page's methodology section says so explicitly.
//
// Per-company net-flow-vs-forward-return regression uses a NORMALIZED ratio
// -- (estBuyValue - estSellValue) / (estBuyValue + estSellValue), in
// [-1, 1] -- rather than the raw dollar net flow, so the test isn't
// dominated by which handful of companies happen to attract the largest
// individual disclosed trades (a small number of high-net-worth members can
// dwarf everyone else's disclosed amounts) — the same normalization
// approach scheduled-institutional-ownership-background.js uses for its own
// net flow % metric. Requires at least MIN_TRADES_FOR_RATIO qualifying
// trades so the ratio isn't just +/-1 off a single disclosure.
//
// Storage discipline: only derived per-company aggregate fields are
// written to the blob — no per-trade detail list is retained (this
// endpoint's raw history can run to hundreds of rows for a heavily-traded
// mega-cap, same "large response, keep only the aggregate" precedent as
// scheduled-news-sentiment-background.js / scheduled-institutional-
// ownership-background.js).
//
// Real cross-page dependency, not a coincidence: like buyback-tracker,
// institutional-ownership, and news-sentiment, this job reads scheduled-
// relative-strength-background's own latest.json (getRelativeStrengthStore)
// for the "does congressional trading activity predict returns" test
// (Ziobrowski et al.) instead of running a second ~503-call price sweep,
// with the identical graceful fallback (rows keep relPrice3M: null, warning
// banner, page still fully functional) if that blob isn't populated yet.
//
// Name/sector come from Sector Beeswarm's own weekly meta.json, same
// convention as every other full-universe job on this site.
//
// Pacing: ~1050ms between-call, same as every other full-sweep job on this
// site, plus a retry pass for anything that fails.

const { getCongressionalTradingStore, BLOB_KEY } = require("./congressional-trading-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const WINDOW_DAYS = 365;
const LEADERBOARD_COUNT = 15;
// A ratio built off a single disclosed trade is mechanically +1 or -1 and
// tells you nothing about the relationship being tested — this floor keeps
// the regression restricted to companies with at least a little real
// breadth of disclosed activity in the window.
const MIN_TRADES_FOR_RATIO = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}
function round(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

async function fetchCongressTrades(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=CONGRESS_TRADES&symbol=${symbol}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  if (!Array.isArray(payload.trades)) {
    throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload.trades;
}

// See file header for why this is "ST" OR "Stock" (case-insensitive), not
// a strict "ST" match — Senate filings report the same common-stock trades
// under a different code than House filings do.
function isCommonStockAssetType(code) {
  if (!code) return false;
  const norm = String(code).trim().toUpperCase();
  return norm === "ST" || norm === "STOCK";
}

// See file header for why this is a transaction_type check, not a
// filing_status check.
function qualifyingTrades(raw, cutoffDateStr) {
  return raw.filter((t) => {
    if (!isCommonStockAssetType(t.asset_type_code)) return false;
    if (t.transaction_type !== "BUY" && t.transaction_type !== "SELL") return false;
    if (!t.transaction_date || t.transaction_date < cutoffDateStr) return false;
    const amtMin = parseFloat(t.amount_min);
    const amtMax = parseFloat(t.amount_max);
    if (!Number.isFinite(amtMin) || !Number.isFinite(amtMax)) return false;
    return true;
  });
}

function partyKeyOf(t) {
  return t.party === "D" || t.party === "R" ? t.party : "other";
}

function emptyPartyBucket() {
  return { buyCount: 0, sellCount: 0, buyValue: 0, sellValue: 0 };
}

function summarizeStock(symbol, meta, trades) {
  let buyValue = 0, sellValue = 0, buyCount = 0, sellCount = 0;
  const politicians = new Map(); // canonical name -> { bought, sold }
  const party = { D: emptyPartyBucket(), R: emptyPartyBucket(), other: emptyPartyBucket() };

  for (const t of trades) {
    const mid = (parseFloat(t.amount_min) + parseFloat(t.amount_max)) / 2;
    const name = t.politician_canonical || t.politician || "Unknown";
    if (!politicians.has(name)) politicians.set(name, { bought: false, sold: false });
    const p = politicians.get(name);
    const pk = partyKeyOf(t);

    if (t.transaction_type === "BUY") {
      buyValue += mid; buyCount += 1;
      p.bought = true;
      party[pk].buyCount += 1; party[pk].buyValue += mid;
    } else {
      sellValue += mid; sellCount += 1;
      p.sold = true;
      party[pk].sellCount += 1; party[pk].sellValue += mid;
    }
  }

  let buysOnlyCount = 0, sellsOnlyCount = 0, bothCount = 0, buyerCount = 0;
  for (const p of politicians.values()) {
    if (p.bought) buyerCount += 1;
    if (p.bought && p.sold) bothCount += 1;
    else if (p.bought) buysOnlyCount += 1;
    else sellsOnlyCount += 1;
  }

  return {
    symbol,
    name: meta ? meta.name : symbol,
    sector: meta ? meta.sector : null,
    buyValue, sellValue, buyCount, sellCount,
    distinctPoliticians: politicians.size,
    buysOnlyCount, sellsOnlyCount, bothCount,
    // Cluster buying: 2+ distinct politicians bought in the window with
    // zero politicians selling — same shape as scheduled-insider-
    // transactions-background.js's own clusterBuy screen.
    clusterBuy: buyerCount >= 2 && sellCount === 0,
    party,
  };
}

exports.handler = async () => {
  console.log(`scheduled-congressional-trading-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const now = new Date();
    const asOfDateStr = toDateStr(now);
    const cutoffDateStr = toDateStr(new Date(now.getTime() - WINDOW_DAYS * 86400000));

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let relativeStrengthBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relativeStrengthBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-congressional-trading-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relativeStrengthBySymbol).length > 0;

    const summaries = new Map();

    async function fetchOne(symbol) {
      const raw = await fetchCongressTrades(apiKey, symbol);
      const qualifying = qualifyingTrades(raw, cutoffDateStr);
      summaries.set(symbol, summarizeStock(symbol, metaTickers[symbol], qualifying));
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-congressional-trading-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        try {
          await fetchOne(symbol);
        } catch (err) {
          console.error(`scheduled-congressional-trading-background: ${symbol} failed: ${err.message}`);
          if (/rate limit|per minute|per day|frequency/i.test(err.message)) await sleep(20000);
          missed.push(symbol);
          await sleep(1050);
          continue;
        }
        await sleep(1050);
      }
      todo = missed;
    }

    console.log(`scheduled-congressional-trading-background: fetched ${summaries.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (summaries.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const allStocks = [...summaries.values()];
    const active = allStocks.filter((s) => s.buyCount > 0 || s.sellCount > 0);

    const sectorMap = new Map();
    for (const s of active) {
      if (!s.sector) continue;
      if (!sectorMap.has(s.sector)) sectorMap.set(s.sector, []);
      sectorMap.get(s.sector).push(s);
    }
    const sectors = SECTOR_ORDER
      .map((sector) => {
        const stocks = sectorMap.get(sector);
        if (!stocks || !stocks.length) return null;
        const buyValue = stocks.reduce((sum, s) => sum + s.buyValue, 0);
        const sellValue = stocks.reduce((sum, s) => sum + s.sellValue, 0);
        return {
          sector,
          stockCount: stocks.length,
          buyValue: round(buyValue),
          sellValue: round(sellValue),
          netValue: round(buyValue - sellValue),
          buyCount: stocks.reduce((sum, s) => sum + s.buyCount, 0),
          sellCount: stocks.reduce((sum, s) => sum + s.sellCount, 0),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.netValue - a.netValue);

    const marketBuyValue = active.reduce((sum, s) => sum + s.buyValue, 0);
    const marketSellValue = active.reduce((sum, s) => sum + s.sellValue, 0);
    // A true market-wide distinct-politician count would require re-walking
    // every company's raw trade list (politician identity isn't retained
    // per-stock past the aggregate above) — not worth the extra memory for
    // a page whose real unit of analysis is the company, not the politician.
    // The market stat row instead reports total qualifying trades and
    // companies with activity.

    const partyTotals = { D: emptyPartyBucket(), R: emptyPartyBucket(), other: emptyPartyBucket() };
    for (const s of active) {
      for (const key of Object.keys(partyTotals)) {
        partyTotals[key].buyCount += s.party[key].buyCount;
        partyTotals[key].sellCount += s.party[key].sellCount;
        partyTotals[key].buyValue += s.party[key].buyValue;
        partyTotals[key].sellValue += s.party[key].sellValue;
      }
    }
    for (const key of Object.keys(partyTotals)) {
      partyTotals[key].buyValue = round(partyTotals[key].buyValue);
      partyTotals[key].sellValue = round(partyTotals[key].sellValue);
    }

    const market = {
      buyValue: round(marketBuyValue),
      sellValue: round(marketSellValue),
      netValue: round(marketBuyValue - marketSellValue),
      buyCount: active.reduce((sum, s) => sum + s.buyCount, 0),
      sellCount: active.reduce((sum, s) => sum + s.sellCount, 0),
      companiesWithActivity: active.length,
      companiesNetBuying: active.filter((s) => s.buyValue > s.sellValue).length,
      companiesNetSelling: active.filter((s) => s.sellValue > s.buyValue).length,
      clusterBuyCount: active.filter((s) => s.clusterBuy).length,
      withPriceData: active.filter((s) => Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, s.symbol) && relativeStrengthBySymbol[s.symbol] !== null).length,
    };

    const stocks = active.map((s) => {
      const relPrice3M = Object.prototype.hasOwnProperty.call(relativeStrengthBySymbol, s.symbol)
        ? relativeStrengthBySymbol[s.symbol]
        : null;
      const totalValue = s.buyValue + s.sellValue;
      const totalCount = s.buyCount + s.sellCount;
      const netFlowRatio = totalCount >= MIN_TRADES_FOR_RATIO && totalValue > 0
        ? round((s.buyValue - s.sellValue) / totalValue, 4)
        : null;
      return {
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        buyValue: round(s.buyValue),
        sellValue: round(s.sellValue),
        netValue: round(s.buyValue - s.sellValue),
        buyCount: s.buyCount,
        sellCount: s.sellCount,
        distinctPoliticians: s.distinctPoliticians,
        buysOnlyCount: s.buysOnlyCount,
        sellsOnlyCount: s.sellsOnlyCount,
        bothCount: s.bothCount,
        clusterBuy: s.clusterBuy,
        party: {
          D: { buyCount: s.party.D.buyCount, sellCount: s.party.D.sellCount, buyValue: round(s.party.D.buyValue), sellValue: round(s.party.D.sellValue) },
          R: { buyCount: s.party.R.buyCount, sellCount: s.party.R.sellCount, buyValue: round(s.party.R.buyValue), sellValue: round(s.party.R.sellValue) },
          other: { buyCount: s.party.other.buyCount, sellCount: s.party.other.sellCount, buyValue: round(s.party.other.buyValue), sellValue: round(s.party.other.sellValue) },
        },
        netFlowRatio,
        relPrice3M,
      };
    }).sort((a, b) => b.netValue - a.netValue);

    const largestNetBuy = [...stocks].sort((a, b) => b.netValue - a.netValue).slice(0, LEADERBOARD_COUNT);
    const largestNetSell = [...stocks].sort((a, b) => a.netValue - b.netValue).slice(0, LEADERBOARD_COUNT);
    const mostActive = [...stocks].sort((a, b) => b.distinctPoliticians - a.distinctPoliticians || (b.buyCount + b.sellCount) - (a.buyCount + a.sellCount)).slice(0, LEADERBOARD_COUNT);

    const returnRegressionPairs = stocks
      .filter((s) => s.netFlowRatio !== null && s.relPrice3M !== null)
      .map((s) => ({ x: s.netFlowRatio, y: s.relPrice3M, symbol: s.symbol }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: asOfDateStr,
      windowDays: WINDOW_DAYS,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: summaries.size,
      hasPriceData,
      minTradesForRatio: MIN_TRADES_FOR_RATIO,
      market,
      sectors,
      partyTotals,
      largestNetBuy,
      largestNetSell,
      mostActive,
      returnRegressionPairs,
      stocks,
    };

    const store = getCongressionalTradingStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-congressional-trading-background: wrote ${active.length} active stocks across ${sectors.length} sectors to blob, hasPriceData=${hasPriceData}`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, stocks: active.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-congressional-trading-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
