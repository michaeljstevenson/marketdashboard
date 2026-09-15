// Scheduled Background Function (see [functions."scheduled-spinoff-
// background"] in netlify.toml) that builds the dataset behind
// /spin-off-performance.html: for a hand-compiled list of corporate
// spinoff events (see EVENTS below), pulls full daily-adjusted price
// history for every spinco, every remaining-parent, and SPY, then computes
// per-leg cumulative returns and excess returns vs. SPY at fixed horizons,
// an event-time-aligned average excess-return curve, a spinco-vs-parent
// pairing for the scatter, leaderboards, and a sector breakdown. Writes the
// result to Netlify Blobs for spinoff-performance.js to serve.
//
// The event list (who spun off whom, and when) is curated from public
// record — same "hand-compiled metadata, real market data" split this site
// already uses for /expectations-vs-reality.html. Every return number here
// comes from a live Alpha Vantage TIME_SERIES_DAILY_ADJUSTED pull; nothing
// about the price data is fabricated or estimated.
//
// Weekly, not daily: this is a fixed, sparse list of ~19 historical events,
// not a live universe that changes day to day — a fresh full-history pull
// once a week is enough to keep "to-date" returns current.
//
// Only ~33 unique tickers (19 spincos + 13 unique parent tickers, several
// reused across more than one event, + SPY), so — unlike this site's full-
// S&P-500 sweeps — there's little real rate-limit risk, but a modest pace
// and a retry pass are kept anyway per this site's usual convention.

const { getSpinoffStore, BLOB_KEY } = require("./spinoff-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SPY = "SPY";
// ~3.2 years of trading days. Long enough to cover the page's 3-year fixed
// horizon with a little headroom; past this point only the oldest handful
// of events would still have data, too thin a sample to call the average
// curve meaningful (the page is transparent about N shrinking well before
// this cap is even reached — see the "n" series shipped alongside it).
const CURVE_MAX_TRADING_DAYS = 800;
const LEADER_COUNT = 5;

// Event dataset: parent ticker, spinco ticker, the spinco's first day of
// regular trading (used as the event anchor for both legs), and sector.
// Sourced from public record; verified as part of building this page.
const EVENTS = [
  { id: "kd", parent: "IBM", spinco: "KD", eventDate: "2021-11-03", sector: "Technology",
    parentLabel: "IBM", spincoLabel: "Kyndryl", hasParentLeg: true },
  { id: "ogn", parent: "MRK", spinco: "OGN", eventDate: "2021-06-02", sector: "Health Care",
    parentLabel: "Merck", spincoLabel: "Organon", hasParentLeg: true },
  { id: "vtrs", parent: "PFE", spinco: "VTRS", eventDate: "2020-11-16", sector: "Health Care",
    parentLabel: "Pfizer", spincoLabel: "Viatris", hasParentLeg: true,
    // Viatris is Pfizer's Upjohn unit combined with Mylan via a Reverse
    // Morris Trust, not a pure spinoff — kept in the dataset as a
    // "spin-merger" but footnoted on the page rather than treated as
    // identical to a clean spinoff.
    note: "Reverse Morris Trust spin-merger with Mylan, not a pure spinoff — included with a footnote." },
  { id: "otis", parent: "UTX", spinco: "OTIS", eventDate: "2020-04-03", sector: "Industrials",
    parentLabel: "United Technologies", spincoLabel: "Otis", hasParentLeg: false,
    // UTC didn't continue on as an independent public company — it merged
    // into Raytheon (becoming Raytheon Technologies / RTX) the same day it
    // spun off Otis and Carrier, so there's no clean "remaining parent"
    // price series to compute a parent leg from.
    note: "No parent leg: United Technologies merged into Raytheon Technologies (RTX) the same day." },
  { id: "carr", parent: "UTX", spinco: "CARR", eventDate: "2020-04-03", sector: "Industrials",
    parentLabel: "United Technologies", spincoLabel: "Carrier", hasParentLeg: false,
    note: "No parent leg: United Technologies merged into Raytheon Technologies (RTX) the same day." },
  { id: "dow", parent: "DD", spinco: "DOW", eventDate: "2019-04-02", sector: "Materials",
    parentLabel: "DuPont (post-split)", spincoLabel: "Dow", hasParentLeg: true,
    note: "Parent leg is DD, the renamed \"new DuPont\" that kept trading after both the Dow and Corteva spinoffs completed." },
  { id: "ctva", parent: "DD", spinco: "CTVA", eventDate: "2019-06-03", sector: "Materials",
    parentLabel: "DuPont (post-split)", spincoLabel: "Corteva", hasParentLeg: true,
    note: "Parent leg is DD, the renamed \"new DuPont\" that kept trading after both the Dow and Corteva spinoffs completed." },
  { id: "ftv", parent: "DHR", spinco: "FTV", eventDate: "2016-07-05", sector: "Industrials",
    parentLabel: "Danaher", spincoLabel: "Fortive", hasParentLeg: true },
  { id: "nvst", parent: "DHR", spinco: "NVST", eventDate: "2019-09-20", sector: "Health Care",
    parentLabel: "Danaher", spincoLabel: "Envista", hasParentLeg: true },
  { id: "vlto", parent: "DHR", spinco: "VLTO", eventDate: "2023-10-02", sector: "Industrials",
    parentLabel: "Danaher", spincoLabel: "Veralto", hasParentLeg: true },
  { id: "gehc", parent: "GE", spinco: "GEHC", eventDate: "2023-01-04", sector: "Health Care",
    parentLabel: "General Electric", spincoLabel: "GE HealthCare", hasParentLeg: true },
  { id: "gev", parent: "GE", spinco: "GEV", eventDate: "2024-04-02", sector: "Industrials/Energy",
    parentLabel: "General Electric", spincoLabel: "GE Vernova", hasParentLeg: true },
  { id: "solv", parent: "MMM", spinco: "SOLV", eventDate: "2024-04-01", sector: "Health Care",
    parentLabel: "3M", spincoLabel: "Solventum", hasParentLeg: true },
  { id: "kvue", parent: "JNJ", spinco: "KVUE", eventDate: "2023-08-23", sector: "Consumer Staples",
    parentLabel: "Johnson & Johnson", spincoLabel: "Kenvue", hasParentLeg: true,
    note: "Anchor is the exchange-offer completion date (the full separation), not the May 2023 IPO carve-out date." },
  { id: "klg", parent: "K", spinco: "KLG", eventDate: "2023-10-02", sector: "Consumer Staples",
    parentLabel: "Kellanova", spincoLabel: "WK Kellogg Co", hasParentLeg: true,
    note: "Parent ticker K kept trading, renamed Kellanova; KLG is the new spinco carrying the North American cereal business." },
  { id: "rezi", parent: "HON", spinco: "REZI", eventDate: "2018-10-29", sector: "Industrials",
    parentLabel: "Honeywell", spincoLabel: "Resideo", hasParentLeg: true },
  { id: "hpe", parent: "HPQ", spinco: "HPE", eventDate: "2015-11-02", sector: "Technology",
    parentLabel: "HP Inc.", spincoLabel: "Hewlett Packard Enterprise", hasParentLeg: true,
    note: "Both sides are technically new companies from a full split; HPQ (which kept the legacy ticker) is treated as the parent-continuation leg." },
  { id: "pypl", parent: "EBAY", spinco: "PYPL", eventDate: "2015-07-20", sector: "Financials/Technology",
    parentLabel: "eBay", spincoLabel: "PayPal", hasParentLeg: true },
  { id: "cndt", parent: "XRX", spinco: "CNDT", eventDate: "2017-01-03", sector: "Technology/Industrials",
    parentLabel: "Xerox", spincoLabel: "Conduent", hasParentLeg: true },
];

const HORIZONS = [
  { key: "sixMonth", months: 6 },
  { key: "oneYear", months: 12 },
  { key: "twoYear", months: 24 },
  { key: "threeYear", months: 36 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function pctChange(now, then) {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return null;
  return round(((now / then) - 1) * 100);
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  if (payload.Note || payload.Information || payload.error_message) {
    throw new Error(payload.Note || payload.Information || payload.error_message);
  }
  return payload;
}

// Full daily adjusted-close history -> { dates:[asc], closes:[parallel] }.
// Adjusted close so dividends are accounted for — same reasoning as
// scheduled-smallcap-background.js and scheduled-sectors-background.js.
async function fetchDailyAdjusted(apiKey, symbol) {
  const payload = await fetchJson(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${symbol}&outputsize=full&apikey=${apiKey}`
  );
  const series = payload["Time Series (Daily)"];
  if (!series) throw new Error(`TIME_SERIES_DAILY_ADJUSTED missing for ${symbol}: ${JSON.stringify(payload).slice(0, 160)}`);
  const rows = Object.entries(series)
    .map(([date, r]) => ({ date, close: parseFloat(r["5. adjusted close"]) }))
    .filter((r) => Number.isFinite(r.close))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { dates: rows.map((r) => r.date), closes: rows.map((r) => r.close) };
}

// Latest close on or before targetDate (dates ascending), plus its index —
// the index is needed here (unlike the read-only helpers elsewhere on this
// site) to walk forward day-by-day from the anchor for the event-time
// curve. Returns null only when the ticker's history doesn't reach back to
// targetDate at all (e.g. a parent ticker that didn't yet exist under its
// current symbol on an early event's anchor date) — the caller treats that
// as "drop this leg", not an error.
function closeOnOrBefore(hist, targetDate) {
  const { dates, closes } = hist;
  if (!dates.length || dates[0] > targetDate) return null;
  let lo = 0;
  let hi = dates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (dates[mid] <= targetDate) lo = mid;
    else hi = mid - 1;
  }
  return { date: dates[lo], close: closes[lo], index: lo };
}

exports.handler = async () => {
  console.log(`scheduled-spinoff-background: starting, ${EVENTS.length} events`);
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const tickers = new Set([SPY]);
    for (const e of EVENTS) {
      tickers.add(e.spinco);
      if (e.hasParentLeg) tickers.add(e.parent);
    }

    const histories = new Map();
    async function fetchInto(symbol) {
      try {
        histories.set(symbol, await fetchDailyAdjusted(apiKey, symbol));
        return true;
      } catch (err) {
        console.error(`scheduled-spinoff-background: ${symbol} failed: ${err.message}`);
        histories.delete(symbol);
        if (/rate limit|per minute/i.test(err.message)) await sleep(20000);
        return false;
      }
    }

    let todo = [...tickers];
    for (let pass = 0; pass < 2 && todo.length; pass++) {
      if (pass > 0) {
        console.log(`scheduled-spinoff-background: retry pass for ${todo.length} ticker(s)`);
        await sleep(30000);
      }
      const missed = [];
      for (const symbol of todo) {
        const got = await fetchInto(symbol);
        if (!got) missed.push(symbol);
        await sleep(900);
      }
      todo = missed;
    }
    const failedTickers = todo;

    console.log(`scheduled-spinoff-background: fetched ${histories.size}/${tickers.size} tickers`);
    const spyHist = histories.get(SPY);
    if (!spyHist) throw new Error("SPY history failed to load — can't compute any excess return without the benchmark");

    // "Now", for every leg's to-date return: the most conservative common
    // date across every ticker that did load, so no leg's to-date window
    // silently runs a few days past what some other ticker's feed covers.
    let asOfDate = spyHist.dates[spyHist.dates.length - 1];
    for (const h of histories.values()) {
      const last = h.dates[h.dates.length - 1];
      if (last < asOfDate) asOfDate = last;
    }

    const legs = [];
    const skippedLegs = [];

    function buildLeg(event, role, ticker) {
      const hist = histories.get(ticker);
      if (!hist) {
        skippedLegs.push({ eventId: event.id, role, ticker, reason: "price history failed to load this run" });
        return;
      }
      const anchor = closeOnOrBefore(hist, event.eventDate);
      if (!anchor) {
        skippedLegs.push({ eventId: event.id, role, ticker, reason: "no price history on or before the event date" });
        return;
      }
      const spyAnchor = closeOnOrBefore(spyHist, event.eventDate);
      if (!spyAnchor) {
        skippedLegs.push({ eventId: event.id, role, ticker, reason: "SPY has no price on or before the event date" });
        return;
      }
      const asOfClose = closeOnOrBefore(hist, asOfDate);
      const spyAsOfClose = closeOnOrBefore(spyHist, asOfDate);
      if (!asOfClose || !spyAsOfClose) {
        skippedLegs.push({ eventId: event.id, role, ticker, reason: "no price history on the common as-of date" });
        return;
      }

      const returns = { toDate: pctChange(asOfClose.close, anchor.close) };
      const spyReturns = { toDate: pctChange(spyAsOfClose.close, spyAnchor.close) };
      const excess = { toDate: round(returns.toDate - spyReturns.toDate) };

      for (const h of HORIZONS) {
        const targetDate = addMonths(event.eventDate, h.months);
        if (targetDate > asOfDate) {
          // Not enough time has elapsed since the event yet — render as
          // "not yet available" on the page, never extrapolated.
          returns[h.key] = null;
          spyReturns[h.key] = null;
          excess[h.key] = null;
          continue;
        }
        const legClose = closeOnOrBefore(hist, targetDate);
        const spyClose = closeOnOrBefore(spyHist, targetDate);
        returns[h.key] = legClose ? pctChange(legClose.close, anchor.close) : null;
        spyReturns[h.key] = spyClose ? pctChange(spyClose.close, spyAnchor.close) : null;
        excess[h.key] = (returns[h.key] !== null && spyReturns[h.key] !== null) ? round(returns[h.key] - spyReturns[h.key]) : null;
      }

      // Trading-day-indexed cumulative excess series, t=0 at the event
      // anchor, used only to build the cross-leg average curve below —
      // stripped from the final per-leg payload to keep it small.
      const excessSeries = [];
      for (let t = 0; t <= CURVE_MAX_TRADING_DAYS; t++) {
        const idx = anchor.index + t;
        if (idx >= hist.dates.length) break;
        const d = hist.dates[idx];
        const spyClose = closeOnOrBefore(spyHist, d);
        if (!spyClose) break;
        const legCum = pctChange(hist.closes[idx], anchor.close);
        const spyCum = pctChange(spyClose.close, spyAnchor.close);
        excessSeries.push(round(legCum - spyCum));
      }

      legs.push({
        eventId: event.id,
        role,
        ticker,
        sector: event.sector,
        label: role === "spinco" ? event.spincoLabel : event.parentLabel,
        eventDate: event.eventDate,
        returns,
        spyReturns,
        excess,
        tradingDaysElapsed: hist.dates.length - 1 - anchor.index,
        excessSeries,
      });
    }

    for (const event of EVENTS) {
      buildLeg(event, "spinco", event.spinco);
      if (event.hasParentLeg) {
        buildLeg(event, "parent", event.parent);
      } else {
        skippedLegs.push({ eventId: event.id, role: "parent", ticker: event.parent, reason: event.note || "no parent leg for this event" });
      }
    }

    if (!legs.length) throw new Error("Every leg failed — refusing to write an empty snapshot");

    // Event-time-aligned average cumulative excess-return curve: average
    // excessSeries[t] across every leg that still has data at that many
    // trading days past its own anchor. N shrinks as t grows (younger
    // events run out first) — reported alongside the average, not hidden.
    const curveT = [];
    const curveAvg = [];
    const curveN = [];
    for (let t = 0; t <= CURVE_MAX_TRADING_DAYS; t++) {
      const vals = legs.map((l) => l.excessSeries[t]).filter((v) => v !== undefined && v !== null);
      if (!vals.length) break;
      curveT.push(t);
      curveAvg.push(round(vals.reduce((a, b) => a + b, 0) / vals.length));
      curveN.push(vals.length);
    }

    const scatter = EVENTS.filter((e) => e.hasParentLeg)
      .map((e) => {
        const spincoLeg = legs.find((l) => l.eventId === e.id && l.role === "spinco");
        const parentLeg = legs.find((l) => l.eventId === e.id && l.role === "parent");
        if (!spincoLeg || !parentLeg || spincoLeg.excess.toDate === null || parentLeg.excess.toDate === null) return null;
        return {
          eventId: e.id,
          sector: e.sector,
          spincoTicker: spincoLeg.ticker,
          parentTicker: parentLeg.ticker,
          spincoLabel: e.spincoLabel,
          parentLabel: e.parentLabel,
          x: parentLeg.excess.toDate,
          y: spincoLeg.excess.toDate,
        };
      })
      .filter(Boolean);

    function leaderRow(l) {
      return {
        eventId: l.eventId, ticker: l.ticker, label: l.label, sector: l.sector,
        eventDate: l.eventDate, excessToDate: l.excess.toDate, returnToDate: l.returns.toDate,
      };
    }
    function topBottom(role) {
      const pool = legs.filter((l) => l.role === role && l.excess.toDate !== null);
      const sorted = [...pool].sort((a, b) => b.excess.toDate - a.excess.toDate);
      return {
        best: sorted.slice(0, LEADER_COUNT).map(leaderRow),
        worst: sorted.slice(-LEADER_COUNT).reverse().map(leaderRow),
      };
    }
    const spincoBoard = topBottom("spinco");
    const parentBoard = topBottom("parent");

    function mean(values) {
      const v = values.filter((x) => x !== null && x !== undefined && !isNaN(x));
      return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    }
    const sectorBreakdown = [...new Set(EVENTS.map((e) => e.sector))]
      .map((sector) => {
        const spincoVals = legs.filter((l) => l.role === "spinco" && l.sector === sector && l.excess.toDate !== null).map((l) => l.excess.toDate);
        const parentVals = legs.filter((l) => l.role === "parent" && l.sector === sector && l.excess.toDate !== null).map((l) => l.excess.toDate);
        return {
          sector,
          spincoCount: spincoVals.length,
          parentCount: parentVals.length,
          avgSpincoExcess: mean(spincoVals),
          avgParentExcess: mean(parentVals),
        };
      })
      .filter((s) => s.spincoCount > 0 || s.parentCount > 0);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate,
      universeTickerCount: tickers.size,
      loadedTickerCount: histories.size,
      events: EVENTS.map((e) => ({
        id: e.id, parentTicker: e.parent, spincoTicker: e.spinco, eventDate: e.eventDate, sector: e.sector,
        parentLabel: e.parentLabel, spincoLabel: e.spincoLabel, hasParentLeg: e.hasParentLeg, note: e.note || null,
      })),
      legs: legs.map((l) => ({
        eventId: l.eventId, role: l.role, ticker: l.ticker, sector: l.sector, label: l.label, eventDate: l.eventDate,
        returns: l.returns, spyReturns: l.spyReturns, excess: l.excess, tradingDaysElapsed: l.tradingDaysElapsed,
      })),
      eventTimeCurve: { t: curveT, avgExcess: curveAvg, n: curveN },
      scatter,
      leaderboards: { bestSpincos: spincoBoard.best, worstSpincos: spincoBoard.worst, bestParents: parentBoard.best, worstParents: parentBoard.worst },
      sectorBreakdown,
      skippedLegs,
      failedTickers,
    };

    await getSpinoffStore().setJSON(BLOB_KEY, payload);
    console.log(`scheduled-spinoff-background: wrote ${legs.length} legs across ${EVENTS.length} events`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, legs: legs.length, events: EVENTS.length }) };
  } catch (err) {
    console.error(`scheduled-spinoff-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
