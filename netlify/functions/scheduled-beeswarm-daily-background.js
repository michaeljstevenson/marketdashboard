// Scheduled Background Function (see netlify.toml) that captures the
// end-of-day sector-beeswarm snapshot: every S&P 500 constituent's
// close-to-close return for the session that just ended, joined with the
// per-company metadata (sector, shares outstanding) from
// scheduled-beeswarm-meta-background.js, plus SPY as the benchmark line.
//
// Writes one small blob per trading day (day/<YYYY-MM-DD>.json) and appends
// the date to day-index.json. The page reads one day at a time. There is
// no historical backfill — the archive starts the day this ships and grows
// forward. The 15-year historical view uses sector ETFs at annual
// resolution instead (scheduled-beeswarm-annual-background.js).
//
// ~504 GLOBAL_QUOTE calls (503 constituents + SPY), batched 5-at-a-time
// with a pause to hold sustained throughput just under Alpha Vantage's
// 75-calls/minute cap — same shape as scheduled-daychange-background.js.
// ~7 minutes per run, hence the Background Function. entitlement=delayed
// because this account's plan doesn't include realtime quotes; a run at
// ~4:35pm ET reads the settled 4:00pm close through the 15-minute delay.

const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { getBeeswarmStore, META_KEY, DAY_INDEX_KEY, dayKey } = require("./beeswarm-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const MAX_DAYS_KEPT = 400; // ~18 months of trading days

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(params, attempt = 1) {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  await recordAvCall();
  const res = await fetch(`${ALPHA_VANTAGE_URL}?${params}&apikey=${apiKey}`);
  const payload = res.ok ? await res.json() : null;
  const isRateLimited = !res.ok || !payload || payload.error || payload.Note || payload.Information;
  if (isRateLimited) {
    if (attempt < 2) {
      await sleep(1000);
      return fetchJson(params, attempt + 1);
    }
    throw new Error(
      `Alpha Vantage error for ${params}: ` +
        (payload ? payload.Note || payload.Information || JSON.stringify(payload).slice(0, 150) : `HTTP ${res.status}`)
    );
  }
  return payload;
}

async function fetchQuote(symbol) {
  const payload = await fetchJson(`function=GLOBAL_QUOTE&symbol=${symbol}&entitlement=delayed`);
  const quoteKey = Object.keys(payload).find((k) => k.startsWith("Global Quote"));
  const quote = quoteKey && payload[quoteKey];
  const price = quote && parseFloat(quote["05. price"]);
  const prevClose = quote && parseFloat(quote["08. previous close"]);
  const tradingDay = quote && quote["07. latest trading day"];
  if (!quote || !Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose === 0) {
    throw new Error(`Incomplete GLOBAL_QUOTE for ${symbol}`);
  }
  return { symbol, price, ret: Math.round((price / prevClose - 1) * 10000) / 100, tradingDay };
}

async function batched(tasks, batchSize, delayMs) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const settled = await Promise.allSettled(tasks.slice(i, i + batchSize).map((t) => t()));
    results.push(...settled);
    if (i + batchSize < tasks.length) await sleep(delayMs);
  }
  return results;
}

exports.handler = async () => {
  console.log(`scheduled-beeswarm-daily-background: starting, ${BREADTH_CONSTITUENTS.length} + SPY`);
  try {
    if (!process.env.ALPHAVANTAGE_API_KEY) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const store = getBeeswarmStore();
    const meta = (await store.get(META_KEY, { type: "json" })) || { tickers: {} };
    if (!Object.keys(meta.tickers).length) {
      throw new Error("meta.json is empty — scheduled-beeswarm-meta-background must run first");
    }

    const symbols = [...BREADTH_CONSTITUENTS, "SPY"];
    const settled = await batched(symbols.map((s) => () => fetchQuote(s)), 5, 4200);

    const quotes = new Map();
    let failures = 0;
    settled.forEach((r) => (r.status === "fulfilled" ? quotes.set(r.value.symbol, r.value) : failures++));
    if (failures) console.error(`scheduled-beeswarm-daily-background: ${failures} quote(s) failed`);

    const spy = quotes.get("SPY");
    if (!spy) throw new Error("SPY quote failed — cannot anchor the benchmark line");

    // Trust the majority trading day from the quotes rather than the
    // wall clock (avoids a UTC-vs-ET date-boundary or holiday mislabel).
    const dayVotes = {};
    for (const q of quotes.values()) if (q.tradingDay) dayVotes[q.tradingDay] = (dayVotes[q.tradingDay] || 0) + 1;
    const date = Object.entries(dayVotes).sort((a, b) => b[1] - a[1])[0][0];

    const stocks = [];
    let sectorless = 0;
    for (const symbol of BREADTH_CONSTITUENTS) {
      const q = quotes.get(symbol);
      const m = meta.tickers[symbol];
      if (!q || !m) continue;
      if (!m.sector) {
        sectorless++;
        continue; // no column to place it in
      }
      const mcap = m.sharesOutstanding ? m.sharesOutstanding * q.price : m.marketCap || null;
      stocks.push({
        t: symbol,
        name: m.name,
        sector: m.sector,
        ret: q.ret,
        mcap: mcap ? Math.round(mcap / 1e6) : null, // store in $M
      });
    }
    if (stocks.length < 300) throw new Error(`Only ${stocks.length} stocks resolved — refusing to write a thin snapshot`);

    const payload = {
      date,
      generated_at_utc: new Date().toISOString(),
      spyReturn: spy.ret,
      count: stocks.length,
      sectorless,
      stocks,
    };
    await store.setJSON(dayKey(date), payload);

    const index = (await store.get(DAY_INDEX_KEY, { type: "json" })) || { dates: [] };
    const dates = Array.from(new Set([...(index.dates || []), date])).sort();
    const trimmed = dates.slice(-MAX_DAYS_KEPT);
    await store.setJSON(DAY_INDEX_KEY, { generated_at_utc: new Date().toISOString(), dates: trimmed });

    console.log(`scheduled-beeswarm-daily-background: wrote ${date} (${stocks.length} stocks, ${sectorless} sectorless), index has ${trimmed.length}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, date, stocks: stocks.length }) };
  } catch (err) {
    console.error(`scheduled-beeswarm-daily-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
