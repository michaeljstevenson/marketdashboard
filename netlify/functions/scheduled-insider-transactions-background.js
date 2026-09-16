// Scheduled Background Function (see [functions."scheduled-insider-transactions-background"]
// in netlify.toml) that sweeps Alpha Vantage's INSIDER_TRANSACTIONS
// (Form 4 filings — officers, directors, and 10%+ owners) across the full
// S&P 500 (reusing BREADTH_CONSTITUENTS, the same list Market Breadth,
// Sector Beeswarm, and Concentration History already sweep) and computes
// trailing-90-day open-market-style buy/sell $ volume, per stock and
// pooled per sector. Writes the result to Netlify Blobs for
// insider-transactions.js to serve.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob (scheduled-beeswarm-meta-background.js) rather than
// paying for a second ~503-call OVERVIEW sweep just for labels.
//
// Weekly, not daily: a single company's insider filings are sparse events
// (a handful a month is typical even for a large S&P 500 name), so a
// trailing-90-day aggregate barely moves day to day. Scheduled well after
// scheduled-beeswarm-meta-background (needs its blob) and
// scheduled-concentration-history-background (same Saturday morning
// block) so none compete for Alpha Vantage's rate limit.
//
// ~503 sequential calls, 1050ms apart with a retry pass — same pacing
// proven at this exact scale by scheduled-beeswarm-meta-background.js's
// OVERVIEW sweep.
//
// Signal-quality filtering (see the page's own methodology section for
// the full rationale): Alpha Vantage's feed reports every Form 4 line
// item, which is dominated by routine equity-compensation mechanics —
// RSU vesting, option exercises, and the automatic tax-withholding sales
// that immediately follow them — none of which reflect a discretionary
// buy/sell decision. This job keeps only security_type "Common Stock"
// transactions with a real, positive share_price (RSU vesting and stock
// awards report a blank/zero price), which discards most — but, being
// honest about the limitation, not all — of that noise: a pre-scheduled
// 10b5-1 plan sale still reports a normal share price and passes this
// filter indistinguishably from a discretionary open-market sale.

const { getInsiderStore, BLOB_KEY } = require("./insider-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const WINDOW_DAYS = 90;
const NOTABLE_COUNT = 15;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchInsiderTransactions(apiKey, symbol, fromDateStr) {
  await recordAvCall();
  const res = await fetch(
    `${ALPHA_VANTAGE_URL}?function=INSIDER_TRANSACTIONS&symbol=${symbol}&from_date=${fromDateStr}&apikey=${apiKey}`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error || payload["Error Message"]) {
    throw new Error(payload.Note || payload.Information || payload["Error Message"] || JSON.stringify(payload.error));
  }
  if (!Array.isArray(payload.data)) {
    throw new Error(`unexpected response shape: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  return payload.data;
}

// Keeps only priced, qualifying-window Common Stock transactions — see the
// file header for why (excludes options, RSUs, and unpriced stock awards).
function qualifyingTransactions(raw, cutoffDateStr) {
  return raw.filter((t) => {
    if (t.security_type !== "Common Stock") return false;
    if (!t.transaction_date || t.transaction_date < cutoffDateStr) return false;
    const shares = parseFloat(t.shares);
    const price = parseFloat(t.share_price);
    if (!Number.isFinite(shares) || shares <= 0) return false;
    if (!Number.isFinite(price) || price <= 0) return false;
    return t.acquisition_or_disposal === "A" || t.acquisition_or_disposal === "D";
  });
}

function summarizeStock(symbol, meta, transactions) {
  let buyValue = 0, sellValue = 0, buyCount = 0, sellCount = 0;
  const buyers = new Set(), sellers = new Set();
  const priced = [];

  for (const t of transactions) {
    const shares = parseFloat(t.shares);
    const price = parseFloat(t.share_price);
    const value = shares * price;
    const record = {
      symbol,
      name: meta ? meta.name : symbol,
      sector: meta ? meta.sector : null,
      executive: t.executive || "",
      title: t.executive_title || "",
      date: t.transaction_date,
      shares,
      price,
      value,
    };
    if (t.acquisition_or_disposal === "A") {
      buyValue += value; buyCount++; buyers.add(t.executive);
      priced.push({ ...record, side: "buy" });
    } else {
      sellValue += value; sellCount++; sellers.add(t.executive);
      priced.push({ ...record, side: "sell" });
    }
  }

  return {
    symbol,
    name: meta ? meta.name : symbol,
    sector: meta ? meta.sector : null,
    buyValue, sellValue, buyCount, sellCount,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    // Cluster buying: multiple distinct insiders bought on the open
    // market with zero offsetting sales in the same window — a stronger,
    // less ambiguous signal than a single officer's purchase (still
    // subject to the 10b5-1-plan caveat above, but the "zero sellers"
    // condition at least rules out routine net-diversification activity).
    clusterBuy: buyers.size >= 2 && sellCount === 0,
    priced,
  };
}

function round2(v) {
  return v === null || v === undefined ? null : Math.round(v * 100) / 100;
}

exports.handler = async () => {
  console.log(`scheduled-insider-transactions-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const now = new Date();
    const asOfDateStr = toDateStr(now);
    const cutoffDateStr = toDateStr(new Date(now.getTime() - WINDOW_DAYS * 86400000));
    // Pull a few extra days ahead of the window so the exact 90-day cutoff
    // applied in qualifyingTransactions() isn't at the mercy of Alpha
    // Vantage's own from_date boundary semantics.
    const fetchFromDateStr = toDateStr(new Date(now.getTime() - (WINDOW_DAYS + 10) * 86400000));

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    const summaries = new Map();

    async function fetchOne(symbol) {
      const raw = await fetchInsiderTransactions(apiKey, symbol, fetchFromDateStr);
      const qualifying = qualifyingTransactions(raw, cutoffDateStr);
      summaries.set(symbol, summarizeStock(symbol, metaTickers[symbol], qualifying));
    }

    // 1050ms spacing across ~503 sequential calls, same pacing proven
    // safe at this exact scale by scheduled-beeswarm-meta-background.js.
    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-insider-transactions-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        try {
          await fetchOne(symbol);
        } catch (err) {
          console.error(`scheduled-insider-transactions-background: ${symbol} failed: ${err.message}`);
          if (/rate limit|per minute|invalid api call|unexpected response shape/i.test(err.message)) await sleep(20000);
          missed.push(symbol);
          await sleep(1050);
          continue;
        }
        await sleep(1050);
      }
      todo = missed;
    }

    console.log(`scheduled-insider-transactions-background: fetched ${summaries.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (summaries.size === 0) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const allStocks = [...summaries.values()];
    const active = allStocks.filter((s) => s.buyCount > 0 || s.sellCount > 0);

    const sectorMap = new Map();
    for (const s of active) {
      if (!s.sector) continue;
      if (!sectorMap.has(s.sector)) sectorMap.set(s.sector, []);
      sectorMap.get(s.sector).push(s);
    }
    const sectors = [...sectorMap.entries()].map(([sector, stocks]) => {
      const buyValue = stocks.reduce((sum, s) => sum + s.buyValue, 0);
      const sellValue = stocks.reduce((sum, s) => sum + s.sellValue, 0);
      return {
        sector,
        stockCount: stocks.length,
        buyValue: round2(buyValue),
        sellValue: round2(sellValue),
        netValue: round2(buyValue - sellValue),
        buyCount: stocks.reduce((sum, s) => sum + s.buyCount, 0),
        sellCount: stocks.reduce((sum, s) => sum + s.sellCount, 0),
      };
    }).sort((a, b) => b.netValue - a.netValue);

    const marketBuyValue = active.reduce((sum, s) => sum + s.buyValue, 0);
    const marketSellValue = active.reduce((sum, s) => sum + s.sellValue, 0);
    const market = {
      buyValue: round2(marketBuyValue),
      sellValue: round2(marketSellValue),
      netValue: round2(marketBuyValue - marketSellValue),
      buyCount: active.reduce((sum, s) => sum + s.buyCount, 0),
      sellCount: active.reduce((sum, s) => sum + s.sellCount, 0),
      companiesWithActivity: active.length,
      companiesNetBuying: active.filter((s) => s.buyValue > s.sellValue).length,
      companiesNetSelling: active.filter((s) => s.sellValue > s.buyValue).length,
      clusterBuyCount: active.filter((s) => s.clusterBuy).length,
    };

    const allPriced = active.flatMap((s) => s.priced);
    const notableBuys = allPriced
      .filter((t) => t.side === "buy")
      .sort((a, b) => b.value - a.value)
      .slice(0, NOTABLE_COUNT)
      .map((t) => ({ ...t, value: round2(t.value), price: round2(t.price) }));
    const notableSells = allPriced
      .filter((t) => t.side === "sell")
      .sort((a, b) => b.value - a.value)
      .slice(0, NOTABLE_COUNT)
      .map((t) => ({ ...t, value: round2(t.value), price: round2(t.price) }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: asOfDateStr,
      windowDays: WINDOW_DAYS,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: summaries.size,
      market,
      sectors,
      stocks: active.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        buyValue: round2(s.buyValue),
        sellValue: round2(s.sellValue),
        netValue: round2(s.buyValue - s.sellValue),
        buyCount: s.buyCount,
        sellCount: s.sellCount,
        uniqueBuyers: s.uniqueBuyers,
        uniqueSellers: s.uniqueSellers,
        clusterBuy: s.clusterBuy,
      })).sort((a, b) => b.netValue - a.netValue),
      notableBuys,
      notableSells,
    };

    const store = getInsiderStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-insider-transactions-background: wrote ${active.length} active stocks across ${sectors.length} sectors to blob`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, stocks: active.length, sectors: sectors.length }) };
  } catch (err) {
    console.error(`scheduled-insider-transactions-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
