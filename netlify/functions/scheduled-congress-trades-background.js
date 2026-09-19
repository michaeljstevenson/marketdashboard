// Scheduled Background Function (see
// [functions."scheduled-congress-trades-background"] in netlify.toml)
// that sweeps Alpha Vantage's CONGRESS_TRADES (STOCK Act Periodic
// Transaction Report disclosures) across the full S&P 500 (reusing
// BREADTH_CONSTITUENTS) and computes trailing-24-month net buy/sell
// activity — per stock, per sector, and by party/chamber — plus a
// disclosure-lag compliance stat and a test of whether stocks with net
// congressional buying actually go on to outperform.
//
// One-time snapshot, no recurring schedule — same convention as this
// repo's other new-this-week Equities pages (see commit 704645f). Can be
// re-run manually (Netlify dashboard "Run now") for a fresh pass.
//
// CONGRESS_TRADES takes no date-range parameter (unlike
// INSIDER_TRANSACTIONS' from_date) — it always returns a ticker's full
// disclosed history, filtered here to the trailing window client-side.
// That's fine at this scale (a popular ticker tops out in the low
// hundreds of disclosed trades since 2012, trivial to filter in memory)
// but does mean this job's own request payloads are bigger than most of
// this file's other single-endpoint sweeps.
//
// Reuses company name/sector from the Sector Beeswarm page's own weekly
// meta.json blob, same convention as every other full-universe job on
// this site, and reuses Relative Strength Leaders/Laggards' own
// latest.json for 3-month relative price performance (real cross-page
// dependency, not a coincidence — avoids a second ~503-call price sweep
// just for this page's one stats test).
//
// ~503 sequential calls, 1050ms apart with a retry pass — same pacing
// proven at this exact scale by scheduled-beeswarm-meta-background.js
// and scheduled-insider-transactions-background.js.

const { getCongressTradesStore, BLOB_KEY } = require("./congress-trades-blob-store");
const { getBeeswarmStore, META_KEY } = require("./beeswarm-blob-store");
const { getRelativeStrengthStore, LATEST_KEY: RS_LATEST_KEY } = require("./relative-strength-blob-store");
const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { SECTOR_ORDER } = require("./beeswarm-sectors");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const WINDOW_DAYS = 730; // trailing 24 months — congressional trades in any one stock are sparse, a 90-day window (like the insider page) would be mostly empty
const DISCLOSURE_DEADLINE_DAYS = 45; // STOCK Act Periodic Transaction Report deadline
const NOTABLE_COUNT = 15;
const LEADERBOARD_COUNT = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}
function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function round2(v) {
  return round(v, 2);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}

async function fetchCongressTrades(apiKey, symbol) {
  await recordAvCall();
  const res = await fetch(`${ALPHA_VANTAGE_URL}?function=CONGRESS_TRADES&symbol=${symbol}&apikey=${apiKey}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error) {
    throw new Error(payload.Note || payload.Information || JSON.stringify(payload.error));
  }
  return Array.isArray(payload.trades) ? payload.trades : [];
}

// Keeps only priced, in-window BUY/SELL trades on the underlying equity
// itself — excludes options and other derivatives on the same ticker
// (which still carry the equity's own symbol in this feed, distinguished
// only by asset_name) and anything outside BUY/SELL (e.g. an "EXCHANGE").
function qualifyingTrades(raw, cutoffDateStr) {
  return raw.filter((t) => {
    if (t.transaction_type !== "BUY" && t.transaction_type !== "SELL") return false;
    if (!t.transaction_date || t.transaction_date < cutoffDateStr) return false;
    if (t.asset_name && /option|warrant|bond|note\b/i.test(t.asset_name)) return false;
    const lo = parseFloat(t.amount_min);
    const hi = parseFloat(t.amount_max);
    return Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo && lo >= 0;
  });
}

function normalizeParty(p) {
  if (p === "D" || p === "R" || p === "I") return p;
  return "Other";
}
function normalizeChamber(c) {
  const v = (c || "").toUpperCase();
  return v === "HOUSE" ? "House" : v === "SENATE" ? "Senate" : "Other";
}

function summarizeStock(symbol, meta, trades) {
  let buyValue = 0, sellValue = 0, buyCount = 0, sellCount = 0;
  const buyers = new Set(), sellers = new Set();
  const priced = [];
  for (const t of trades) {
    const value = (parseFloat(t.amount_min) + parseFloat(t.amount_max)) / 2;
    const record = {
      symbol,
      name: meta ? meta.name : symbol,
      sector: meta ? meta.sector : null,
      politician: t.politician_canonical || t.politician || "Unknown",
      party: normalizeParty(t.party),
      chamber: normalizeChamber(t.chamber),
      date: t.transaction_date,
      filedDate: t.filed_date || null,
      value,
    };
    if (t.transaction_type === "BUY") {
      buyValue += value; buyCount++; buyers.add(t.bioguide_id || record.politician);
      priced.push({ ...record, side: "buy" });
    } else {
      sellValue += value; sellCount++; sellers.add(t.bioguide_id || record.politician);
      priced.push({ ...record, side: "sell" });
    }
  }
  return {
    symbol, name: meta ? meta.name : symbol, sector: meta ? meta.sector : null,
    buyValue, sellValue, buyCount, sellCount,
    uniquePoliticians: new Set([...buyers, ...sellers]).size,
    priced,
  };
}

function linearRegression(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const syy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const dof = n - 2;
  const sse = ys.reduce((s, y, i) => s + (y - (intercept + slope * xs[i])) ** 2, 0);
  const seSlope = Math.sqrt(sse / dof / sxx);
  const t = slope / seSlope;
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { n, slope: round(slope, 6), intercept: round(intercept, 4), r: round(r, 4), r2: round(r * r, 4), t: round(t, 3), p: round(p, 4) };
}
function normalCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function rankArray(arr) {
  const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && arr[idx[j + 1]] === arr[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}
function spearmanRegression(xs, ys) { return linearRegression(rankArray(xs), rankArray(ys)); }

exports.handler = async () => {
  console.log(`scheduled-congress-trades-background: starting, ${BREADTH_CONSTITUENTS.length} tickers`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const cutoffDateStr = toDateStr(new Date(Date.now() - WINDOW_DAYS * 86400000));

    const beeswarmStore = getBeeswarmStore();
    const meta = (await beeswarmStore.get(META_KEY, { type: "json" })) || { tickers: {} };
    const metaTickers = meta.tickers || {};

    let relBySymbol = {};
    try {
      const rsStore = getRelativeStrengthStore();
      const rsLatest = await rsStore.get(RS_LATEST_KEY, { type: "json" });
      if (rsLatest && Array.isArray(rsLatest.companies)) {
        for (const c of rsLatest.companies) relBySymbol[c.symbol] = c.rel3M;
      }
    } catch (err) {
      console.error("scheduled-congress-trades-background: could not read relative-strength blob, continuing without price data:", err.message);
    }
    const hasPriceData = Object.keys(relBySymbol).length > 0;

    const summaries = new Map();
    async function fetchOne(symbol) {
      const raw = await fetchCongressTrades(apiKey, symbol);
      const qualifying = qualifyingTrades(raw, cutoffDateStr);
      summaries.set(symbol, summarizeStock(symbol, metaTickers[symbol], qualifying));
    }

    let todo = [...BREADTH_CONSTITUENTS];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-congress-trades-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(65000);
      }
      const missed = [];
      for (const symbol of todo) {
        try {
          await fetchOne(symbol);
        } catch (err) {
          console.error(`scheduled-congress-trades-background: ${symbol} failed: ${err.message}`);
          if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
          missed.push(symbol);
          await sleep(1050);
          continue;
        }
        await sleep(1050);
      }
      todo = missed;
    }

    console.log(`scheduled-congress-trades-background: fetched ${summaries.size}/${BREADTH_CONSTITUENTS.length} tickers`);
    if (!summaries.size) throw new Error("Every ticker failed — refusing to write an empty snapshot");

    const allStocks = [...summaries.values()];
    const active = allStocks.filter((s) => s.buyCount > 0 || s.sellCount > 0);
    if (!active.length) throw new Error("No S&P 500 constituent had a qualifying disclosed trade in the trailing window");

    const sectorMap = new Map();
    for (const s of active) {
      if (!s.sector) continue;
      if (!sectorMap.has(s.sector)) sectorMap.set(s.sector, []);
      sectorMap.get(s.sector).push(s);
    }
    const sectors = SECTOR_ORDER.map((sector) => {
      const stocks = sectorMap.get(sector) || [];
      if (!stocks.length) return null;
      const buyValue = stocks.reduce((sum, s) => sum + s.buyValue, 0);
      const sellValue = stocks.reduce((sum, s) => sum + s.sellValue, 0);
      return {
        sector, stockCount: stocks.length,
        buyValue: round2(buyValue), sellValue: round2(sellValue), netValue: round2(buyValue - sellValue),
        buyCount: stocks.reduce((sum, s) => sum + s.buyCount, 0),
        sellCount: stocks.reduce((sum, s) => sum + s.sellCount, 0),
      };
    }).filter(Boolean);

    const allPriced = active.flatMap((s) => s.priced);

    // Party / chamber breakdown — the dimension this page has that
    // /insider-buying-selling.html doesn't (Form 4 filers have no party).
    function breakdownBy(key, labels) {
      return labels.map((label) => {
        const rows = allPriced.filter((t) => t[key] === label);
        const buys = rows.filter((t) => t.side === "buy");
        const sells = rows.filter((t) => t.side === "sell");
        const buyValue = buys.reduce((s, t) => s + t.value, 0);
        const sellValue = sells.reduce((s, t) => s + t.value, 0);
        return { label, buyValue: round2(buyValue), sellValue: round2(sellValue), netValue: round2(buyValue - sellValue), buyCount: buys.length, sellCount: sells.length };
      });
    }
    const byParty = breakdownBy("party", ["D", "R", "I", "Other"]).filter((r) => r.buyCount || r.sellCount);
    const byChamber = breakdownBy("chamber", ["House", "Senate", "Other"]).filter((r) => r.buyCount || r.sellCount);

    const marketBuyValue = active.reduce((sum, s) => sum + s.buyValue, 0);
    const marketSellValue = active.reduce((sum, s) => sum + s.sellValue, 0);
    const market = {
      buyValue: round2(marketBuyValue), sellValue: round2(marketSellValue), netValue: round2(marketBuyValue - marketSellValue),
      buyCount: active.reduce((sum, s) => sum + s.buyCount, 0),
      sellCount: active.reduce((sum, s) => sum + s.sellCount, 0),
      stocksWithActivity: active.length,
      stocksNetBuying: active.filter((s) => s.buyValue > s.sellValue).length,
      stocksNetSelling: active.filter((s) => s.sellValue > s.buyValue).length,
      uniquePoliticians: new Set(allPriced.map((t) => t.politician)).size,
    };

    // Disclosure-lag compliance stat: how promptly is the trade actually
    // reported, relative to the STOCK Act's 45-day deadline? A handful of
    // rows have an implausible or missing filed_date (filed before the
    // trade, or no filed_date at all) — excluded from this stat rather
    // than producing a negative or fabricated lag.
    const lagDays = [];
    for (const t of allPriced) {
      if (!t.filedDate || !t.date) continue;
      const lag = daysBetween(t.date, t.filedDate);
      if (Number.isFinite(lag) && lag >= 0 && lag <= 400) lagDays.push(lag);
    }
    lagDays.sort((a, b) => a - b);
    const medianLagDays = lagDays.length ? (lagDays.length % 2 ? lagDays[(lagDays.length - 1) / 2] : (lagDays[lagDays.length / 2 - 1] + lagDays[lagDays.length / 2]) / 2) : null;
    const disclosureLag = {
      n: lagDays.length,
      medianDays: medianLagDays === null ? null : round2(medianLagDays),
      pctWithinDeadline: lagDays.length ? round2((lagDays.filter((d) => d <= DISCLOSURE_DEADLINE_DAYS).length / lagDays.length) * 100) : null,
      distribution: [
        { label: "0–15 days", lo: 0, hi: 15 },
        { label: "16–30 days", lo: 16, hi: 30 },
        { label: "31–45 days", lo: 31, hi: 45 },
        { label: "46–90 days", lo: 46, hi: 90 },
        { label: "90+ days", lo: 91, hi: Infinity },
      ].map((bin) => ({ label: bin.label, count: lagDays.filter((d) => d >= bin.lo && d <= bin.hi).length })),
    };

    const notableBuys = allPriced.filter((t) => t.side === "buy").sort((a, b) => b.value - a.value).slice(0, NOTABLE_COUNT).map((t) => ({ ...t, value: round2(t.value) }));
    const notableSells = allPriced.filter((t) => t.side === "sell").sort((a, b) => b.value - a.value).slice(0, NOTABLE_COUNT).map((t) => ({ ...t, value: round2(t.value) }));

    // Most active individual members, by disclosed trade count in the window.
    const byPolitician = new Map();
    for (const t of allPriced) {
      const key = t.politician;
      if (!byPolitician.has(key)) byPolitician.set(key, { politician: key, party: t.party, chamber: t.chamber, buyValue: 0, sellValue: 0, buyCount: 0, sellCount: 0, symbols: new Set() });
      const row = byPolitician.get(key);
      row.symbols.add(t.symbol);
      if (t.side === "buy") { row.buyValue += t.value; row.buyCount++; } else { row.sellValue += t.value; row.sellCount++; }
    }
    const mostActiveMembers = [...byPolitician.values()]
      .map((r) => ({ politician: r.politician, party: r.party, chamber: r.chamber, buyValue: round2(r.buyValue), sellValue: round2(r.sellValue), tradeCount: r.buyCount + r.sellCount, symbolCount: r.symbols.size }))
      .sort((a, b) => b.tradeCount - a.tradeCount)
      .slice(0, LEADERBOARD_COUNT);

    const stocks = active.map((s) => ({
      symbol: s.symbol, name: s.name, sector: s.sector,
      buyValue: round2(s.buyValue), sellValue: round2(s.sellValue), netValue: round2(s.buyValue - s.sellValue),
      buyCount: s.buyCount, sellCount: s.sellCount, uniquePoliticians: s.uniquePoliticians,
      rel3M: hasPriceData && relBySymbol[s.symbol] !== undefined ? relBySymbol[s.symbol] : null,
    })).sort((a, b) => b.netValue - a.netValue);

    const mostBought = stocks.filter((s) => s.netValue > 0).slice(0, LEADERBOARD_COUNT);
    const mostSold = [...stocks].filter((s) => s.netValue < 0).sort((a, b) => a.netValue - b.netValue).slice(0, LEADERBOARD_COUNT);

    const regressionPairs = stocks.filter((s) => s.rel3M !== null && s.netValue !== null);
    const netValueVsPerformance = regressionPairs.length >= 10 ? {
      pearson: linearRegression(regressionPairs.map((s) => s.netValue), regressionPairs.map((s) => s.rel3M)),
      spearman: spearmanRegression(regressionPairs.map((s) => s.netValue), regressionPairs.map((s) => s.rel3M)),
    } : null;

    const payload = {
      generated_at_utc: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      universeSize: BREADTH_CONSTITUENTS.length,
      loadedCount: summaries.size,
      hasPriceData,
      market,
      sectors,
      byParty,
      byChamber,
      disclosureLag,
      stocks,
      mostBought,
      mostSold,
      mostActiveMembers,
      notableBuys,
      notableSells,
      netValueVsPerformance,
    };

    const store = getCongressTradesStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-congress-trades-background: wrote ${active.length} active stocks across ${sectors.length} sectors to blob`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, stocks: active.length }) };
  } catch (err) {
    console.error(`scheduled-congress-trades-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
