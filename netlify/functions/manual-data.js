// Manually-updated factor data.
//
// These three factors have no free, machine-fetchable live source: AAII's
// sentiment survey and FINRA's margin statistics site block automated
// (non-browser) requests, and forward P/E has no free index-level API
// (Alpha Vantage's fundamentals endpoint only covers individual equities,
// not indices/ETFs). Update each series below by hand when new data is
// published, appending a new {date, value} entry — do not delete old
// entries, since scoring compares each reading to its own trailing history.
//
// Sources to check periodically:
//   marginDebt: https://www.finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics
//               (monthly, published ~3rd week of the following month; use
//               "Debit Balances in Customers' Securities Margin Accounts")
//   fundFlows:  https://www.ici.org/research/stats/flows
//               (weekly; use the "Total equity" row, in $ millions)
//   forwardPE:  FactSet's free weekly "Earnings Insight" posts at
//               https://insight.factset.com/topic/earnings
//               (search the latest "S&P 500 Earnings Season/Insight Update"
//               post for "forward 12-month P/E ratio")

const MANUAL_SERIES = {
  marginDebt: {
    unit: "$M debit balances",
    history: [
      { date: "2025-06", value: 1007961 },
      { date: "2025-07", value: 1022548 },
      { date: "2025-08", value: 1059723 },
      { date: "2025-09", value: 1126494 },
      { date: "2025-10", value: 1183654 },
      { date: "2025-11", value: 1214321 },
      { date: "2025-12", value: 1225597 },
      { date: "2026-01", value: 1279042 },
      { date: "2026-02", value: 1253192 },
      { date: "2026-03", value: 1220922 },
      { date: "2026-04", value: 1304281 },
      { date: "2026-05", value: 1415557 },
      { date: "2026-06", value: 1502072 },
    ],
  },
  fundFlows: {
    unit: "$M weekly net flow (total equity)",
    history: [
      { date: "2026-06-24", value: -16482 },
      { date: "2026-07-01", value: -29914 },
      { date: "2026-07-08", value: -9664 },
      { date: "2026-07-15", value: -18104 },
      { date: "2026-07-22", value: -36490 },
    ],
  },
  forwardPE: {
    unit: "forward P/E",
    history: [
      { date: "2026-06-30", value: 20.4 },
      { date: "2026-07-17", value: 20.3 },
      { date: "2026-07-24", value: 20.1 },
    ],
  },
};

module.exports = { MANUAL_SERIES };
