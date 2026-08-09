// Scheduled function (see [functions."scheduled-factors-background"] in
// netlify.toml) that pulls Fama-French daily factor returns from the Ken
// French Data Library at Dartmouth — the standard academic source for
// these series, not Alpha Vantage — and writes the merged daily history
// to Netlify Blobs for factors.js to serve.
//
// Two source files, both daily, both starting 1926-07-01:
//   F-F_Research_Data_Factors_daily_CSV.zip — Mkt-RF, SMB (size), HML
//     (value), RF (risk-free rate), the original 3-factor model.
//   F-F_Momentum_Factor_daily_CSV.zip — Mom (momentum/UMD), Fama-French's
//     separate momentum series, not part of the 3-factor download.
// Both are %-return values (e.g. 0.09 means +0.09%), matching how Ken
// French publishes them — left as-is rather than converted to decimals,
// since that's the convention anyone cross-referencing this against the
// original source will expect.
//
// Each file is a zipped CSV with a multi-line free-text preamble, a
// header row starting with a blank first column (",Mkt-RF,SMB,HML,RF" /
// ",Mom"), then one row per trading day as YYYYMMDD, followed by a
// trailing copyright line — parseCsv() below scans for exactly the
// numeric-date rows and ignores everything else, so it doesn't care
// about the preamble's exact wording (which does change between
// updates).
//
// Runs weekly, not daily (see the schedule in netlify.toml): Ken French
// updates this data roughly monthly, so a daily job would spend 6/7 of
// its runs re-downloading and re-parsing ~180k unchanged data points for
// nothing.

const AdmZip = require("adm-zip");
const { getFactorsStore, BLOB_KEY } = require("./factors-blob-store");

const BASE_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp";
const FF3_URL = `${BASE_URL}/F-F_Research_Data_Factors_daily_CSV.zip`;
const MOM_URL = `${BASE_URL}/F-F_Momentum_Factor_daily_CSV.zip`;

async function fetchZipCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error(`Empty zip at ${url}`);
  // Each of these zips contains exactly one CSV; grab whichever entry
  // isn't a directory rather than hardcoding a filename, since Ken
  // French's filenames have shifted case/wording between releases.
  const entry = entries.find((e) => !e.isDirectory) || entries[0];
  return entry.getData().toString("utf8");
}

// Parses the "date, val, val, ..." rows out of a Ken French CSV, skipping
// the free-text preamble/footer around them. Returns { columns, rows },
// where columns are the header names (e.g. ["Mkt-RF","SMB","HML","RF"])
// and rows are { date: "YYYY-MM-DD", values: [number, ...] }.
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => /^,\s*\S/.test(l));
  if (headerIndex === -1) throw new Error("Couldn't find header row in Ken French CSV");
  const columns = lines[headerIndex].split(",").slice(1).map((c) => c.trim());

  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    const dateStr = parts[0].trim();
    if (!/^\d{8}$/.test(dateStr)) break; // hit the trailing copyright/footer text
    const date = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    const values = parts.slice(1).map((v) => parseFloat(v.trim()));
    rows.push({ date, values });
  }
  return { columns, rows };
}

exports.handler = async () => {
  console.log("scheduled-factors-background: starting");
  try {
    const [ff3Text, momText] = await Promise.all([fetchZipCsv(FF3_URL), fetchZipCsv(MOM_URL)]);

    const ff3 = parseCsv(ff3Text);
    const mom = parseCsv(momText);
    console.log(`scheduled-factors-background: parsed ${ff3.rows.length} FF3 rows, ${mom.rows.length} momentum rows`);

    const momByDate = new Map(mom.rows.map((r) => [r.date, r.values[mom.columns.indexOf("Mom")]]));

    const mktIdx = ff3.columns.indexOf("Mkt-RF");
    const smbIdx = ff3.columns.indexOf("SMB");
    const hmlIdx = ff3.columns.indexOf("HML");
    const rfIdx = ff3.columns.indexOf("RF");
    if ([mktIdx, smbIdx, hmlIdx, rfIdx].includes(-1)) {
      throw new Error(`Unexpected FF3 columns: ${ff3.columns.join(",")}`);
    }

    const rows = ff3.rows.map((r) => ({
      date: r.date,
      mktRf: r.values[mktIdx],
      smb: r.values[smbIdx],
      hml: r.values[hmlIdx],
      rf: r.values[rfIdx],
      mom: momByDate.has(r.date) ? momByDate.get(r.date) : null,
    }));

    const payload = {
      generated_at_utc: new Date().toISOString(),
      source: "Ken French Data Library (Dartmouth)",
      units: "percent (e.g. 0.09 = +0.09%)",
      rows,
    };

    const store = getFactorsStore();
    await store.setJSON(BLOB_KEY, payload);
    console.log(`scheduled-factors-background: wrote ${rows.length} rows to blob`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, rows: rows.length }),
    };
  } catch (err) {
    console.error(`scheduled-factors-background: FAILED: ${err.message}`);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
