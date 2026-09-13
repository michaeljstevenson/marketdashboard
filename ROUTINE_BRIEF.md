Nightly Routine Brief — michaeljstevenson.co
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

* (none yet)

Already attempted, skipped
(Update at the end of every run with why, so future runs don't re-try the same dead end)

* (none yet)

<!-- push access check: test/push-check branch -->
