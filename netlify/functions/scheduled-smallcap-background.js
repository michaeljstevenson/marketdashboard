// Scheduled Background Function (see [functions."scheduled-smallcap-
// background"] in netlify.toml) that builds the dataset behind
// /small-cap-vs-large-cap.html and writes it to Netlify Blobs for
// smallcap-largecap.js to serve:
//   - aligned, indexed daily total-return history for IWM (Russell 2000),
//     IJR (S&P SmallCap 600), MDY (S&P MidCap 400) and SPY (S&P 500) from
//     Yahoo Finance adjusted closes, plus a trailing-return ladder
//   - IJR vs. IWM summary statistics and calendar-year returns
//   - monthly effective Fed funds rate (FRED FEDFUNDS) and 10-year Treasury
//     yield (FRED GS10, monthly average, the same series Alpha Vantage's
//     TREASURY_YIELD monthly returned, so the page's regime and correlation
//     numbers carry over unchanged)
//   - the size premium since 1926 and the forward-return study after extreme
//     trailing spreads, from Ken French's value-weighted size quintiles
//
// Ken French publishes about once a month, so the parsed file is cached in
// its own blob and only downloaded again when the zip's Last-Modified header
// changes. Seven requests a run otherwise, well inside a minute.

const AdmZip = require("adm-zip");
const { getSmallcapStore, BLOB_KEY, SIZE_KEY } = require("./smallcap-blob-store");
const { fetchDailyHistory, sleep } = require("./yahoo-client");

const SMALL = "IWM";
const SMALL_SP600 = "IJR";
const MID = "MDY";
const LARGE = "SPY";

const FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";
const KF_SIZE_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/Portfolios_Formed_on_ME_CSV.zip";
const KF_SMALL_COL = "Lo 20";
const KF_LARGE_COL = "Hi 20";

const LOOKBACK_YEARS = [3, 5];
const FORWARD_YEARS = [1, 3, 5];
const MIN_OBS_FOR_T = 12;
// Months in an extreme tenth separated by no more than this many months of
// ordinary readings count as one episode.
const EPISODE_GAP_MONTHS = 12;

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (v, d = 2) => (v == null ? null : round(v * 100, d));

async function fetchSeries(symbol) {
  const rows = await fetchDailyHistory(symbol, { adjusted: true });
  return { dates: rows.map((r) => r.date), closes: rows.map((r) => r.close) };
}

// FRED's graph CSV needs no key. Missing observations (holidays in the daily
// series) come through as an empty value, or "." in older exports.
async function fetchFred(seriesId) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    try {
      const res = await fetch(FRED_CSV_URL + seriesId);
      if (!res.ok) throw new Error(`HTTP ${res.status} for FRED ${seriesId}`);
      const lines = (await res.text()).trim().split(/\r?\n/);
      if (!/^observation_date,/i.test(lines[0] || "") && !/^DATE,/i.test(lines[0] || "")) {
        throw new Error(`FRED ${seriesId}: unexpected header ${String(lines[0]).slice(0, 80)}`);
      }
      const out = [];
      for (const line of lines.slice(1)) {
        const [date, raw] = line.split(",");
        const value = parseFloat(raw);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value)) out.push({ date, value });
      }
      if (!out.length) throw new Error(`FRED ${seriesId}: no observations`);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// "Average Value Weight Returns -- Monthly" block of Portfolios_Formed_on_ME.
function parseKfSize(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /Value Weight Returns\s*--\s*Monthly/i.test(l));
  if (start === -1) throw new Error("Ken French size file: value-weighted monthly block not found");
  const columns = lines[start + 1].split(",").map((c) => c.trim());
  const sIdx = columns.indexOf(KF_SMALL_COL);
  const lIdx = columns.indexOf(KF_LARGE_COL);
  if (sIdx < 1 || lIdx < 1) throw new Error(`Ken French size file: columns ${columns.join("|")}`);
  const months = [];
  const small = [];
  const large = [];
  for (let i = start + 2; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const ym = parts[0].trim();
    if (!/^\d{6}$/.test(ym)) break;
    const s = parseFloat(parts[sIdx]);
    const l = parseFloat(parts[lIdx]);
    if (!Number.isFinite(s) || !Number.isFinite(l) || s <= -99 || l <= -99) {
      throw new Error(`Ken French size file: missing value in ${ym}`);
    }
    months.push(`${ym.slice(0, 4)}-${ym.slice(4, 6)}`);
    small.push(s);
    large.push(l);
  }
  if (months.length < 1000) throw new Error(`Ken French size file: only ${months.length} months parsed`);
  const crsp = (text.match(/created using the (\d{6}) CRSP/) || [])[1] || null;
  return { months, small, large, crspVintage: crsp };
}

async function loadSizePortfolios(store) {
  let cached = null;
  try {
    cached = await store.get(SIZE_KEY, { type: "json" });
  } catch (err) {
    console.warn(`scheduled-smallcap-background: size cache read failed: ${err.message}`);
  }
  let lastModified = null;
  try {
    const head = await fetch(KF_SIZE_URL, { method: "HEAD" });
    if (head.ok) lastModified = head.headers.get("last-modified");
  } catch (err) {
    console.warn(`scheduled-smallcap-background: Ken French HEAD failed: ${err.message}`);
  }
  if (cached && lastModified && cached.sourceLastModified === lastModified) return { ...cached, refreshed: false };
  try {
    const res = await fetch(KF_SIZE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching Ken French size portfolios`);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const entry = zip.getEntries().find((e) => !e.isDirectory);
    if (!entry) throw new Error("Ken French size zip is empty");
    const parsed = parseKfSize(entry.getData().toString("utf8"));
    const record = {
      ...parsed,
      sourceLastModified: lastModified || res.headers.get("last-modified"),
      fetchedAt: new Date().toISOString(),
    };
    await store.setJSON(SIZE_KEY, record);
    return { ...record, refreshed: true };
  } catch (err) {
    if (!cached) throw err;
    console.warn(`scheduled-smallcap-background: Ken French refresh failed, using cached copy: ${err.message}`);
    return { ...cached, refreshed: false };
  }
}

// Latest close on or before targetDate (dates ascending).
function closeOnOrBefore(hist, targetDate) {
  const { dates, closes } = hist;
  let lo = 0;
  let hi = dates.length - 1;
  if (!dates.length || dates[0] > targetDate) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (dates[mid] <= targetDate) lo = mid;
    else hi = mid - 1;
  }
  return { date: dates[lo], close: closes[lo] };
}

function addCalendarMonths(dateStr, months) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

// Cumulative % under a year, calendar-day-annualized from a year up, using the
// actual elapsed days since closeOnOrBefore can land short of the anniversary.
function trailingReturn(hist, latestDate, latestClose, monthsBack) {
  const targetDate = addCalendarMonths(latestDate, monthsBack);
  const found = closeOnOrBefore(hist, targetDate);
  if (!found) return null;
  const elapsedDays = (new Date(latestDate) - new Date(found.date)) / 86400000;
  if (elapsedDays <= 0) return null;
  const cumPct = (latestClose / found.close - 1) * 100;
  if (monthsBack < 12) return { cumPct: Math.round(cumPct * 100) / 100, annualized: false };
  const annPct = (Math.pow(latestClose / found.close, 365.25 / elapsedDays) - 1) * 100;
  return { cumPct: Math.round(annPct * 100) / 100, annualized: true };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function percentileOf(values, v) {
  return (values.filter((x) => x <= v).length / values.length) * 100;
}

function seriesStats(dates, closes) {
  const n = closes.length;
  const years = (new Date(dates[n - 1]) - new Date(dates[0])) / (365.25 * 86400000);
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
  let peak = closes[0];
  let peakDate = dates[0];
  let maxDd = 0;
  let maxDdDate = dates[0];
  let maxDdPeakDate = dates[0];
  for (let i = 0; i < n; i++) {
    if (closes[i] > peak) {
      peak = closes[i];
      peakDate = dates[i];
    }
    const dd = closes[i] / peak - 1;
    if (dd < maxDd) {
      maxDd = dd;
      maxDdDate = dates[i];
      maxDdPeakDate = peakDate;
    }
  }
  return {
    annReturnPct: pct(Math.pow(closes[n - 1] / closes[0], 1 / years) - 1),
    annVolPct: pct(sd * Math.sqrt(252)),
    maxDrawdownPct: pct(maxDd),
    maxDrawdownPeak: maxDdPeakDate,
    maxDrawdownTrough: maxDdDate,
    currentDrawdownPct: pct(closes[n - 1] / peak - 1),
    growthOf1: round(closes[n - 1] / closes[0], 2),
  };
}

function calendarYears(dates, a, b) {
  const lastIdxByYear = new Map();
  dates.forEach((d, i) => lastIdxByYear.set(d.slice(0, 4), i));
  const years = [...lastIdxByYear.keys()];
  const latestYear = dates[dates.length - 1].slice(0, 4);
  return years.map((y, k) => {
    const end = lastIdxByYear.get(y);
    const base = k === 0 ? 0 : lastIdxByYear.get(years[k - 1]);
    return {
      year: Number(y),
      partial: k === 0 || y === latestYear,
      fromDate: dates[base],
      toDate: dates[end],
      ijrPct: pct(a[end] / a[base] - 1),
      iwmPct: pct(b[end] / b[base] - 1),
    };
  });
}

// Group means of y with Newey-West (Bartlett) covariance. Regressing y on a
// full set of group dummies gives each group's mean as a coefficient, and
// the HAC covariance is taken over consecutive months, so overlap between
// neighbouring forward windows is handled even when a group's months are
// scattered through time.
function groupMeansHac(y, groupOf, k, lag) {
  const n = y.length;
  const counts = new Array(k).fill(0);
  const sums = new Array(k).fill(0);
  for (let t = 0; t < n; t++) {
    counts[groupOf[t]]++;
    sums[groupOf[t]] += y[t];
  }
  const means = sums.map((s, g) => (counts[g] ? s / counts[g] : null));
  const e = y.map((v, t) => v - means[groupOf[t]]);
  const S = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let t = 0; t < n; t++) S[groupOf[t]][groupOf[t]] += e[t] * e[t];
  for (let l = 1; l <= Math.min(lag, n - 1); l++) {
    const w = 1 - l / (lag + 1);
    for (let t = l; t < n; t++) {
      const g = groupOf[t];
      const h = groupOf[t - l];
      const c = w * e[t] * e[t - l];
      S[g][h] += c;
      S[h][g] += c;
    }
  }
  const V = S.map((row, g) => row.map((s, h) => (counts[g] && counts[h] ? s / (counts[g] * counts[h]) : 0)));
  const contrast = (c) => {
    const est = c.reduce((acc, w, g) => acc + (w ? w * means[g] : 0), 0);
    let v = 0;
    for (let g = 0; g < k; g++) for (let h = 0; h < k; h++) v += c[g] * c[h] * V[g][h];
    const se = Math.sqrt(Math.max(v, 0));
    return { est, se, t: se > 0 ? est / se : null };
  };
  return { counts, means, contrast };
}

function spells(monthIdx, months, maxGap) {
  const out = [];
  for (const i of monthIdx) {
    const last = out[out.length - 1];
    if (last && i - last.endIdx <= maxGap + 1) {
      last.endIdx = i;
      last.months++;
    } else {
      out.push({ startIdx: i, endIdx: i, months: 1 });
    }
  }
  return out.map((s) => ({ start: months[s.startIdx], end: months[s.endIdx], months: s.months, startIdx: s.startIdx, endIdx: s.endIdx }));
}

function nonOverlapping(monthIdx, span) {
  let count = 0;
  let next = -Infinity;
  for (const i of monthIdx) {
    if (i >= next) {
      count++;
      next = i + span;
    }
  }
  return count;
}

function monthEndRatio(dates, ratio) {
  const map = new Map();
  dates.forEach((d, i) => map.set(d.slice(0, 7), ratio[i]));
  return map;
}

function nextMonth(ym) {
  let [y, m] = ym.split("-").map(Number);
  m += 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

function buildSizeHistory(kf, etf) {
  const { months } = kf;
  const n = months.length;
  const rel = kf.small.map((s, i) => (1 + s / 100) / (1 + kf.large[i] / 100) - 1);
  const cumLog = [0];
  const cumS = [0];
  const cumL = [0];
  for (let i = 0; i < n; i++) {
    cumLog.push(cumLog[i] + Math.log(1 + rel[i]));
    cumS.push(cumS[i] + Math.log(1 + kf.small[i] / 100));
    cumL.push(cumL[i] + Math.log(1 + kf.large[i] / 100));
  }
  // Annualized over months a..b inclusive.
  const ann = (cum, a, b) => Math.exp(((cum[b + 1] - cum[a]) * 12) / (b - a + 1)) - 1;

  const full = {
    from: months[0],
    to: months[n - 1],
    months: n,
    smallAnnPct: pct(ann(cumS, 0, n - 1)),
    largeAnnPct: pct(ann(cumL, 0, n - 1)),
    relAnnPct: pct(ann(cumLog, 0, n - 1)),
    smallGrowthOf1: round(Math.exp(cumS[n]), 0),
    largeGrowthOf1: round(Math.exp(cumL[n]), 0),
    pctMonthsSmallAhead: round((rel.filter((r) => r > 0).length / n) * 100, 1),
  };

  const decades = [];
  for (let d = Number(months[0].slice(0, 3)) * 10; d <= Number(months[n - 1].slice(0, 4)); d += 10) {
    const a = months.findIndex((m) => Number(m.slice(0, 4)) >= d);
    let b = -1;
    for (let i = n - 1; i >= 0; i--) if (Number(months[i].slice(0, 4)) < d + 10) { b = i; break; }
    if (a === -1 || b < a) continue;
    decades.push({
      decade: `${d}s`,
      from: months[a],
      to: months[b],
      months: b - a + 1,
      smallAnnPct: pct(ann(cumS, a, b)),
      largeAnnPct: pct(ann(cumL, a, b)),
      relAnnPct: pct(ann(cumLog, a, b)),
    });
  }

  // ETF monthly relative returns (IWM/SPY month-end ratio), for the overlap
  // check, the rolling chart's ETF line and the months Ken French hasn't
  // published yet.
  const etfMonths = [...etf.keys()];
  const etfRel = new Map();
  for (let i = 1; i < etfMonths.length; i++) etfRel.set(etfMonths[i], etf.get(etfMonths[i]) / etf.get(etfMonths[i - 1]) - 1);

  const window10 = 120;
  const allMonths = months.slice();
  for (let m = nextMonth(months[n - 1]); m <= etfMonths[etfMonths.length - 1]; m = nextMonth(m)) allMonths.push(m);
  const etfCum = new Map();
  let acc = 0;
  for (const m of etfMonths.slice(1)) {
    acc += Math.log(1 + etfRel.get(m));
    etfCum.set(m, acc);
  }
  const etfFirst = etfMonths[0];
  const rolling10 = { months: [], kf: [], etf: [] };
  allMonths.forEach((m, i) => {
    const kfVal = i < n && i >= window10 - 1 ? pct(ann(cumLog, i - window10 + 1, i), 2) : null;
    let etfVal = null;
    const startKey = allMonths[i - window10];
    if (startKey && startKey >= etfFirst && etfCum.has(m)) {
      const base = startKey === etfFirst ? 0 : etfCum.get(startKey);
      if (base != null) etfVal = pct(Math.exp((etfCum.get(m) - base) / 10) - 1, 2);
    }
    if (kfVal == null && etfVal == null) return;
    rolling10.months.push(m);
    rolling10.kf.push(kfVal);
    rolling10.etf.push(etfVal);
  });

  const overlap = months.map((m, i) => [rel[i], etfRel.get(m)]).filter((p) => p[1] != null);
  let overlapCheck = null;
  if (overlap.length > 24) {
    const xs = overlap.map((p) => p[0]);
    const ys = overlap.map((p) => p[1]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    xs.forEach((x, i) => {
      sxy += (x - mx) * (ys[i] - my);
      sxx += (x - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    });
    const annOf = (arr) => Math.exp((arr.reduce((a, r) => a + Math.log(1 + r), 0) * 12) / arr.length) - 1;
    overlapCheck = {
      from: months.find((m) => etfRel.has(m)),
      to: months[n - 1],
      months: overlap.length,
      correlation: round(sxy / Math.sqrt(sxx * syy), 2),
      kfRelAnnPct: pct(annOf(xs)),
      etfRelAnnPct: pct(annOf(ys)),
    };
  }

  // Extreme-spread study.
  const study = {};
  const scatter = { months, trailing: {}, forward: {} };
  for (const H of FORWARD_YEARS) {
    const span = 12 * H;
    scatter.forward[H] = months.map((m, i) => (i + span < n ? pct(Math.exp((cumLog[i + span + 1] - cumLog[i + 1]) / H) - 1, 2) : null));
  }
  const latestEtfMonth = etfMonths[etfMonths.length - 1];
  const extraMonths = allMonths.slice(n);
  for (const K of LOOKBACK_YEARS) {
    const w = 12 * K;
    const trailing = months.map((m, i) => (i >= w - 1 ? Math.exp(((cumLog[i + 1] - cumLog[i + 1 - w]) * 1) / K) - 1 : null));
    scatter.trailing[K] = trailing.map((v) => pct(v, 2));
    const validIdx = trailing.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
    const sorted = validIdx.map((i) => trailing[i]).sort((a, b) => a - b);
    const p10 = quantile(sorted, 0.1);
    const p90 = quantile(sorted, 0.9);
    const groupOfIdx = (i) => (trailing[i] <= p10 ? 0 : trailing[i] >= p90 ? 2 : 1);

    const byHorizon = {};
    for (const H of FORWARD_YEARS) {
      const span = 12 * H;
      const idx = validIdx.filter((i) => i + span < n);
      const y = idx.map((i) => Math.exp((cumLog[i + span + 1] - cumLog[i + 1]) / H) - 1);
      const g = idx.map(groupOfIdx);
      const lag = span;
      const r = groupMeansHac(y, g, 3, lag);
      const [n0, n1, n2] = r.counts;
      const fmt = (c, count) => {
        const o = r.contrast(c);
        return { meanPct: pct(o.est), tStat: count >= MIN_OBS_FOR_T ? round(o.t) : null };
      };
      const hit = (grp) => {
        const sel = y.filter((_, k) => grp == null || g[k] === grp);
        return sel.length ? round((sel.filter((v) => v > 0).length / sel.length) * 100, 1) : null;
      };
      const ind = (grp) => nonOverlapping(idx.filter((_, k) => g[k] === grp), span);
      byHorizon[H] = {
        lagMonths: lag,
        all: { ...fmt([n0, n1, n2].map((c) => c / idx.length), idx.length), months: idx.length, hitPct: hit(null), independent: nonOverlapping(idx, span) },
        bottom: { ...fmt([1, 0, 0], n0), months: n0, hitPct: hit(0), independent: ind(0) },
        top: { ...fmt([0, 0, 1], n2), months: n2, hitPct: hit(2), independent: ind(2) },
        bottomMinusOther: fmt([1, -n1 / (n1 + n2), -n2 / (n1 + n2)], Math.min(n0, n1 + n2)),
        topMinusOther: fmt([-n0 / (n0 + n1), -n1 / (n0 + n1), 1], Math.min(n2, n0 + n1)),
        bottomMinusTop: fmt([1, 0, -1], Math.min(n0, n2)),
      };
    }

    const episodes = (grp) =>
      spells(validIdx.filter((i) => groupOfIdx(i) === grp), months, EPISODE_GAP_MONTHS).map((s) => {
        const vals = [];
        for (let i = s.startIdx; i <= s.endIdx; i++) vals.push(trailing[i]);
        return {
          start: s.start,
          end: s.end,
          monthsInTenth: validIdx.filter((i) => i >= s.startIdx && i <= s.endIdx && groupOfIdx(i) === grp).length,
          extremePct: pct(grp === 0 ? Math.min(...vals) : Math.max(...vals)),
        };
      });

    // Today's reading: Ken French months through its last release, then the
    // IWM/SPY ratio for the months since, the current month counted to date.
    const etfWindow = extraMonths.filter((m) => etfRel.has(m));
    const kfPart = w - etfWindow.length;
    let spliced = null;
    if (kfPart > 0 && kfPart <= n) {
      const logSum = cumLog[n] - cumLog[n - kfPart] + etfWindow.reduce((a, m) => a + Math.log(1 + etfRel.get(m)), 0);
      spliced = Math.exp(logSum / K) - 1;
    }
    const etfOnlyStart = etfMonths.length > w ? etfMonths[etfMonths.length - 1 - w] : null;
    const etfOnly = etfOnlyStart ? Math.pow(etf.get(latestEtfMonth) / etf.get(etfOnlyStart), 1 / K) - 1 : null;
    const kfLatest = trailing[n - 1];

    study[K] = {
      lookbackMonths: w,
      firstMonth: months[validIdx[0]],
      observations: validIdx.length,
      p10Pct: pct(p10),
      p90Pct: pct(p90),
      byHorizon,
      episodes: { bottom: episodes(0), top: episodes(2) },
      current: {
        asOfMonth: latestEtfMonth,
        kfMonths: kfPart,
        etfMonths: etfWindow,
        splicedPct: pct(spliced),
        splicedPercentile: spliced == null ? null : round(percentileOf(sorted, spliced), 1),
        etfOnlyPct: pct(etfOnly),
        etfOnlyPercentile: etfOnly == null ? null : round(percentileOf(sorted, etfOnly), 1),
        kfLastMonth: months[n - 1],
        kfLastPct: pct(kfLatest),
        kfLastPercentile: round(percentileOf(sorted, kfLatest), 1),
      },
    };
  }

  return {
    source: "Ken French Data Library, Portfolios Formed on Size, value-weighted monthly returns",
    smallPortfolio: "Bottom size quintile (Lo 20)",
    largePortfolio: "Top size quintile (Hi 20)",
    crspVintage: kf.crspVintage,
    sourceLastModified: kf.sourceLastModified,
    full,
    decades,
    rolling10,
    overlapCheck,
    study,
    scatter,
  };
}

exports.handler = async () => {
  const started = Date.now();
  console.log("scheduled-smallcap-background: starting");
  try {
    const store = getSmallcapStore();
    const histSmall = await fetchSeries(SMALL);
    await sleep(300);
    const histSp600 = await fetchSeries(SMALL_SP600);
    await sleep(300);
    const histMid = await fetchSeries(MID);
    await sleep(300);
    const histLarge = await fetchSeries(LARGE);
    const fedFundsMonthly = await fetchFred("FEDFUNDS");
    const treasury10yMonthly = await fetchFred("GS10");
    const kf = await loadSizePortfolios(store);

    // SPY's calendar from the later of IWM's and MDY's first day (IWM, May
    // 2000, binds). IJR's Yahoo history starts the same day as IWM's.
    const commonStart = histSmall.dates[0] > histMid.dates[0] ? histSmall.dates[0] : histMid.dates[0];
    const dates = histLarge.dates.filter((d) => d >= commonStart);
    if (!dates.length) throw new Error("no overlapping trading days across IWM/MDY/SPY");
    if (histSp600.dates[0] > dates[0]) throw new Error(`IJR history starts ${histSp600.dates[0]}, after ${dates[0]}`);

    const base = (h) => closeOnOrBefore(h, dates[0]).close;
    const smallBase = base(histSmall);
    const sp600Base = base(histSp600);
    const midBase = base(histMid);
    const largeBase = base(histLarge);

    const small = [];
    const smallSp600 = [];
    const mid = [];
    const large = [];
    const ratioSmallLarge = [];
    const ratioMidLarge = [];
    const rawSmall = [];
    const rawSp600 = [];
    const rawLarge = [];
    for (const d of dates) {
      const sClose = closeOnOrBefore(histSmall, d).close;
      const qClose = closeOnOrBefore(histSp600, d).close;
      rawSmall.push(sClose);
      rawSp600.push(qClose);
      const s = (sClose / smallBase) * 100;
      const q = (qClose / sp600Base) * 100;
      const m = (closeOnOrBefore(histMid, d).close / midBase) * 100;
      const lClose = closeOnOrBefore(histLarge, d).close;
      rawLarge.push(lClose);
      const l = (lClose / largeBase) * 100;
      small.push(round(s));
      smallSp600.push(round(q));
      mid.push(round(m));
      large.push(round(l));
      ratioSmallLarge.push(round((s / l) * 100));
      ratioMidLarge.push(round((m / l) * 100));
    }

    const latestDate = dates[dates.length - 1];
    const periods = [
      { key: "1M", months: 1 },
      { key: "3M", months: 3 },
      { key: "6M", months: 6 },
      { key: "1Y", months: 12 },
      { key: "3Y", months: 36 },
      { key: "5Y", months: 60 },
      { key: "10Y", months: 120 },
    ];
    const ladder = { periods: periods.map((p) => p.key) };
    for (const [label, hist] of [["small", histSmall], ["mid", histMid], ["large", histLarge]]) {
      const latestClose = closeOnOrBefore(hist, latestDate).close;
      ladder[label] = periods.map((p) => trailingReturn(hist, latestDate, latestClose, p.months));
    }

    const years = calendarYears(dates, rawSp600, rawSmall);
    const fullYears = years.filter((y) => !y.partial);
    const ijrRatio = rawSp600.map((v, i) => v / rawSmall[i]);
    const sp600VsR2000 = {
      from: dates[0],
      to: latestDate,
      ijr: seriesStats(dates, rawSp600),
      iwm: seriesStats(dates, rawSmall),
      relativeAnnPct: pct(Math.pow(ijrRatio[ijrRatio.length - 1] / ijrRatio[0], 1 / ((new Date(latestDate) - new Date(dates[0])) / (365.25 * 86400000))) - 1),
      fullYears: fullYears.length,
      ijrBeatYears: fullYears.filter((y) => y.ijrPct > y.iwmPct).length,
      ijrBeatPct: round((fullYears.filter((y) => y.ijrPct > y.iwmPct).length / fullYears.length) * 100, 1),
      years,
    };

    const sizeHistory = buildSizeHistory(kf, monthEndRatio(dates, rawSmall.map((v, i) => v / rawLarge[i])));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      asOfDate: latestDate,
      commonStartDate: dates[0],
      symbols: { small: SMALL, smallSp600: SMALL_SP600, mid: MID, large: LARGE },
      sources: { prices: "Yahoo Finance adjusted closes", fedFunds: "FRED FEDFUNDS", treasury10y: "FRED GS10", size: "Ken French Data Library" },
      dates,
      small,
      smallSp600,
      mid,
      large,
      ratioSmallLarge,
      ratioMidLarge,
      ladder,
      fedFundsMonthly,
      treasury10yMonthly,
      sp600VsR2000,
      sizeHistory,
    };

    await store.setJSON(BLOB_KEY, payload);
    console.log(
      `scheduled-smallcap-background: wrote ${dates.length} trading days as of ${latestDate}, Ken French through ${sizeHistory.full.to}` +
        ` (${kf.refreshed ? "downloaded" : "cached"}), ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true, days: dates.length, asOfDate: latestDate, kfThrough: sizeHistory.full.to }) };
  } catch (err) {
    console.error(`scheduled-smallcap-background: FAILED: ${err.message}`);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
