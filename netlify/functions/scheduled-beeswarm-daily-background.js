// Scheduled Background Function (see netlify.toml) that captures the
// intraday sector-beeswarm for the session that just ended: every S&P 500
// constituent's return-since-prior-close at each 15-minute mark through the
// trading day (09:30 -> 15:45 ET), joined with per-company metadata
// (sector, shares outstanding) from scheduled-beeswarm-meta-background.js,
// plus SPY as the benchmark line. The page animates through the marks so
// the bubbles drift the way they did during the real session.
//
// Writes one blob per trading day (day/<YYYY-MM-DD>.json) and appends the
// date to day-index.json. No historical backfill beyond what Alpha
// Vantage's compact intraday window still holds (~3-4 sessions); the
// archive grows forward. The 15-year historical view is sector-ETF /
// annual (scheduled-beeswarm-annual-background.js).
//
// ~504 TIME_SERIES_INTRADAY calls (503 constituents + SPY), batched
// 5-at-a-time to hold sustained throughput just under Alpha Vantage's
// 75-calls/minute cap — same shape as scheduled-daychange-background.js.
// ~7 minutes per run, hence the Background Function. entitlement=delayed
// because this account's plan doesn't include realtime data; a run well
// after the close reads the full settled session through the 15-min delay.

const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { getBeeswarmStore, META_KEY, DAY_INDEX_KEY, dayKey } = require("./beeswarm-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const MAX_DAYS_KEPT = 400;
const INTERVAL = "15min";

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

// -> { symbol, byDate: { "YYYY-MM-DD": [{ time:"HH:MM", close }] asc } }
async function fetchIntraday(symbol) {
  const payload = await fetchJson(
    `function=TIME_SERIES_INTRADAY&symbol=${symbol}&interval=${INTERVAL}&outputsize=compact&extended_hours=false&entitlement=delayed`
  );
  const seriesKey = Object.keys(payload).find((k) => k.startsWith("Time Series"));
  const series = seriesKey && payload[seriesKey];
  if (!series || !Object.keys(series).length) {
    throw new Error(`No intraday series for ${symbol}`);
  }
  const byDate = {};
  for (const [ts, bar] of Object.entries(series)) {
    const close = parseFloat(bar["4. close"]);
    if (!Number.isFinite(close)) continue;
    const date = ts.slice(0, 10);
    const time = ts.slice(11, 16);
    (byDate[date] || (byDate[date] = [])).push({ time, close });
  }
  for (const d of Object.keys(byDate)) byDate[d].sort((a, b) => (a.time < b.time ? -1 : 1));
  return { symbol, byDate };
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

const pct = (v) => Math.round(v * 10000) / 100;

exports.handler = async () => {
  console.log(`scheduled-beeswarm-daily-background: starting, ${BREADTH_CONSTITUENTS.length} + SPY (intraday ${INTERVAL})`);
  try {
    if (!process.env.ALPHAVANTAGE_API_KEY) throw new Error("ALPHAVANTAGE_API_KEY is not set");

    const store = getBeeswarmStore();
    const meta = (await store.get(META_KEY, { type: "json" })) || { tickers: {} };
    if (!Object.keys(meta.tickers).length) {
      throw new Error("meta.json is empty — scheduled-beeswarm-meta-background must run first");
    }

    const symbols = [...BREADTH_CONSTITUENTS, "SPY"];
    const settled = await batched(symbols.map((s) => () => fetchIntraday(s)), 5, 4200);

    const bars = new Map();
    let failures = 0;
    settled.forEach((r) => (r.status === "fulfilled" ? bars.set(r.value.symbol, r.value.byDate) : failures++));
    if (failures) console.error(`scheduled-beeswarm-daily-background: ${failures} intraday fetch(es) failed`);

    const spyByDate = bars.get("SPY");
    if (!spyByDate) throw new Error("SPY intraday failed — cannot anchor the session");

    // SPY defines the session: its most recent date, and the trading day before it.
    const spyDates = Object.keys(spyByDate).sort();
    const date = spyDates[spyDates.length - 1];
    const priorDate = spyDates[spyDates.length - 2];
    const times = spyByDate[date].map((b) => b.time); // canonical 09:30..15:45

    // return series for one symbol, aligned to `times`, vs its prior-session close
    function retSeries(byDate) {
      if (!byDate || !byDate[date]) return null;
      const prior = byDate[priorDate];
      const base = prior && prior.length ? prior[prior.length - 1].close : byDate[date][0].close;
      if (!base) return null;
      const closeAt = {};
      for (const b of byDate[date]) closeAt[b.time] = b.close;
      const out = [];
      let last = null;
      for (const t of times) {
        if (closeAt[t] != null) last = closeAt[t];
        out.push(last == null ? null : pct(last / base - 1));
      }
      // backfill any leading nulls with the first real value
      const firstReal = out.find((v) => v != null);
      return out.map((v) => (v == null ? firstReal ?? 0 : v));
    }

    const spy = retSeries(spyByDate);
    if (!spy) throw new Error(`SPY has no bars for ${date}`);

    const stocks = [];
    let sectorless = 0;
    for (const symbol of BREADTH_CONSTITUENTS) {
      const m = meta.tickers[symbol];
      const byDate = bars.get(symbol);
      if (!m || !byDate) continue;
      if (!m.sector) {
        sectorless++;
        continue;
      }
      const r = retSeries(byDate);
      if (!r) continue;
      const lastClose = byDate[date][byDate[date].length - 1].close;
      const mcap = m.sharesOutstanding ? m.sharesOutstanding * lastClose : m.marketCap || null;
      stocks.push({
        t: symbol,
        name: m.name,
        sector: m.sector,
        mcap: mcap ? Math.round(mcap / 1e6) : null, // $M
        r, // return at each mark in `times`
      });
    }
    if (stocks.length < 300) throw new Error(`Only ${stocks.length} stocks resolved — refusing to write a thin snapshot`);

    const payload = {
      date,
      generated_at_utc: new Date().toISOString(),
      interval: INTERVAL,
      times,
      spy,
      count: stocks.length,
      sectorless,
      stocks,
    };
    await store.setJSON(dayKey(date), payload);

    const index = (await store.get(DAY_INDEX_KEY, { type: "json" })) || { dates: [] };
    const dates = Array.from(new Set([...(index.dates || []), date])).sort();
    const trimmed = dates.slice(-MAX_DAYS_KEPT);
    await store.setJSON(DAY_INDEX_KEY, { generated_at_utc: new Date().toISOString(), dates: trimmed });

    console.log(
      `scheduled-beeswarm-daily-background: wrote ${date} — ${stocks.length} stocks x ${times.length} marks (${sectorless} sectorless), index has ${trimmed.length}`
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true, date, stocks: stocks.length, marks: times.length }) };
  } catch (err) {
    console.error(`scheduled-beeswarm-daily-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
