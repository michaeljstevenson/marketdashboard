Nightly Routine Brief — michaeljstevenson.co
## ⚠️ DO NOT STOP AFTER ONE PAGE
This is the single most important rule in this file, and it has been missed
before: after finishing a page — including after it's tested, committed,
pushed, and its PR is green and mergeable — **do not stop and do not consider
the run "done."** Immediately move to the next backlog item (or propose a new
one) and keep building. Only stop when the safety valve below is hit
(~85% of the session window) or the idea backlog is genuinely exhausted.
"I built one good page" is never a finishing condition on its own.
Site context
Independent markets-research portfolio site (data-driven research on markets, macro, and investor psychology). Existing sections: Behavioral/Positioning, Equities, Markets/Macro, Rates/Credit, Alternative/Cross-Asset, Thematic. Tone: professional, data-first, "not investment advice."
Nightly task
Build fully polished equities-research pages — not stubs. The backlog below is a source of ideas, not a restriction: use it as a starting point, but feel free to propose and build other equities-related page ideas that fit the site's style, whether or not they're on the list. No cap on how many per night: build as many as can be finished to the "fully polished" standard below within the run. Never sacrifice polish/data depth just to bump the count — a single well-built page beats several half-finished ones.
Model

* Default to Sonnet 5, effort level: low for standard page-building work (scaffolding, layout, wiring up already-clear data pulls).
* Reserve Sonnet 5, effort level: medium for the harder analytical work — designing the statistical methodology, deciding how to structure a non-obvious dataset, or reasoning through what a metric actually means. Switch up only when the task genuinely calls for it, not by default.

Safety valve
Stop the run once it has consumed ~85% of the current 5-hour session window (Pro plan), even if the backlog isn't exhausted and even if fewer than 3 pages are done. Finish the page in progress to a clean stopping point rather than abandoning it mid-file, then wrap up and open the PR with whatever is complete.
Avoiding repeated/redundant work across runs

* Maintain a "Already built" list at the bottom of this brief file (see section below) and update it at the end of every run. Never re-derive or re-attempt a page already on that list.
* In the PR description, log what was skipped and why (e.g. "IPO Pipeline skipped — no free data source found with sufficient history after exhausting Alpha Vantage + web search") so the next run doesn't re-investigate the same dead end. Add skipped items to the "Already attempted, skipped" list below too.

Core objective: analysis first, then presentation
The real value of this site is turning complex equities/markets datasets into something a reader can actually understand — not just displaying numbers. For every page:

1. Analyze first. Do the actual statistical/quantitative work on the data — don't just plot a raw series. Reference [/factor-analysis](https://michaeljstevenson.co/factor-analysis) as the standard: it runs real statistical tests (correlation, Chow tests for structural breaks, robustness checks across different sample splits), and is transparent about methodology choices and even past mistakes made while building it.
2. Then visualize/present. Turn that analysis into a clean, friendly presentation — charts people can read at a glance, plain-language explanations of what the data means and why it matters, not just jargon or a raw chart dump. Depth of analysis matters more than page count — see Safety valve above.

Scope: Equities section only
This routine is restricted to building out the Equities section of the site. Do not build Markets/Macro, Rates/Credit, Alternative/Cross-Asset, or Behavioral/Positioning pages, even if they're listed as "coming soon" elsewhere on the site.
Idea backlog (starting points — not exhaustive, not required in order)

* Earnings Revisions
* Insider Buying/Selling
* Short Interest Tracker
* Buyback Announcements
* IPO Aftermarket Performance
* Dividend Growth Screener
* Small Cap vs. Large Cap Spread
* International vs. US Relative Performance
* Sector Rotation Model
* Analyst Estimate Dispersion
* Earnings Surprise History (beat/miss rates by sector)
* Buyback Yield vs. Dividend Yield
* New Highs/New Lows Ratio
* Equity Risk Premium by Sector
* Index Concentration (top 10 weight vs. history)
* Relative Strength Leaders/Laggards
* IPO Pipeline / Filing Tracker
* Share Count Trends (dilution vs. buybacks)
* Forward P/E vs. Trailing P/E Divergence
* Earnings Growth vs. Price Performance Divergence
* Sector Correlation Matrix
* Small Cap Liquidity/Volume Trends
* Stock Split Tracker
* Spin-off Performance Tracker
* Equity Factor Performance (value/growth/momentum/quality/low-vol)

Data sourcing (required)

1. Use the Alpha Vantage API (key already configured) as the first choice for any data the page needs — equities, FX, commodities, macro indicators, technicals, etc. Check what Alpha Vantage covers before assuming it can't.
2. If Alpha Vantage doesn't have sufficient depth for a given metric (e.g. missing series, insufficient history, no direct dataset), search free public sources online instead — e.g. FRED, BLS, Treasury.gov, World Bank, ECB/ONS/other central bank data portals, CFTC, exchange sites, or other free datasets relevant to the topic.
3. Do not give up and ship a page with placeholder, mocked, or illustrative-only data. If depth is genuinely unavailable after exhausting Alpha Vantage and a real search for free alternatives, scale the page's scope down (fewer charts/metrics) rather than fabricate data — but exhaust the search first.
4. Note the actual data source(s) used for each chart/metric in the page's methodology blurb and in the PR description.

"Fully polished" means

* [ ] Matches existing page layout/style conventions (check an existing page like /sector-analysis or /volatility as the template)
* [ ] Real data wired up (not placeholder text/numbers) where feasible via available APIs
* [ ] Chart(s)/visualization consistent with the site's existing chart style
* [ ] Short methodology/explainer blurb, matching the site's tone
* [ ] Added to the correct nav section, "coming soon" tag removed if applicable
* [ ] Responsive / doesn't break mobile layout

Boundaries — do not touch

* Only build pages under the Equities section (see Scope above) — do not create or modify pages in any other section
* Do not modify any already-live research page (Sentiment Index, Volatility, Sector Performance, etc.) unless explicitly asked
* Do not change deploy config, site-wide nav structure, or global styles
* Do not push to `main` — open a PR against a new branch per run

Output

* One PR per night, branch name `nightly/<date>-<short-topic>`
* PR description: what was built, what data source was used, what was skipped and why, anything that needs a manual decision (e.g. data source choice, ambiguous methodology)

Already built
(Update this list at the end of every run — do not re-attempt these)

* **Earnings Revisions** (2026-09-13) — analyst EPS estimate revision breadth (Net Revision Ratio) and magnitude (Estimate Drift) across the S&P 500, by sector, with a historical trend, breadth-vs-magnitude scatter, and upgrade/downgrade leaderboards. Data: Alpha Vantage `EARNINGS_ESTIMATES` (weekly full-universe sweep), sector/name metadata reused from the Sector Beeswarm page's own weekly refresh. See `netlify/functions/scheduled-revisions-background.js` for full methodology notes.
* **Index Concentration (top 10 weight vs. history)** — already live as `/concentration.html` (built prior to this routine's existence; noting it here so a future run doesn't re-derive it from the backlog).
* **Insider Buying/Selling** (2026-09-13, `nightly/2026-09-13-insider-buying-selling`) — `/insider-buying-selling.html`. Officer/director/10%+-owner Form 4 activity (Alpha Vantage `INSIDER_TRANSACTIONS`) across the full S&P 500, trailing 90 days: net $ buy/sell flow by sector, cluster-buying screen (2+ insiders buying, zero selling), largest individual purchases/sales, full sortable per-stock table. Backend: weekly `scheduled-insider-transactions-background.js` (Saturday 10:30 UTC) → Netlify Blobs (`insider-transactions` store) → `insider-transactions.js`, reusing the Sector Beeswarm page's `meta.json` for company name/sector rather than a second OVERVIEW sweep. See that run's PR description for the full write-up, including the signal-quality filtering rationale (Common-Stock-only, priced-only transactions) and its limits.
* **Small Cap vs. Large Cap Spread** (2026-09-13, `nightly/2026-09-13-smallcap-vs-largecap`) — `/small-cap-vs-large-cap.html`. Relative strength of IWM (small-cap) and MDY (mid-cap) vs. SPY (large-cap), indexed since IWM's May 2000 inception: long-run ratio chart, trailing-return ladder (1M–10Y, cumulative under 1Y / annualized 3Y+), rolling 12-month relative-return oscillator, average monthly spread return by Fed-funds-rate regime (Hiking/Holding/Cutting, classified off trailing 3-month change), and a Pearson+Spearman regression of monthly spread return against the month's change in the 10-year Treasury yield (methodology matches `/factor-analysis`'s two-method check). Backend: daily `scheduled-smallcap-background.js` (weekdays 21:15 UTC — only 5 Alpha Vantage calls, no heavy pacing needed) → Netlify Blobs (`smallcap-largecap` store) → `smallcap-largecap.js`. Data: Alpha Vantage `TIME_SERIES_DAILY_ADJUSTED` (IWM/MDY/SPY, full history) + `FEDERAL_FUNDS_RATE` + `TREASURY_YIELD` (10-year, both monthly, full history). Tested locally with a synthetic-but-realistic dataset (real Fed-funds/Treasury history, simulated price paths) served through a local stub API and driven with Playwright (dark/light/mobile) — caught and fixed two bugs pre-merge: floating-point-artifact y-axis tick labels on the regime bar chart, and a non-pluralized "1th percentile" ordinal.
* **Share Count Trends (dilution vs. buybacks)** (2026-09-13, `nightly/2026-09-13-share-count-trends`, stacked on top of the Small Cap vs. Large Cap Spread branch/PR above — merge that one first, or merge this PR as-is since it carries both diffs) — `/share-count-trends.html`. Reads buybacks vs. dilution directly off quarterly `commonStockSharesOutstanding` (Alpha Vantage `BALANCE_SHEET`) at 1/3/5-year lookbacks across the full S&P 500 — deliberately not sourced from separate buyback-announcement or dollar-value data, since the share count itself already nets out every buyback, issuance, and stock-based-comp dilution. Sector aggregates, a year-over-year persistence check (Pearson+Spearman, same non-overlapping-annual construction as `/factor-analysis`'s momentum test — does last year's buyback pace predict this year's?), buyback/dilution streak leaderboards, and a full sortable company table. Backend: weekly `scheduled-share-count-background.js` (Saturday 10:50 UTC, after the insider-transactions sweep), reusing Sector Beeswarm's `meta.json` for company name/sector. Tested locally the same way as this session's other pages (synthetic dataset with a deliberately-correlated year-over-year buyback signal, served through a local stub API, driven with Playwright in dark/light/mobile) — no bugs found.
* **Sector Correlation Matrix** (2026-09-13, `nightly/2026-09-13-dividend-growth`, stacked on top of the Share Count Trends branch/PR above — merge that one first, or merge this PR as-is since it carries both diffs) — `/sector-correlation.html`. Full pairwise Pearson correlation matrix (heatmap) across the 11 SPDR sector ETFs, a rolling 63-day average-correlation time series, and a direct test of the "correlations go to 1 in a crisis" claim (rolling avg. correlation regressed against rolling SPY realized volatility, Pearson+Spearman). Needed zero new Alpha Vantage calls or backend function — it's pure client-side analysis of the daily price history the existing `/api/sector-performance` endpoint (behind Sector Performance) already fetches and serves. Tested locally with a synthetic dataset that includes a deliberate "stress regime" (elevated common-factor weight over one stretch) to confirm the vol/correlation relationship renders correctly (r ≈ +0.98 in the synthetic case, as designed). No bugs found.
* **Sector Rotation Model** (2026-09-13, `nightly/2026-09-13-sector-rotation`, stacked on top of the Sector Correlation Matrix branch/PR above — merge earlier PRs first or merge this one as-is) — `/sector-rotation.html`. A Relative Rotation Graph (RRG)-style view of the 11 SPDR sector ETFs: current level (3-month relative-strength change) vs. momentum (1-month relative-strength change), classified into the standard Leading/Weakening/Lagging/Improving quadrants; a grouped-bar view of relative return across 1M/3M/6M/1Y; and a month-over-month rank-persistence test (Spearman) asking whether chasing last month's sector leaders actually works. Also reuses `/api/sector-performance` with no new Alpha Vantage calls. Tested locally with a synthetic dataset; found and fixed a real bug during testing — a sector label near the RRG chart's right edge (a strong "Leading" sector, the most interesting case) drew off-canvas on narrow viewports, now flips to the point's left when there isn't room on the right.
* Considered but skipped as near-duplicates of existing pages (see "Already attempted, skipped" below): **New Highs/New Lows Ratio** (already substantially covered by Market Breadth's "52-week new highs vs. new lows" chart) and **Equity Factor Performance** (already substantially covered by Factor Analysis's Market/Size/Value/Momentum Fama-French series).
* **Small-Cap Liquidity & Volume Trends** (2026-09-15, `nightly/2026-09-15-ipo-pipeline`) — `/small-cap-liquidity.html`. Amihud (2002) illiquidity ratio and Corwin-Schultz (2012) high-low bid-ask spread estimates for the smallest vs. largest quintile of S&P 500 constituents by market cap (a market-cap-within-the-S&P-500 proxy — explicitly flagged as not true Russell 2000 small caps, no free full small-cap-index constituent list was available), plus a Pearson+Spearman regression testing whether the Small/Mega liquidity gap widens in the same months small-caps underperform large-caps (reusing `/api/smallcap-largecap`'s existing monthly-return bucketing logic client-side). Backend: new weekly `scheduled-smallcap-liquidity-background.js` (Saturday 13:35 UTC, ~200 sequential `TIME_SERIES_DAILY_ADJUSTED` calls, reuses Sector Beeswarm's `meta.json` for cohort membership/market cap — no new OVERVIEW sweep) → Netlify Blobs (`smallcap-liquidity` store) → `smallcap-liquidity.js`. Tested with Playwright (dark/light/mobile, real Chart.js served locally since this sandbox blocks jsdelivr) against a synthetic 200-ticker/504-day dataset — one real bug found and fixed pre-commit: the regression method table wasn't overflow-contained and pushed 371px of horizontal overflow at 390px width.
* **IPO Pipeline & Aftermarket Tracker** (2026-09-15, `nightly/2026-09-15-ipo-pipeline`) — `/ipo-pipeline.html`. Companion to (not a replacement for) `/ipo-activity.html`: tracks Alpha Vantage's forward-looking `IPO_CALENDAR` (~3 months out, CSV format), classifies each row Operating Company vs. Fund/Trust/SPAC by name pattern, and — since Ritter's historical dataset behind `/ipo-activity.html` has no per-IPO ticker to join price history against (confirmed dead end, see the Short Interest/IPO note below and PR #13's own investigation) — builds an honest **forward-only** aftermarket track record: once a tracked operating-company IPO's listing date passes, follows its day-1/5/10/20 return vs. SPY going forward from whenever this page first started tracking it. Explicitly does NOT attempt to annualize or forecast off the thin ~3-month calendar window (methodology calls this out as "a floor, not a forecast," with Ritter's trailing-5-year annual counts shown only as separate background context, never combined into one number). Backend: new weekly `scheduled-ipo-pipeline-background.js` (Saturday 13:20 UTC — trivial call volume: 1 `IPO_CALENDAR` pull + a handful of `TIME_SERIES_DAILY_ADJUSTED` compact pulls for roster entries due for a check) → Netlify Blobs (`ipo-pipeline` store) → `ipo-pipeline.js`. Cold-start page (pipeline-size trend and aftermarket-tracking table both start sparse/empty and build up over subsequent weekly runs) with graceful empty states for both. Tested with Playwright against synthetic mocks covering full/mixed, cold-start, and all-empty roster states — one real bug found and fixed pre-commit: the aftermarket table's "complete entries first" sort compared a row object to a string instead of `row.status`, silently degrading to a pure date sort.
* As of 2026-09-15, four other Equities PRs are open/unmerged on this repo from other sessions: **#4** (Earnings Surprise History + Dividend Growth Screener, stale/dirty against `main`), **#12** (International vs. US, Analyst Estimate Dispersion, Shareholder Yield), **#13** (Stock Split Tracker, Forward vs. Trailing P/E Divergence), **#14** (Relative Strength Leaders/Laggards, Equity Risk Premium by Sector, Earnings Growth Divergence). None of these ideas were re-attempted this run. Worth merging all of these (plus this run's own PR) in some order soon — check each PR's own "anything needing a manual decision" section for merge-order/collision notes (their Saturday cron slots reportedly don't collide with each other; this run's own two new jobs at 13:20/13:35 UTC were deliberately placed clear of all of them per their stated ranges, but haven't been checked against their *actual* merged `netlify.toml` diffs since none are merged yet — worth a real diff check at merge time).

Already attempted, skipped
(Update at the end of every run with why, so future runs don't re-try the same dead end)

* **Earnings Surprise History (beat/miss rates by sector)** and **Dividend Growth Screener** — both built independently in *this* session (Alpha Vantage `EARNINGS` and `DIVIDENDS` respectively), tested, and initially shipped as `nightly/2026-09-13-earnings-surprise` / part of `nightly/2026-09-13-dividend-growth` — then removed and dropped from the stack once it turned out a separate, concurrently-running session had already built both of these same two ideas first, unmerged, in PR #4 (`claude/sharp-hopper-t1gvy2`, created 2026-09-13 10:14 UTC — well before this session started, but never merged to `main`, so this session's `ROUTINE_BRIEF.md` read at start-of-run had no way to know). Real duplicate work, not a design flaw in either implementation. **Before re-attempting either idea**, check whether PR #4 is still open/unmerged — if so, that's the one to finish/merge rather than rebuilding from scratch; if PR #4 was closed without merging for a substantive reason, this note should be updated with why.
* **New Highs/New Lows Ratio** — skipped, not a data gap. `/market-breadth.html` already has a "New Highs − New Lows" stat card and a dedicated "52-week new highs vs. new lows" chart; a separate page would be a near-duplicate.
* **Equity Factor Performance (value/growth/momentum/quality/low-vol)** — skipped, not a data gap. `/factor-analysis.html` already covers Market/Size(SMB)/Value(HML)/Momentum via the Ken French Data Library back to 1926; a separate page would mostly re-plot the same series. (Quality and low-vol specifically aren't covered — could be a future addition to that existing page rather than a new one, if picked up later.)
* **IPO Aftermarket Performance** — a true historical version (join Ritter's `/ipo-activity.html` data against price history to compute actual post-IPO returns) remains not buildable: Ritter's dataset is aggregate year-level stats only, no individual IPO ticker list, confirmed by PR #13's investigation and re-confirmed this session. **Partially superseded**: this session's new IPO Pipeline & Aftermarket Tracker (`/ipo-pipeline.html`, see "Already built" above) covers the forward-looking version of this idea instead — don't rebuild a historical-backfill attempt, it's a confirmed dead end; if picked up again, the angle worth exploring is a different free historical source with a real per-IPO ticker list (none found in two separate sessions' searches so far).
* **Short Interest Tracker** — investigated this session, not attempted. FINRA publishes free bi-monthly bulk short-interest archive files (pipe-delimited, back to 2014 — see finra.org/finra-data/browse-catalog/equity-short-interest) which looked like a strong lead, but this sandbox's network egress policy blocks `finra.org` entirely (confirmed via both direct `curl` and the `WebFetch` tool — a `403`/`EGRESS_BLOCKED` on every attempt), so the exact bulk-download URL and file schema couldn't be verified this session. Netlify's production functions run outside this sandbox and would very likely reach FINRA fine — this is a sandbox-testing limitation, not evidence the source doesn't work. Worth a real attempt in a session with broader network access (or by pre-fetching a sample file another way and handing it to a future session to inspect), rather than building blind against a schema no one has confirmed this run.
* **Buyback Announcements** (dollar-value announced-buyback-program tracking, distinct from the share-count-based buyback signal already covered by `/share-count-trends.html`) and **Spin-off Performance Tracker** — neither has an Alpha Vantage endpoint, and no reliable free public source with a maintained ticker-level dataset was identified this session (search was limited by the same sandbox network-egress restriction noted above, which blocks most non-Alpha-Vantage domains outright — only `WebSearch`, not `WebFetch` or direct `curl`, could even query most candidate sources). Not written off entirely, just not attempted — worth a real look in a less network-restricted session.
