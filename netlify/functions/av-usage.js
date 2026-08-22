// Read-only endpoint exposing Alpha Vantage call counts recorded by
// av-call-counter.js, so daily usage can be checked without digging through
// Netlify function logs. GET /api/av-usage?days=14 (default 14).

const { getAvCallCounts } = require("./av-call-counter");

exports.handler = async (event) => {
  const days = Math.max(1, parseInt(event.queryStringParameters?.days, 10) || 14);

  const counts = await getAvCallCounts();
  const sortedDates = Object.keys(counts).sort();
  const recentDates = sortedDates.slice(-days);
  const recentCounts = recentDates.map((d) => counts[d]);
  const total = recentCounts.reduce((sum, c) => sum + c, 0);
  const average = recentDates.length ? total / recentDates.length : 0;

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({
      windowDays: days,
      daysWithData: recentDates.length,
      dailyCounts: Object.fromEntries(recentDates.map((d) => [d, counts[d]])),
      totalCalls: total,
      dailyAverage: Math.round(average * 10) / 10,
    }),
  };
};
