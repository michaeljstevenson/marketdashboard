// Scheduled Background Function (see [functions."scheduled-ipo-pipeline-
// background"] in netlify.toml) that builds the IPO Pipeline & Aftermarket
// Tracker page's data. Two jobs in one run:
//
//   1. Pull Alpha Vantage's IPO_CALENDAR (forward-looking, ~3 months out),
//      classify each row Operating vs. Fund/Trust, and merge it into an
//      accumulating roster of every operating-company IPO ever seen.
//   2. For roster entries whose IPO date has passed, follow their own
//      aftermarket price action (day-1/5/10/20 return vs. SPY) going
//      forward from here — this page does NOT attempt a historical
//      backfill of past IPOs. See ipo-pipeline.html's methodology section
//      for why: Jay Ritter's dataset (ipo-activity.html) is aggregate
//      year-level stats with no individual-ticker list to join price
//      history against (the finding from this repo's PR #13 investigation
//      into "IPO Aftermarket Performance"), and IPO_CALENDAR itself is
//      forward-only, so there is no way to ask it "what IPO'd a year ago."
//      Instead this job starts an honest, accumulating track record from
//      whenever it first ran.
//
// IPO_CALENDAR is CSV, not JSON, and is a genuinely thin dataset at any
// given moment (often single-digit new rows) — that's a real characteristic
// of this endpoint, not a bug to work around.

const { getIpoPipelineStore, LATEST_KEY } = require("./ipo-pipeline-blob-store");
const { recordAvCall } = require("./av-call-counter");

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HORIZONS = [1, 5, 10, 20]; // trading days after the anchor day
const ABANDON_AFTER_MISSES = 3; // consecutive weekly runs post-ipoDate with no price data
const ABANDON_AFTER_DAYS = 45; // calendar days past ipoDate with no price data ever, regardless of miss count

// Case-insensitive substring patterns for "this IPO_CALENDAR row is a new
// fund/trust/SPAC-style vehicle, not an operating company going public."
// Not exhaustive by design (see ipo-pipeline.html's methodology blurb) —
// mirrors the real data-quality filtering this site's scheduled-splits-
// background.js pattern already established for another Alpha Vantage
// calendar-style endpoint.
const FUND_TRUST_PATTERNS = [
  "trust",
  "fund",
  " etf",
  "closed-end",
  "depositor",
  "index fund",
  "acquisition corp",
  "acquisition corporation",
  "acquisition co",
  "acquisition company",
  "spac",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classify(name) {
  const padded = " " + String(name || "").toLowerCase() + " ";
  return FUND_TRUST_PATTERNS.some((p) => padded.includes(p)) ? "fund/trust" : "operating";
}

// Small CSV-line parser that respects double-quoted fields (a company name
// could in principle contain a comma) rather than a risky naive split(',').
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || "")
    .split(/\r\n|\n/)
    .filter((l) => l.length > 0);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i] !== undefined ? cols[i].trim() : "";
    });
    return row;
  });
}

async function fetchAv(url) {
  await recordAvCall();
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

async function fetchIpoCalendar(apiKey) {
  const res = await fetchAv(`${ALPHA_VANTAGE_URL}?function=IPO_CALENDAR&apikey=${apiKey}`);
  const text = await res.text();
  return parseCsv(text);
}

// Returns { byDate: Map<date, {open, close}>, dates: string[] (ascending) }
// or null if Alpha Vantage has no series for this symbol (delisted before
// listing, bad ticker, deal pulled — all real, expected outcomes here).
async function fetchDailyOhlc(apiKey, symbol) {
  const res = await fetchAv(
    `${ALPHA_VANTAGE_URL}?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${apiKey}`
  );
  const payload = await res.json();
  const series = payload["Time Series (Daily)"];
  if (!series) return null;
  const byDate = new Map();
  for (const [date, day] of Object.entries(series)) {
    byDate.set(date, { open: parseFloat(day["1. open"]), close: parseFloat(day["4. close"]) });
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return null;
  return { byDate, dates };
}

// Finds the first trading day at/after `ipoDate` in an ascending date list.
function firstTradingDayAtOrAfter(dates, ipoDate) {
  return dates.find((d) => d >= ipoDate) || null;
}

// Computes day-1/5/10/20 open-to-close returns for the stock (from its own
// anchor day's open) and the identical calendar-window calculation for SPY,
// then the stock-minus-SPY relative return at each horizon. A horizon with
// not-yet-enough trading days elapsed, or a calendar-date gap in either
// series (holiday mismatch, halt, etc.), is left null rather than guessed.
function computeReturns(stockSeries, spySeries, ipoDate) {
  const anchorDate = firstTradingDayAtOrAfter(stockSeries.dates, ipoDate);
  if (!anchorDate) return null;

  const anchorIdx = stockSeries.dates.indexOf(anchorDate);
  const anchorOpen = stockSeries.byDate.get(anchorDate).open;
  const spyAnchor = spySeries ? spySeries.byDate.get(anchorDate) : null;
  const spyAnchorOpen = spyAnchor ? spyAnchor.open : null;

  const returns = {};

  for (const n of HORIZONS) {
    const idx = anchorIdx + (n - 1);
    const targetDate = stockSeries.dates[idx];
    if (!targetDate) {
      returns["d" + n] = null;
      continue;
    }
    const stockClose = stockSeries.byDate.get(targetDate).close;
    const stockReturn = anchorOpen ? ((stockClose / anchorOpen - 1) * 100) : null;

    let spyReturn = null;
    let relativeReturn = null;
    if (spySeries && spyAnchorOpen) {
      const spyTarget = spySeries.byDate.get(targetDate);
      if (spyTarget) {
        spyReturn = (spyTarget.close / spyAnchorOpen - 1) * 100;
        if (stockReturn !== null) relativeReturn = stockReturn - spyReturn;
      }
    }

    returns["d" + n] = stockReturn === null ? null : {
      stockReturn: round2(stockReturn),
      spyReturn: spyReturn === null ? null : round2(spyReturn),
      relativeReturn: relativeReturn === null ? null : round2(relativeReturn),
    };
  }

  return { anchorDate, anchorOpen: round2(anchorOpen), returns, complete: returns.d20 !== null };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

exports.handler = async () => {
  console.log("scheduled-ipo-pipeline-background: starting");
  try {
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY environment variable is not set");

    const store = getIpoPipelineStore();
    const previous = (await store.get(LATEST_KEY, { type: "json" })) || { roster: [], history: [] };

    const today = new Date().toISOString().slice(0, 10);

    // --- 1. Pull + classify this run's calendar ---
    let rawRows = [];
    try {
      rawRows = await fetchIpoCalendar(apiKey);
    } catch (err) {
      console.error(`scheduled-ipo-pipeline-background: IPO_CALENDAR fetch failed: ${err.message}`);
      // A fetch failure (not a genuinely empty calendar) should not wipe
      // out the existing roster/history — bail out without writing.
      throw err;
    }

    const calendar = rawRows
      .filter((r) => r.symbol) // guard against a stray blank/header-only line
      .map((r) => {
        const priceRangeLow = parseFloat(r.priceRangeLow) || 0;
        const priceRangeHigh = parseFloat(r.priceRangeHigh) || 0;
        return {
          symbol: r.symbol.toUpperCase(),
          name: r.name,
          ipoDate: r.ipoDate,
          priceRangeLow,
          priceRangeHigh,
          priced: !(priceRangeLow === 0 && priceRangeHigh === 0),
          currency: r.currency || "USD",
          exchange: r.exchange || "",
          classification: classify(r.name),
        };
      });

    console.log(`scheduled-ipo-pipeline-background: ${calendar.length} calendar row(s), ${rawRows.length} raw`);
    // A genuinely empty near-term calendar is a valid real state, not an
    // error — deliberately no throw here.

    // --- 2. Merge into the accumulating roster (operating companies only) ---
    const roster = new Map(previous.roster.map((r) => [r.symbol, r]));

    for (const row of calendar) {
      if (row.classification !== "operating") continue;
      const existing = roster.get(row.symbol);
      if (!existing) {
        roster.set(row.symbol, {
          symbol: row.symbol,
          name: row.name,
          exchange: row.exchange,
          ipoDate: row.ipoDate,
          originalIpoDate: row.ipoDate,
          status: "pending",
          firstSeenDate: today,
          missedFetches: 0,
          anchorDate: null,
          anchorOpen: null,
          returns: { d1: null, d5: null, d10: null, d20: null },
        });
      } else if (existing.status === "pending" && existing.ipoDate !== row.ipoDate) {
        console.log(`scheduled-ipo-pipeline-background: ${row.symbol} ipoDate slipped ${existing.ipoDate} -> ${row.ipoDate}`);
        existing.ipoDate = row.ipoDate;
        existing.missedFetches = 0; // a date slip resets the "no data yet" clock
      }
    }

    // --- 3. Fetch aftermarket price data for anything due ---
    const dueForFetch = [...roster.values()].filter(
      (r) => (r.status === "pending" && r.ipoDate <= today) || r.status === "tracking"
    );

    let spySeries = null;
    if (dueForFetch.length) {
      try {
        spySeries = await fetchDailyOhlc(apiKey, "SPY");
      } catch (err) {
        console.error(`scheduled-ipo-pipeline-background: SPY fetch failed, relative returns unavailable this run: ${err.message}`);
      }
      await sleep(800);
    }

    for (const entry of dueForFetch) {
      let series = null;
      try {
        series = await fetchDailyOhlc(apiKey, entry.symbol);
      } catch (err) {
        console.error(`scheduled-ipo-pipeline-background: ${entry.symbol} fetch failed: ${err.message}`);
      }
      await sleep(800);

      if (!series) {
        entry.missedFetches = (entry.missedFetches || 0) + 1;
      } else {
        const result = computeReturns(series, spySeries, entry.ipoDate);
        if (!result) {
          entry.missedFetches = (entry.missedFetches || 0) + 1;
        } else {
          entry.missedFetches = 0;
          entry.status = result.complete ? "complete" : "tracking";
          entry.anchorDate = result.anchorDate;
          entry.anchorOpen = result.anchorOpen;
          entry.returns = result.returns;
          entry.lastCheckedDate = today;
        }
      }

      // Some filed IPOs get pulled/delayed indefinitely — don't track those
      // forever. Abandon on 3 consecutive weekly misses post-ipoDate, or on
      // a hard 45-day-past-ipoDate backstop regardless of miss count.
      if (entry.status === "pending" && entry.ipoDate <= today) {
        const pastDays = daysBetween(entry.ipoDate, today);
        if (entry.missedFetches >= ABANDON_AFTER_MISSES || pastDays > ABANDON_AFTER_DAYS) {
          entry.status = "abandoned";
          console.log(`scheduled-ipo-pipeline-background: ${entry.symbol} marked abandoned (${entry.missedFetches} misses, ${pastDays}d past ipoDate)`);
        }
      }
    }

    // --- 4. Weekly snapshot for the pipeline-size trend ---
    const operatingCount = calendar.filter((r) => r.classification === "operating").length;
    const fundTrustCount = calendar.filter((r) => r.classification === "fund/trust").length;
    const tbdCount = calendar.filter((r) => !r.priced).length;

    const history = [...(previous.history || [])];
    if (!history.length || history[history.length - 1].asOfDate !== today) {
      history.push({
        asOfDate: today,
        totalCalendar: calendar.length,
        operatingCount,
        fundTrustCount,
        tbdCount,
      });
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      asOfDate: today,
      calendar,
      roster: [...roster.values()],
      history,
    };

    await store.setJSON(LATEST_KEY, payload);
    console.log(
      `scheduled-ipo-pipeline-background: wrote ${calendar.length} calendar rows, ${roster.size} roster entries, ${history.length} history points`
    );

    return { statusCode: 200, body: JSON.stringify({ ok: true, calendar: calendar.length, roster: roster.size }) };
  } catch (err) {
    console.error(`scheduled-ipo-pipeline-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
