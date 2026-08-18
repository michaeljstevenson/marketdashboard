# Market Dashboard — Project Context

Michael J. Stevenson's personal markets-research website, deployed at **michaeljstevenson.co**.
Repo: `michaeljstevenson/marketdashboard` on GitHub. Pushing to `main` auto-deploys via Netlify —
no separate build/deploy step needed.

## Stack

Static multi-page site: plain HTML/CSS/vanilla JS per page (no framework, no bundler). Charts via
Chart.js (CDN) + `chartjs-plugin-zoom@2` for drag-to-zoom. Backend is Netlify Functions
(`netlify/functions/*.js`) for anything needing a live API call or scheduled data refresh, backed
by Netlify Blobs for persistence. Routing for `/api/*` → functions is defined in `netlify.toml`.

## Site structure

Each content page (`implied-erp.html`, `ipo-activity.html`, `yield-curves.html`,
`expectations-vs-reality.html`, `valuations.html`, `factor-analysis.html`, `market-breadth.html`,
`ath-index.html`, `sector-analysis.html`, `volatility.html`, `portfolio-simulator.html`,
`sentiment-index.html`) is a fully self-contained `.html` file — its own `<style>` block and
`<script>` block, not shared. `index.html` is the homepage with the Research Areas grid.
`coming-soon.html` is the placeholder page for not-yet-built research areas.

**Important gotcha:** the top nav (`<nav class="sitenav">`, with its category dropdowns) is
**duplicated verbatim into every page**, not templated or shared. Any nav change (labels,
order, links, categories) must be applied to all ~13 pages that carry it, or it'll look fixed on
whichever page you tested and still be stale everywhere else. This has caused repeated
confusion — a user edit made "while sitting on page X" only ever touches page X's copy.

## The Edit Mode workflow

`scripts/preview-server.js` runs a local preview server with an in-browser contenteditable "Edit
Mode" overlay — the user can click into any text on any page and edit it live. Each edit gets
logged as an entry to `preview-edits.json` at the repo root (page, CSS selector, oldText, newText,
timestamp). This file is git-ignored.

When the user says something like **"edited, push"** / **"updated, push"** after using Edit Mode:
1. Read `preview-edits.json`.
2. Group entries by (page, selector); for selectors edited multiple times, only the **latest**
   (highest-timestamp) `newText` reflects final intent — earlier entries in the chain are
   superseded, not separate edits to apply.
3. Apply each final edit to the real HTML file. Prefer an exact-string replace of the original
   text; if it doesn't match (e.g. inline tags, encoded entities, or the block was already
   restructured), fall back to locating the element via the CSS selector and editing it directly.
4. Delete `preview-edits.json`.
5. Commit (descriptive message, `Co-Authored-By: Claude <noreply@anthropic.com>`) and push.
6. Report back what shipped.

If a selector's target text isn't found where expected, don't guess — read the current file state
around that area first. Auto-formatting hooks may have touched the file since the edit was logged.

## Content ownership

**The user authors all site prose and copy themselves** — headlines, subtitles, explainer
paragraphs, methodology write-ups, everything readable. Claude's job is data, charts, calculations,
scaffolding, and bug fixes — not rewriting or "improving" the user's wording. Apply Edit Mode
changes verbatim, never paraphrased.

## Data sources (per page)

- **Implied ERP**: Aswath Damodaran (NYU Stern), FCFE-basis model, sourced not locally computed.
- **IPO Activity**: Jay Ritter (U. Florida) IPO database.
- **Yield Curves**: Alpha Vantage (Treasury CMT yields), NY Fed ACM term premium model, NBER
  recession dates.
- **Expectations vs. Reality**: hand-compiled strategist year-end target survey (multiple press
  sources, see in-page sourcing notes).
- **Valuations, Sector Performance, Factor Analysis, Market Breadth, ATH/ATL, Volatility,
  Sentiment Index**: Alpha Vantage market data (some via scheduled background functions +
  Netlify Blobs), Ken French Data Library (factors), TradingView screener (ATH/ATL cross-check).
- **Portfolio Simulator**: NYU Stern historical S&P 500 / T-bond annual return series,
  client-side historical-bootstrap Monte Carlo (no server calls).

## Alpha Vantage rate limits

This account's entitlement supports roughly ~71–75 calls/minute, not the free-tier 5/minute — but
scheduled background jobs still need deliberate pacing (see `scheduled-sectors-background.js` for
the pattern: ~800ms between sequential calls, plus a retry pass for anything that fails). A job
that fires calls too fast will get silently rate-limited partway through and drop data with no
visible error other than "only N of M loaded" on the page.

## Working conventions

- `--ink` and other theme CSS custom properties flip between light/dark mode; any JS that sets
  chart colors must read the live value via `getComputedStyle`, never hardcode either mode's color.
- Charts with many overlapping datasets (spaghetti plots) use `interaction: {mode:"point",
  intersect:true}`, not `"nearest"` — `"nearest"` hit-tests every dataset on every mousemove and
  has hung the browser tab before at scale.
- Don't add code comments explaining *what* code does — only *why*, for non-obvious constraints.
- Never commit or push without the user explicitly asking in that turn.
