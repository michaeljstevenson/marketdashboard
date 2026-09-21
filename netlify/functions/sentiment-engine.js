// Scoring engine for the U.S. Market Sentiment Index.
// Pure functions, no I/O: scheduled-sentiment-background.js fetches the raw
// series and calls buildIndex(); scripts can call it directly to validate.
//
// Method, for every factor:
//   1. Reduce the raw series to a stationary "signal" (a level in
//      natural units, a spread, or a trailing return), so a rising trend in
//      the underlying series (VIX regime, cumulative A/D line, ETF price)
//      can't masquerade as sentiment.
//   2. Standardize with a rolling z-score against the trailing 5 years
//      (minimum 1 year of history). Only data up to and including each date
//      is used, so every historical score is what the index would have read
//      live — no look-ahead — and the window adapts to volatility regimes.
//   3. Map z (winsorized at ±3) to 0–100 with the normal CDF; fear-positive
//      signals (volatility) are inverted so 100 always means greed.
// Weighting is two-level equal weight: factors are grouped into pillars
// (volatility & options, trend & strength, breadth & participation, credit &
// risk appetite); each pillar's score is the simple average of its available
// factors, and the composite is the simple average of the available pillar
// scores. Equal weighting is deliberate: every factor's score is already on
// the same 0-100 scale, so unequal weights would need return-fitted
// estimates that can't be validated out of sample, and grouping keeps
// correlated factors (e.g. the four breadth measures) from crowding out the
// rest of the index. A date prints only if the available pillar/factor share
// is at least MIN_COVERAGE, and the point carries its coverage.
// The live reading and the history are the same series: today's composite is
// the last history point.

const Z_MIN_OBS = 252;
const Z_MAX_WINDOW = 1260;
const Z_CLAMP = 3;
const MIN_COVERAGE = 0.5;
const HISTORY_START = "1990-01-01"; // CBOE VIX and SKEW begin 1990-01-02
const PILLARS = [
  { id: "vol", name: "Volatility & Options" },
  { id: "trend", name: "Trend & Strength" },
  { id: "breadth", name: "Breadth & Participation" },
  { id: "credit", name: "Credit & Risk Appetite" },
];

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// Abramowitz & Stegun 26.2.17; max error ~7.5e-8.
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// values may contain nulls. Returns { z, mean, sd } arrays; entries are null
// until Z_MIN_OBS valid observations exist inside the trailing window.
function rollingZ(values) {
  const n = values.length;
  const cnt = new Float64Array(n + 1);
  const sum = new Float64Array(n + 1);
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const ok = v !== null && Number.isFinite(v);
    cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
    sum[i + 1] = sum[i] + (ok ? v : 0);
    sq[i + 1] = sq[i] + (ok ? v * v : 0);
  }
  const z = new Array(n).fill(null);
  const mean = new Array(n).fill(null);
  const sd = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    const lo = Math.max(0, i + 1 - Z_MAX_WINDOW);
    const c = cnt[i + 1] - cnt[lo];
    if (c < Z_MIN_OBS) continue;
    const m = (sum[i + 1] - sum[lo]) / c;
    const variance = Math.max(0, (sq[i + 1] - sq[lo]) / c - m * m);
    const s = Math.sqrt(variance);
    if (s < 1e-12) continue;
    mean[i] = m;
    sd[i] = s;
    z[i] = (v - m) / s;
  }
  return { z, mean, sd };
}

function scoreFromZ(z, invert) {
  const c = Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z));
  const s = 100 * normCdf(c);
  return invert ? 100 - s : s;
}

// ---- series helpers (all arrays are aligned to the base trading calendar) ----

// Forward-fills `points` ([{date, v}], ascending) onto `dates`, but never
// carries a value more than maxStaleDays past its own date.
function alignTo(dates, points, maxStaleDays = 5) {
  const out = new Array(dates.length).fill(null);
  let j = -1;
  for (let i = 0; i < dates.length; i++) {
    while (j + 1 < points.length && points[j + 1].date <= dates[i]) j++;
    if (j >= 0) {
      const gap = (Date.parse(dates[i]) - Date.parse(points[j].date)) / 86400000;
      if (gap <= maxStaleDays) out[i] = points[j].v;
    }
  }
  return out;
}

function map2(a, b, f) {
  return a.map((x, i) => (x === null || b[i] === null ? null : f(x, b[i])));
}

function sma(arr, w) {
  const out = new Array(arr.length).fill(null);
  let s = 0;
  let c = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] !== null) { s += arr[i]; c++; }
    if (i - w >= 0 && arr[i - w] !== null) { s -= arr[i - w]; c--; }
    if (i >= w - 1 && c === w) out[i] = s / w;
  }
  return out;
}

function lagDiff(arr, k) {
  return arr.map((v, i) => (i >= k && v !== null && arr[i - k] !== null ? v - arr[i - k] : null));
}

function ln(arr) {
  return arr.map((v) => (v !== null && v > 0 ? Math.log(v) : null));
}

function rollingStd(arr, w) {
  const out = new Array(arr.length).fill(null);
  for (let i = w - 1; i < arr.length; i++) {
    let c = 0, s = 0, q = 0;
    for (let k = i - w + 1; k <= i; k++) {
      const v = arr[k];
      if (v === null) { c = -1; break; }
      c++; s += v; q += v * v;
    }
    if (c === w) {
      const m = s / w;
      out[i] = Math.sqrt(Math.max(0, (q - w * m * m) / (w - 1)));
    }
  }
  return out;
}

// ---- factor definitions ----

const FACTORS = [
  {
    id: "vix",
    name: "Implied Volatility (VIX)",
    unit: "index",
    invert: true,
    pillar: "vol",
    signalLabel: "ln(VIX)",
    description: "Elevated option-implied volatility relative to its own recent regime signals fear.",
    details:
      "The CBOE Volatility Index measures the 30-day volatility that S&P 500 option prices imply. The signal is the natural log of the VIX close, standardized against its trailing five-year distribution, so the score reflects how unusual today's implied volatility is for the current regime rather than its raw level. Higher implied volatility scores lower (fear).",
    source: { name: "Yahoo Finance — CBOE VIX (^VIX)", url: "https://finance.yahoo.com/quote/%5EVIX" },
  },
  {
    id: "vixterm",
    name: "Volatility Term Structure",
    unit: "VIX ÷ VIX3M",
    invert: true,
    pillar: "vol",
    signalLabel: "ln(VIX / VIX3M)",
    description: "Front-month volatility above 3-month volatility (backwardation) signals acute stress.",
    details:
      "Compares 30-day implied volatility (VIX) with 3-month implied volatility (VIX3M). In calm markets the curve slopes upward (ratio below 1). When near-term fear outruns longer-dated fear the curve inverts (ratio above 1), a hallmark of stress episodes. The signal is ln(VIX / VIX3M), standardized against its trailing five years. A higher ratio scores lower (fear).",
    source: { name: "Yahoo Finance — CBOE 3-Month Volatility (^VIX3M)", url: "https://finance.yahoo.com/quote/%5EVIX3M" },
  },
  {
    id: "realizedvol",
    name: "Realized Volatility",
    unit: "% annualized (21-day)",
    invert: true,
    pillar: "vol",
    signalLabel: "21-day realized volatility of S&P 500 returns",
    description: "Wider realized price swings than recent norms signal fear.",
    details:
      "The annualized standard deviation of the S&P 500's last 21 daily log returns — how much the market has actually moved, as opposed to what options imply. Standardized against its trailing five years; higher realized volatility scores lower (fear).",
    source: { name: "Yahoo Finance — S&P 500 (^GSPC)", url: "https://finance.yahoo.com/quote/%5EGSPC" },
  },
  {
    id: "skew",
    name: "Tail-Risk Hedging (CBOE SKEW)",
    unit: "index",
    invert: true,
    pillar: "vol",
    signalLabel: "ln(CBOE SKEW)",
    description: "Elevated demand for out-of-the-money puts (a steeper option skew) signals heightened tail-risk hedging.",
    details:
      "The CBOE SKEW Index measures the perceived tail risk of S&P 500 returns from the relative pricing of out-of-the-money options: it rises when investors pay up for downside protection. It is the options-market positioning read in this index. The signal is ln(SKEW), standardized against its trailing five years; a higher reading (more hedging demand) scores lower.",
    source: { name: "Yahoo Finance — CBOE SKEW (^SKEW)", url: "https://finance.yahoo.com/quote/%5ESKEW" },
  },
  {
    id: "momentum",
    name: "Price Momentum",
    unit: "% vs 125-day MA",
    invert: false,
    pillar: "trend",
    signalLabel: "S&P 500 ÷ 125-day moving average − 1",
    description: "The S&P 500 trading above its 125-day average signals optimism.",
    details:
      "The percentage distance of the S&P 500 from its own 125-day simple moving average, a standard intermediate-term trend measure. Standardized against its trailing five years. Because it is derived from price itself it is a confirming rather than leading signal.",
    source: { name: "Yahoo Finance — S&P 500 (^GSPC)", url: "https://finance.yahoo.com/quote/%5EGSPC" },
  },
  {
    id: "highprox",
    name: "Proximity to 52-Week High",
    unit: "% below 52-week high",
    invert: false,
    pillar: "trend",
    signalLabel: "S&P 500 ÷ trailing 252-day high − 1",
    description: "The S&P 500 trading close to its 52-week high signals strength; a deeper drawdown signals weakness.",
    details:
      "The percentage distance of the S&P 500 below its trailing 252-day high (zero at a new high). It complements the moving-average momentum measure by capturing how far the market has fallen from its recent peak. Standardized against its trailing five years.",
    source: { name: "Yahoo Finance — S&P 500 (^GSPC)", url: "https://finance.yahoo.com/quote/%5EGSPC" },
  },
  {
    id: "breadthadline",
    name: "Advance/Decline Breadth",
    unit: "10-day net advancing share",
    invert: false,
    pillar: "breadth",
    signalLabel: "10-day average of (advances − declines) ÷ (advances + declines)",
    description: "A larger share of S&P 500 constituents advancing than declining signals broad participation.",
    details:
      "The 10-day average of each day's net advancing share across S&P 500 constituents, (advances − declines) ÷ (advances + declines). This replaces the cumulative advance/decline line, which trends without bound, with a stationary measure of participation. Standardized against its trailing five years.",
    source: { name: "Yahoo Finance — S&P 500 constituents (breadth job)", url: "/market-breadth.html" },
  },
  {
    id: "breadthhilo",
    name: "New Highs vs. Lows",
    unit: "10-day net new highs, % of constituents",
    invert: false,
    pillar: "breadth",
    signalLabel: "10-day average of (new 52-week highs − new 52-week lows) ÷ constituents",
    description: "More constituents at 52-week highs than lows signals healthy participation.",
    details:
      "The 10-day average of net new 52-week highs (highs minus lows) as a percentage of S&P 500 constituents. Standardized against its trailing five years.",
    source: { name: "Yahoo Finance — S&P 500 constituents (breadth job)", url: "/market-breadth.html" },
  },
  {
    id: "breadthpct200",
    name: "% Above 200-day SMA",
    unit: "% of constituents",
    invert: false,
    pillar: "breadth",
    signalLabel: "% of S&P 500 constituents above their own 200-day SMA",
    description: "A larger share of stocks above their 200-day average signals a broad uptrend.",
    details:
      "The percentage of S&P 500 constituents trading above their own 200-day simple moving average. Standardized against its trailing five years.",
    source: { name: "Yahoo Finance — S&P 500 constituents (breadth job)", url: "/market-breadth.html" },
  },
  {
    id: "credit",
    name: "Credit Risk Appetite",
    unit: "% vs 50-day avg (HYG÷LQD)",
    invert: false,
    pillar: "credit",
    signalLabel: "ln(HYG ÷ LQD) minus its own 50-day average",
    description: "High-yield bonds outperforming investment-grade signals rising risk appetite.",
    details:
      "The total-return ratio of HYG (high-yield corporate bonds) to LQD (investment-grade corporate bonds), measured as its deviation from its own 50-day average. Credit investors tend to reprice risk before equity investors, Standardized against its trailing five years. Before HYG launched in 2007 the series is extended with Vanguard's High-Yield Corporate and Long-Term Investment-Grade funds (VWEHX ÷ VWESX, 1980 onward), spliced at the overlap so the level is continuous.",
    source: { name: "Yahoo Finance — HYG, LQD", url: "https://finance.yahoo.com/quote/HYG" },
  },
  {
    id: "safehaven",
    name: "Stock vs. Bond Demand",
    unit: "pp, S&P 500 − long Treasuries (20-day)",
    invert: false,
    pillar: "credit",
    signalLabel: "20-day return of the S&P 500 minus 20-day total return of long Treasuries (log)",
    description: "Stocks outperforming long Treasuries over 20 days signals risk-on positioning.",
    details:
      "The difference between the S&P 500's trailing 20-day return and the total return of long-term Treasuries (Vanguard Long-Term Treasury fund, VUSTX; 1986 onward). When investors flee to safety, long Treasuries outperform stocks. Standardized against its trailing five years.",
    source: { name: "Yahoo Finance — S&P 500, VUSTX", url: "https://finance.yahoo.com/quote/VUSTX" },
  },
  {
    id: "smallcap",
    name: "Small-Cap Relative Strength",
    unit: "pp, Russell 2000 − S&P 500 (63-day)",
    invert: false,
    pillar: "credit",
    signalLabel: "63-day change in ln(Russell 2000 ÷ S&P 500)",
    description: "Small-caps outperforming large-caps over a quarter signals risk appetite.",
    details:
      "The trailing 63-trading-day change in the ratio of the Russell 2000 index to the S&P 500 (index data from 1987). Smaller, more leveraged companies lead when confidence is rising and lag when it turns. Standardized against its trailing five years.",
    source: { name: "Yahoo Finance — Russell 2000 (^RUT), S&P 500", url: "https://finance.yahoo.com/quote/%5ERUT" },
  },
  {
    id: "equalweight",
    name: "Equal-Weight Participation",
    unit: "pp, equal-weight − cap-weight (63-day)",
    invert: false,
    pillar: "breadth",
    signalLabel: "63-day change in ln(RSP ÷ S&P 500)",
    description: "The equal-weight S&P 500 keeping pace with the cap-weighted index signals broad participation.",
    details:
      "The trailing 63-trading-day change in the ratio of RSP (equal-weight S&P 500) to the cap-weighted S&P 500. When the equal-weight index leads, gains are spread across the roster; when it lags, a few mega-caps are carrying the market. Standardized against its trailing five years. RSP launched in 2003.",
    source: { name: "Yahoo Finance — RSP, S&P 500", url: "https://finance.yahoo.com/quote/RSP" },
  },
];


// inputs: {
//   spx: [{date, close}] (S&P 500 index, the trading calendar), vix, vix3m, skew: [{date, close}],
//   rut: [{date, close}], ust (VUSTX), hyg, lqd, vwehx, vwesx, rsp: [{date, adjClose}],
//   breadth: [{date, advances, declines, newHighs, newLows, pctAbove200sma}] | null,
//   constituentCount
// }
// Each factor whose inputs are missing is skipped (and reported in `missing`).
function buildIndex(inputs, { historyPoints = 10000, componentHistoryPoints = 1260, debug = false } = {}) {
  const dates = inputs.spx.map((b) => b.date);
  const n = dates.length;
  const pts = (rows, key) => (rows || []).map((r) => ({ date: r.date, v: r[key] }));
  const al = (rows, key) => alignTo(dates, pts(rows, key));

  const spyAdj = inputs.spx.map((b) => b.close);
  const spyClose = spyAdj;
  const vix = al(inputs.vix, "close");
  const vix3m = al(inputs.vix3m, "close");
  const skew = al(inputs.skew, "close");
  const hyg = al(inputs.hyg, "adjClose");
  const lqd = al(inputs.lqd, "adjClose");
  const tlt = al(inputs.ust, "adjClose");
  const iwm = al(inputs.rut, "close");
  const hyFund = al(inputs.vwehx, "adjClose");
  const igFund = al(inputs.vwesx, "adjClose");
  const rsp = al(inputs.rsp, "adjClose");
  const lnSpy = ln(spyAdj);

  const logRet = lagDiff(lnSpy, 1);
  const realized = rollingStd(logRet, 21).map((v) => (v === null ? null : v * Math.sqrt(252) * 100));

  const mom = map2(spyAdj, sma(spyAdj, 125), (p, m) => (p / m - 1) * 100);
  const hi252 = spyAdj.map((_, i) => {
    if (i < 251) return null;
    let mx = -Infinity;
    for (let k = i - 251; k <= i; k++) mx = Math.max(mx, spyAdj[k]);
    return (spyAdj[i] / mx - 1) * 100;
  });

  let adv10 = new Array(n).fill(null);
  let hl10 = new Array(n).fill(null);
  let pct200 = new Array(n).fill(null);
  if (inputs.breadth && inputs.breadth.length) {
    const b = inputs.breadth;
    const netShare = alignTo(dates, b.map((r) => ({ date: r.date, v: r.advances + r.declines > 0 ? (r.advances - r.declines) / (r.advances + r.declines) : null })).filter((p) => p.v !== null));
    const N = inputs.constituentCount || 500;
    const netHL = alignTo(dates, b.map((r) => ({ date: r.date, v: ((r.newHighs - r.newLows) / N) * 100 })));
    adv10 = sma(netShare, 10);
    hl10 = sma(netHL, 10);
    pct200 = alignTo(dates, b.filter((r) => r.pctAbove200sma !== null).map((r) => ({ date: r.date, v: r.pctAbove200sma })));
  }

  // Credit ratio: HYG/LQD where the ETFs exist, extended backwards with the
  // Vanguard high-yield / long-term investment-grade funds, rescaled at the
  // first overlap date so the spliced series has no level jump.
  const etfRatio = map2(hyg, lqd, (a, c) => a / c);
  const fundRatio = map2(hyFund, igFund, (a, c) => a / c);
  const splice = etfRatio.findIndex((v, i) => v !== null && fundRatio[i] !== null);
  const scale = splice >= 0 ? etfRatio[splice] / fundRatio[splice] : 1;
  const creditRatio = etfRatio.map((v, i) => (v !== null ? v : fundRatio[i] !== null && (splice < 0 || i < splice) ? fundRatio[i] * scale : null));
  const lnCredit = ln(creditRatio);
  const creditDev = map2(lnCredit, sma(lnCredit, 50), (v, m) => v - m);
  const creditPct = creditDev.map((v) => (v === null ? null : (Math.exp(v) - 1) * 100));
  const safe = map2(lagDiff(lnSpy, 20), lagDiff(ln(tlt), 20), (a, c) => (a - c) * 100);
  const small = lagDiff(map2(ln(iwm), lnSpy, (a, c) => a - c), 63).map((v) => (v === null ? null : v * 100));
  const ew = lagDiff(map2(ln(rsp), lnSpy, (a, c) => a - c), 63).map((v) => (v === null ? null : v * 100));

  // display = the reading shown on the card; signal = what gets standardized.
  const series = {
    vix: { display: vix, signal: ln(vix) },
    vixterm: { display: map2(vix, vix3m, (a, c) => a / c), signal: map2(ln(vix), ln(vix3m), (a, c) => a - c) },
    realizedvol: { display: realized, signal: realized },
    skew: { display: skew, signal: ln(skew) },
    highprox: { display: hi252, signal: hi252 },
    momentum: { display: mom, signal: mom },
    breadthadline: { display: adv10.map((v) => (v === null ? null : v * 100)), signal: adv10 },
    breadthhilo: { display: hl10, signal: hl10 },
    breadthpct200: { display: pct200, signal: pct200 },
    credit: { display: creditPct, signal: creditDev },
    safehaven: { display: safe, signal: safe },
    smallcap: { display: small, signal: small },
    equalweight: { display: ew, signal: ew },
  };

  const missing = [];
  const active = [];
  for (const f of FACTORS) {
    const s = series[f.id];
    if (!s || !s.signal.some((v) => v !== null)) { missing.push(f.id); continue; }
    const { z, mean, sd } = rollingZ(s.signal);
    const scores = z.map((v) => (v === null ? null : scoreFromZ(v, f.invert)));
    active.push({ f, s, z, mean, sd, scores });
  }

  // Two-level equal weight: mean of available factor scores within each
  // pillar, then mean of the available pillar scores. Coverage is the share
  // of the full (all-factors-present) weight actually carried on that date.
  const pillarIds = PILLARS.map((p) => p.id);
  const perPillar = {};
  for (const pid of pillarIds) perPillar[pid] = active.filter((a) => a.f.pillar === pid);
  const nominalWeight = (a) => 1 / pillarIds.length / perPillar[a.f.pillar].length;
  const effWeightAt = (i) => {
    const w = new Map();
    const live = pillarIds.filter((pid) => perPillar[pid].some((a) => a.scores[i] !== null));
    for (const pid of live) {
      const avail = perPillar[pid].filter((a) => a.scores[i] !== null);
      for (const a of avail) w.set(a.f.id, 1 / live.length / avail.length);
    }
    return w;
  };

  const composite = new Array(n).fill(null);
  const coverage = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const w = effWeightAt(i);
    if (!w.size) continue;
    let acc = 0;
    let cov = 0;
    for (const a of active) {
      const wt = w.get(a.f.id);
      if (wt) { acc += a.scores[i] * wt; cov += nominalWeight(a); }
    }
    coverage[i] = cov;
    if (cov >= MIN_COVERAGE) composite[i] = acc;
  }

  const first = Math.max(0, n - historyPoints);
  const history = [];
  for (let i = first; i < n; i++) {
    if (composite[i] === null || dates[i] < HISTORY_START) continue;
    history.push({ date: dates[i], optimism: round(composite[i], 1), spy: round(spyClose[i], 2), coverage: round(coverage[i], 2) });
  }

  const last = n - 1;
  const lastWeights = effWeightAt(last);
  const components = active
    .filter((a) => a.scores[last] !== null)
    .map((a) => {
      const score = a.scores[last];
      const from = Math.max(0, n - componentHistoryPoints);
      const hist = [];
      for (let i = from; i < n; i++) if (a.s.display[i] !== null) hist.push({ date: dates[i], value: round(a.s.display[i], 3) });
      let lastReal = last;
      while (lastReal > 0 && a.s.display[lastReal] === null) lastReal--;
      return {
        id: a.f.id,
        name: a.f.name,
        group: PILLARS.find((p) => p.id === a.f.pillar).name,
        pillar: a.f.pillar,
        value: round(a.s.display[last], 2),
        unit: a.f.unit,
        percentile: null,
        score: round(score, 1),
        z: round(a.z[last], 2),
        weight: round(nominalWeight(a) * 100, 2),
        effectiveWeight: round(lastWeights.get(a.f.id) * 100, 2),
        contribution: round((score - 50) * lastWeights.get(a.f.id), 2),
        source: a.f.source,
        description: a.f.description,
        details: a.f.details,
        history: hist,
        calc: {
          signalLabel: a.f.signalLabel,
          invert: a.f.invert,
          signal: round(a.s.signal[last], 4),
          mean: round(a.mean[last], 4),
          sd: round(a.sd[last], 4),
          z: round(a.z[last], 3),
          window: Math.min(Z_MAX_WINDOW, last + 1),
        },
        asOf: dates[lastReal],
      };
    });
  // percentile of today's display reading within the shown history
  for (const c of components) {
    const vals = c.history.map((h) => h.value).sort((x, y) => x - y);
    if (vals.length) {
      const below = vals.filter((v) => v <= c.value).length;
      c.percentile = Math.round((100 * below) / vals.length);
    }
  }
  components.sort((a, b) => PILLARS.findIndex((p) => p.id === a.pillar) - PILLARS.findIndex((p) => p.id === b.pillar));

  const latest = history.length ? history[history.length - 1] : null;
  return {
    composite: latest ? Math.round(latest.optimism) : null,
    compositeExact: latest ? latest.optimism : null,
    asOfDate: latest ? latest.date : null,
    coverage: latest ? latest.coverage : null,
    components,
    history,
    missing,
    ...(debug ? { debug: { dates, composite, scores: Object.fromEntries(active.map((a) => [a.f.id, a.scores])) } } : {}),
    methodology: {
      zWindowDays: Z_MAX_WINDOW,
      zMinObservations: Z_MIN_OBS,
      zClamp: Z_CLAMP,
      minCoverage: MIN_COVERAGE,
      pillars: PILLARS.map((p) => ({ id: p.id, name: p.name, weight: round(100 / PILLARS.length, 1) })),
    },
  };
}

module.exports = { buildIndex, FACTORS, PILLARS, rollingZ, scoreFromZ, normCdf, MIN_COVERAGE };
