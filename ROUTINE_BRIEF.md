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
* **Margin & Leverage Cycle** (2026-09-15, `nightly/2026-09-15-margin-leverage`) — `/margin-leverage.html`. A fresh, off-list idea (per this brief's explicit permission to propose beyond the listed backlog) tracking S&P 500 corporate profitability and balance-sheet leverage through the recent Fed rate cycle — no existing page touches income-statement margins or balance-sheet leverage ratios. Sector-median quarterly trend (toggle: gross/operating/net margin) and sector-median net-debt/trailing-twelve-month-EBITDA trend across the 11 SPDR sectors; the core "why this matters" test aggregates to one point per calendar quarter (the cross-company median QoQ change in operating margin, and separately in net-debt/EBITDA) rather than a ~500-way pseudo-replicated company panel, then compares those by Fed-funds regime (Hiking/Holding/Cutting, using the identical trailing-3-month-change classification already built for `/small-cap-vs-large-cap.html`) and regresses each against the quarter's Fed-funds change (Pearson+Spearman, matching `/factor-analysis`'s two-method convention) — honestly reported as a small-sample test (only a few dozen quarters of history) given how sticky/slow-moving margins and leverage are; in this run's synthetic-but-realistic test fixture the planted signal showed cleanly (median margin change averaged about -0.40ppt/quarter in Hiking regimes vs. +0.20ppt/quarter in Cutting regimes), but that's a property of the test fixture, not a claim about the real production data, which will show whatever it actually shows once the real weekly sweep runs. Also a margin-vs-leverage cross-company scatter (most recent quarter, Pearson+Spearman), sector-relative leaderboards (widest/thinnest margin, most/least levered vs. each company's own sector median, not raw cross-sector), and a full sortable per-company table with a trailing-4-quarter margin trend arrow. Data: Alpha Vantage `INCOME_STATEMENT` + `BALANCE_SHEET` (quarterly, full S&P 500) + `FEDERAL_FUNDS_RATE` (monthly). Net debt prefers Alpha Vantage's combined `shortLongTermDebtTotal` field, falling back to summing `shortTermDebt`/`longTermDebt` when that's `"None"`; EBITDA prefers Alpha Vantage's direct `ebitda` field, falling back to `operatingIncome + depreciationAndAmortization` (same INCOME_STATEMENT report) when that's `"None"` — both fallback paths, and the case where even the fallback fields are missing (ratio left `null` rather than fabricated), are exercised by the test fixture. Backend: weekly `scheduled-margin-leverage-background.js` (Saturday 11:20 UTC, after `scheduled-share-count-background`'s ~9-minute single-statement sweep) — a two-statement sweep (~1006 Alpha Vantage calls) paced at 750ms between calls (tighter than the usual ~800-1050ms elsewhere in this codebase, specifically because doubling the calls-per-company nearly doubles total sweep time inside a Background Function's ~15-minute ceiling) plus a retry pass — reusing Sector Beeswarm's `meta.json` for company name/sector rather than a third full-index metadata sweep. Tested by running the actual production background-job handler against a mocked `fetch` (18 real-symbol tickers across 5 sectors with realistic synthetic quarterly financials built on a real-shaped 2019-2026 Fed-funds path, a deliberately-planted margin-compression/leverage-rise signal during the synthetic 2022-23 hiking stretch and partial recovery during 2024-26 cutting, one ticker whose every fetch attempt fails, and three tickers individually exercising the `shortLongTermDebtTotal`-missing, `ebitda`-missing, and both-EBITDA-inputs-missing fallback paths) and a mocked Netlify Blobs store, served through a local stub API (reusing this session's Chart.js/zoom-plugin vendor files and stub-server pattern already set up earlier this run for the Spin-Off Performance Tracker test), driven with Playwright in dark/light desktop and dark/light mobile. Caught and fixed one real layout bug pre-merge: the two-column `.chart-grid` used for the regime-comparison and rate-regression charts didn't protect its grid items from CSS Grid's default `min-width:auto` "blowout" behavior, so a method-summary table's intrinsic width forced the whole page wider than its container (worse on mobile, but present at desktop width too) — fixed with an explicit `min-width:0` on `.chart-grid > .chart-box` (and on `.method-table` itself, which was also inheriting the site-wide `table{min-width:600px}` rule meant for the main multi-column data tables). Also opened in parallel this run: PR #16, Spin-Off Performance Tracker (`nightly/2026-09-15-spinoff-performance`) — if `main` doesn't yet show that entry above when this file is next read, that's just because PR #16 hasn't merged yet (this branch was cut from `main` before that PR merged, so this bullet was appended after the "Considered but skipped" bullet rather than after Spin-Off's own bullet); don't remove or contradict it, the two PRs' brief edits need a trivial merge-conflict resolution by whoever merges second (same stacked-PR precedent already documented elsewhere in this file).

Already attempted, skipped
(Update at the end of every run with why, so future runs don't re-try the same dead end)

* **Earnings Surprise History (beat/miss rates by sector)** and **Dividend Growth Screener** — both built independently in *this* session (Alpha Vantage `EARNINGS` and `DIVIDENDS` respectively), tested, and initially shipped as `nightly/2026-09-13-earnings-surprise` / part of `nightly/2026-09-13-dividend-growth` — then removed and dropped from the stack once it turned out a separate, concurrently-running session had already built both of these same two ideas first, unmerged, in PR #4 (`claude/sharp-hopper-t1gvy2`, created 2026-09-13 10:14 UTC — well before this session started, but never merged to `main`, so this session's `ROUTINE_BRIEF.md` read at start-of-run had no way to know). Real duplicate work, not a design flaw in either implementation. **Before re-attempting either idea**, check whether PR #4 is still open/unmerged — if so, that's the one to finish/merge rather than rebuilding from scratch; if PR #4 was closed without merging for a substantive reason, this note should be updated with why.
* **New Highs/New Lows Ratio** — skipped, not a data gap. `/market-breadth.html` already has a "New Highs − New Lows" stat card and a dedicated "52-week new highs vs. new lows" chart; a separate page would be a near-duplicate.
* **Equity Factor Performance (value/growth/momentum/quality/low-vol)** — skipped, not a data gap. `/factor-analysis.html` already covers Market/Size(SMB)/Value(HML)/Momentum via the Ken French Data Library back to 1926; a separate page would mostly re-plot the same series. (Quality and low-vol specifically aren't covered — could be a future addition to that existing page rather than a new one, if picked up later.)
