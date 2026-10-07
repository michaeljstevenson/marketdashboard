// Trailing four-quarter EPS from the shared earnings collection, as known on
// a given date, for the jobs that value companies on earnings (Valuations,
// Earnings Growth vs. Price). Alpha Vantage's reportedEPS is the adjusted
// per-share figure, split-adjusted like Yahoo's close.

function num(v) {
  if (v === null || v === undefined || v === "" || v === "None") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Quarterly rows from the collection, ascending by report date.
function quartersFrom(earningsEntry) {
  return ((earningsEntry && earningsEntry.quarterlyEarnings) || [])
    .map((q) => ({ fiscalDateEnding: q.fiscalDateEnding, reportedDate: q.reportedDate, eps: num(q.reportedEPS) }))
    .filter((q) => q.reportedDate && q.fiscalDateEnding)
    .sort((a, b) => (a.reportedDate < b.reportedDate ? -1 : 1));
}

// The four latest quarters reported by `date`, provided they cover about one
// year (a gap in the record would otherwise sum the wrong quarters).
function ttmEpsOn(quarters, date) {
  const known = quarters.filter((q) => q.reportedDate <= date);
  if (known.length < 4) return null;
  const last4 = known.slice(-4);
  const span = (Date.parse(last4[3].fiscalDateEnding) - Date.parse(last4[0].fiscalDateEnding)) / 86400000;
  if (span < 240 || span > 320) return null;
  if (last4.some((q) => q.eps === null)) return null;
  return last4.reduce((s, q) => s + q.eps, 0);
}

module.exports = { quartersFrom, ttmEpsOn };
