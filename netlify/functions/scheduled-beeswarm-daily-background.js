// Scheduled Background Function (see netlify.toml) that captures the
// intraday sector-beeswarm for the session that just ended: every S&P 500
// constituent's return-since-prior-close at each 15-minute mark through the
// trading day (09:30 -> 15:45 ET), joined with per-company metadata
// (sector, shares outstanding) from scheduled-beeswarm-meta-background.js,
// plus SPY as the benchmark line. The page animates through the marks so
// the bubbles drift the way they did during the real session.
//
// Writes one blob per trading day (day/<YYYY-MM-DD>.json) and appends the
// date to day-index.json. No historical backfill beyond the last few
// sessions Yahoo's 5-day intraday window holds; the archive grows forward.
// The 15-year historical view is sector-ETF / annual
// (scheduled-beeswarm-annual-background.js).
//
// 15-minute bars come from Yahoo Finance's batched spark endpoint, 20
// symbols per call (see yahoo-client.js), so the whole run is about 26
// calls (503 constituents + SPY) instead of one call per stock.

const { BREADTH_CONSTITUENTS } = require("./breadth-constituents");
const { getBeeswarmStore, META_KEY, DAY_INDEX_KEY, dayKey } = require("./beeswarm-blob-store");
const { fetchIntradayBatch } = require("./yahoo-client");

const MAX_DAYS_KEPT = 400;
const INTERVAL = "15min";

const pct = (v) => Math.round(v * 10000) / 100;

exports.handler = async () => {
  console.log(`scheduled-beeswarm-daily-background: starting, ${BREADTH_CONSTITUENTS.length} + SPY (intraday ${INTERVAL})`);
  try {
    const store = getBeeswarmStore();
    const meta = (await store.get(META_KEY, { type: "json" })) || { tickers: {} };
    if (!Object.keys(meta.tickers).length) {
      throw new Error("meta.json is empty: scheduled-beeswarm-meta-background must run first");
    }

    const symbols = [...BREADTH_CONSTITUENTS, "SPY"];
    const bars = await fetchIntradayBatch(symbols);
    const failures = symbols.length - bars.size;
    if (failures) console.error(`scheduled-beeswarm-daily-background: ${failures} symbol(s) returned no intraday bars`);

    const spyByDate = bars.get("SPY");
    if (!spyByDate) throw new Error("SPY intraday failed, cannot anchor the session");

    // SPY defines the session: its most recent date, and the trading day before it.
    const spyDates = Object.keys(spyByDate).sort();
    const date = spyDates[spyDates.length - 1];
    const priorDate = spyDates[spyDates.length - 2];
    // canonical 09:30..15:45; Yahoo also reports a 16:00 closing-auction bar
    const times = spyByDate[date].map((b) => b.time).filter((t) => t < "16:00");

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
    if (stocks.length < 300) throw new Error(`Only ${stocks.length} stocks resolved. Refusing to write a thin snapshot`);

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
      `scheduled-beeswarm-daily-background: wrote ${date}: ${stocks.length} stocks x ${times.length} marks (${sectorless} sectorless), index has ${trimmed.length}`
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true, date, stocks: stocks.length, marks: times.length }) };
  } catch (err) {
    console.error(`scheduled-beeswarm-daily-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
