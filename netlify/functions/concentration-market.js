// Serves the market-level concentration series for concentration.html:
//
//   - SPY  (cap-weighted S&P 500 proxy) daily adjusted close
//   - RSP  (equal-weighted S&P 500 proxy) daily adjusted close
//
// Both as split/dividend-adjusted closes (total-return proxies), from
// RSP's April 2003 inception to present. The page indexes each to 100 at
// the first common date and also plots the equal/cap relative-strength
// ratio (chart D).
//
// Two Yahoo Finance calls per invocation (no Alpha Vantage quota), so this
// runs live with a long cache header rather than via a scheduled blob job
// like the 500-symbol breadth feed.

const { fetchDailyHistory, sleep } = require("./yahoo-client");

const SYMBOLS = ["SPY", "RSP"];

async function fetchDailyAdjusted(symbol) {
  const bars = await fetchDailyHistory(symbol);
  return new Map(bars.map((b) => [b.date, b.close]));
}

exports.handler = async () => {
  try {
    const bySymbol = {};
    for (const symbol of SYMBOLS) {
      bySymbol[symbol] = await fetchDailyAdjusted(symbol);
      await sleep(300);
    }

    // Intersection of dates both series report, ascending. RSP's
    // inception (~2003-04-24) sets the start.
    const dates = [...bySymbol.SPY.keys()]
      .filter((d) => bySymbol.RSP.has(d))
      .sort();

    const rows = dates.map((date) => ({
      date,
      spy: Math.round(bySymbol.SPY.get(date) * 10000) / 10000,
      rsp: Math.round(bySymbol.RSP.get(date) * 10000) / 10000,
    }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      note:
        "SPY = cap-weighted S&P 500 proxy, RSP = equal-weighted S&P 500 proxy. " +
        "Split/dividend-adjusted closes (total-return basis). Common trading dates only.",
      rows,
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=43200",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
