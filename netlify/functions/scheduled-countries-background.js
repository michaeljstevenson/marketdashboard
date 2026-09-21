// Scheduled Background Function (see [functions."scheduled-countries-background"]
// in netlify.toml) that fetches daily adjusted-close history (from Yahoo
// Finance, see yahoo-client.js) for a set of
// single-country/region ETF proxies plus a Value/Growth style pair, and
// writes trimmed history to Netlify Blobs for country-performance.js to
// serve. Mirrors scheduled-sectors-background.js's fetch/pace/retry
// pattern — see that file for the rationale on adjusted close.
//
// This does NOT attempt true country-by-sector granularity (e.g. "Japan
// Financials") — that isn't cleanly available via free ETF proxies for
// every region, just country-level and US-sector-level (the latter
// already served by sector-performance.js). country-sector-scorecard.html
// combines both blobs client-side into the scorecard grid.
//
// Unlike scheduled-sectors-background.js, this keeps ~10 trading years of
// history (not ~2) so the scorecard's yearly cadence view has more than a
// couple of data points to show.

const { getCountryStore, BLOB_KEY } = require("./country-blob-store");
const { fetchDailyHistory, sleep } = require("./yahoo-client");

const HISTORY_POINTS = 2600; // ~10 trading years

const REGIONS = [
  { ticker: "SPY", name: "US", type: "region" },
  { ticker: "EWJ", name: "Japan", type: "region" },
  { ticker: "EWU", name: "UK", type: "region" },
  { ticker: "EWG", name: "Germany", type: "region" },
  { ticker: "EWQ", name: "France", type: "region" },
  { ticker: "EWN", name: "Netherlands", type: "region" },
  { ticker: "EWC", name: "Canada", type: "region" },
  { ticker: "EWA", name: "Australia", type: "region" },
  { ticker: "EFA", name: "Developed ex-US", type: "region" },
  { ticker: "IVE", name: "Value", type: "style" },
  { ticker: "IVW", name: "Growth", type: "style" },
];

exports.handler = async () => {
  console.log(`scheduled-countries-background: starting, ${REGIONS.length} tickers`);
  try {
    const computed = new Map();

    for (const { ticker } of REGIONS) {
      try {
        const closes = await fetchDailyHistory(ticker);
        computed.set(ticker, closes);
      } catch (err) {
        console.error(`scheduled-countries-background: ${ticker} failed: ${err.message}`);
      }
      await sleep(300);
    }

    const missing = REGIONS.filter(({ ticker }) => !computed.has(ticker));
    if (missing.length) {
      console.log(`scheduled-countries-background: retrying ${missing.length} failed ticker(s): ${missing.map((t) => t.ticker).join(", ")}`);
      await sleep(2000);
      for (const { ticker } of missing) {
        try {
          const closes = await fetchDailyHistory(ticker);
          computed.set(ticker, closes);
        } catch (err) {
          console.error(`scheduled-countries-background: ${ticker} retry failed: ${err.message}`);
        }
        await sleep(300);
      }
    }

    console.log(`scheduled-countries-background: fetched ${computed.size}/${REGIONS.length} tickers`);
    if (computed.size === 0) throw new Error("Every ticker failed, not writing an empty blob");

    const roundHistory = (history) => history.map((h) => ({ date: h.date, close: Math.round(h.close * 100) / 100 }));

    const regions = REGIONS.map(({ ticker, name, type }) => {
      const closes = computed.get(ticker);
      if (!closes || !closes.length) return null;
      const trimmed = closes.slice(-HISTORY_POINTS);
      const latest = trimmed[trimmed.length - 1];
      return {
        ticker,
        name,
        type,
        asOfDate: latest.date,
        latestClose: Math.round(latest.close * 100) / 100,
        history: roundHistory(trimmed),
      };
    }).filter(Boolean);

    const payload = {
      generated_at_utc: new Date().toISOString(),
      regions,
    };

    const store = getCountryStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-countries-background: wrote ${regions.length} regions to blob`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, regions: regions.length }),
    };
  } catch (err) {
    console.error(`scheduled-countries-background: FAILED: ${err.message}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
