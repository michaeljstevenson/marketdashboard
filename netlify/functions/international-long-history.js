// Long-history helpers for scheduled-international-background.js: Ken French
// downloads and parsers, month-end resampling, the leadership-cycle finder
// and rolling correlations. Kept separate from the job so a local harness can
// run the same code against the real files.
//
// Three Ken French files, all monthly, all in US dollars:
//   F-F_International_Indices.zip, Ind_all.Dat: the "Major Markets" index
//     (EAFE + Canada country weights) from January 1975, with dollar AND
//     local-currency returns. Updated once a year, so it usually ends at the
//     previous December.
//   F-F_Research_Data_Factors_CSV.zip: US market = Mkt-RF + RF, from 1926.
//   Emerging_5_Factors_CSV.zip: emerging market = Mkt-RF + RF, from July 1989.
//     Its RF column is the US one-month T-bill, so adding it back gives the
//     dollar total return.

const AdmZip = require("adm-zip");

const KF_BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp";
const KF_URLS = {
  intlIndices: `${KF_BASE}/F-F_International_Indices.zip`,
  usFactors: `${KF_BASE}/F-F_Research_Data_Factors_CSV.zip`,
  emFactors: `${KF_BASE}/Emerging_5_Factors_CSV.zip`,
};

async function fetchZipEntries(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 3000 * attempt));
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
      const entries = zip.getEntries().filter((e) => !e.isDirectory);
      if (!entries.length) throw new Error(`Empty zip at ${url}`);
      return entries.map((e) => ({ name: e.entryName, text: e.getData().toString("utf8") }));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const ymKey = (yyyymm) => `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}`;

// Monthly block of a Ken French factors CSV: the rows between the first
// header and the "Annual Factors" block. Returns [{ ym, [col]: value }].
function parseKfFactorsMonthly(text) {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => /^\s*,\s*\S/.test(l));
  if (headerIndex === -1) throw new Error("Couldn't find header row in Ken French CSV");
  const columns = lines[headerIndex].split(",").slice(1).map((c) => c.trim());
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim());
    if (!/^\d{6}$/.test(parts[0])) break;
    const row = { ym: ymKey(parts[0]) };
    columns.forEach((c, k) => {
      const v = parseFloat(parts[k + 1]);
      row[c] = v <= -99.99 ? null : v;
    });
    rows.push(row);
  }
  return rows;
}

// Market = Mkt-RF + RF, in percent.
function kfMarketReturns(text) {
  return parseKfFactorsMonthly(text)
    .filter((r) => r["Mkt-RF"] != null && r.RF != null)
    .map((r) => ({ ym: r.ym, ret: Math.round((r["Mkt-RF"] + r.RF) * 1000) / 1000 }));
}

// Ind_all.Dat is whitespace-delimited with several titled blocks. The first
// monthly "Dollar Returns ... Not Reqd" block and the first monthly "Local
// Returns ... Not Reqd" block carry the market column ("Mkt", first value)
// for the dollar and local-currency versions.
function parseKfMajorMarkets(text) {
  const lines = text.split(/\r?\n/);
  const blocks = { dollar: null, local: null };
  for (let i = 0; i < lines.length; i++) {
    const title = lines[i];
    if (!/Not Req/i.test(title)) continue;
    const kind = /Dollar\s+Returns/i.test(title) ? "dollar" : /Local\s+Returns/i.test(title) ? "local" : null;
    if (!kind || blocks[kind]) continue;
    const rows = [];
    let j = i + 1;
    while (j < lines.length && !/^\s*\d{6}\s/.test(lines[j])) j++;
    for (; j < lines.length; j++) {
      const parts = lines[j].trim().split(/\s+/);
      if (!/^\d{6}$/.test(parts[0])) break;
      const v = parseFloat(parts[1]);
      if (v > -99.99) rows.push({ ym: ymKey(parts[0]), ret: v });
    }
    if (rows.length) blocks[kind] = rows;
  }
  if (!blocks.dollar || !blocks.local) throw new Error("Couldn't find the monthly dollar and local blocks in Ind_all.Dat");
  return blocks;
}

async function fetchKenFrenchLongHistory() {
  const [intlEntries, usEntries, emEntries] = [
    await fetchZipEntries(KF_URLS.intlIndices),
    await fetchZipEntries(KF_URLS.usFactors),
    await fetchZipEntries(KF_URLS.emFactors),
  ];
  const indAll = intlEntries.find((e) => /ind_all/i.test(e.name));
  if (!indAll) throw new Error(`Ind_all.Dat missing from ${KF_URLS.intlIndices}`);
  const major = parseKfMajorMarkets(indAll.text);
  return {
    fetchedAt: new Date().toISOString(),
    majorDollar: major.dollar,
    majorLocal: major.local,
    us: kfMarketReturns(usEntries[0].text),
    emerging: kfMarketReturns(emEntries[0].text),
  };
}

// Daily [{date, close}] -> month-end [{ ym, date, close }], ascending. The
// current month's entry is the latest close (month to date).
function monthEnds(daily) {
  const byMonth = new Map();
  for (const r of daily) byMonth.set(r.date.slice(0, 7), r);
  return [...byMonth.entries()].map(([ym, r]) => ({ ym, date: r.date, close: r.close }));
}

// Month-end closes -> monthly % returns. The first month has no prior
// month-end, so it's dropped.
function monthlyReturns(ends) {
  const out = [];
  for (let i = 1; i < ends.length; i++) {
    out.push({ ym: ends[i].ym, ret: (ends[i].close / ends[i - 1].close - 1) * 100 });
  }
  return out;
}

// Ken French months through its last month, then the ETF months after it.
// Returns [{ ym, ret, src }].
function splice(kfRows, etfRows, kfLabel, etfLabel) {
  const last = kfRows.length ? kfRows[kfRows.length - 1].ym : "";
  return [
    ...kfRows.map((r) => ({ ym: r.ym, ret: r.ret, src: kfLabel })),
    ...etfRows.filter((r) => r.ym > last).map((r) => ({ ym: r.ym, ret: r.ret, src: etfLabel })),
  ];
}

// Zigzag turning points on a positive series: a run counts as a new leg
// once the series moves `threshold` (log terms, symmetric up and down) away
// from the running extreme of the previous leg. The first leg starts at the
// first observation, so its start is a data limit, not a turning point.
function findCycles(values, threshold) {
  const lnTh = Math.log(1 + threshold);
  const n = values.length;
  const pivots = [];
  let trend = 0;
  let hi = 0;
  let lo = 0;
  let ext = 0;
  for (let i = 1; i < n; i++) {
    const v = values[i];
    if (trend === 0) {
      if (v > values[hi]) hi = i;
      if (v < values[lo]) lo = i;
      if (Math.log(values[hi] / values[lo]) >= lnTh) {
        if (hi > lo) {
          pivots.push({ idx: lo, kind: "trough" });
          trend = 1;
          ext = hi;
        } else {
          pivots.push({ idx: hi, kind: "peak" });
          trend = -1;
          ext = lo;
        }
        if (pivots[0].idx !== 0) pivots.unshift({ idx: 0, kind: "start" });
      }
    } else if (trend === 1) {
      if (v >= values[ext]) ext = i;
      else if (Math.log(values[ext] / v) >= lnTh) {
        pivots.push({ idx: ext, kind: "peak" });
        trend = -1;
        ext = i;
      }
    } else {
      if (v <= values[ext]) ext = i;
      else if (Math.log(v / values[ext]) >= lnTh) {
        pivots.push({ idx: ext, kind: "trough" });
        trend = 1;
        ext = i;
      }
    }
  }
  if (!pivots.length) return [];
  const legs = [];
  for (let k = 0; k < pivots.length; k++) {
    const startIdx = pivots[k].idx;
    const endIdx = k + 1 < pivots.length ? pivots[k + 1].idx : n - 1;
    if (endIdx <= startIdx) continue;
    const up = values[endIdx] >= values[startIdx];
    legs.push({ startIdx, endIdx, leader: up ? "international" : "us", ongoing: k + 1 >= pivots.length, fromDataStart: pivots[k].kind === "start" });
  }
  return legs;
}

function pearson(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// Rolling Pearson correlation of two monthly return series over `window`
// consecutive months both have. Returns [{ ym, r }] keyed by the window's
// last month.
function rollingCorrelation(a, b, window) {
  const bMap = new Map(b.map((r) => [r.ym, r.ret]));
  const paired = a.filter((r) => bMap.has(r.ym)).map((r) => ({ ym: r.ym, x: r.ret, y: bMap.get(r.ym) }));
  const out = [];
  for (let i = window - 1; i < paired.length; i++) {
    const slice = paired.slice(i - window + 1, i + 1);
    out.push({ ym: paired[i].ym, r: Math.round(pearson(slice.map((p) => p.x), slice.map((p) => p.y)) * 1000) / 1000 });
  }
  return out;
}

module.exports = {
  KF_URLS,
  fetchKenFrenchLongHistory,
  parseKfMajorMarkets,
  kfMarketReturns,
  monthEnds,
  monthlyReturns,
  splice,
  findCycles,
  pearson,
  rollingCorrelation,
};
