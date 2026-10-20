// Offline unit checks for GL parsing and report summaries; run after `npm run build`.
import {
  parseGLRows,
  findGLAmountColumn,
  normalizeTxnTypeLabel,
} from "../dist/query/gl-postings.js";
import { extractReportSummary } from "../dist/reports/summary.js";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}

const col = (title, key) => ({
  ColTitle: title,
  ColType: "String",
  ...(key ? { MetaData: [{ Name: "ColKey", Value: key }] } : {}),
});
const cell = (value, id) => (id ? { value, id } : { value });
const report = (columns, rows) => ({
  Columns: { Column: columns },
  Rows: { Row: rows.map(cd => ({ type: "Data", ColData: cd })) },
});

// Multicurrency shape: home amount titled 'Amount', foreign amount titled 'Foreign Amount'
const multi = report(
  [
    col("Date", "tx_date"),
    col("Transaction Type", "txn_type"),
    col("Foreign Amount", "nat_foreign_amount"),
    col("Amount", "subt_nat_home_amount"),
  ],
  [[cell("2026-01-05"), cell("Paycheque", "101"), cell("999.00"), cell("1234.56")]],
);
let rows = parseGLRows(multi);
check("multicurrency: picks subt_nat_home_amount over nat_foreign_amount", rows[0]?.amount === 1234.56, `got ${rows[0]?.amount}`);
check("multicurrency: amount column index is 3", findGLAmountColumn(multi) === 3);

// Home key wins over subt_nat_amount when both are present
const both = report(
  [col("Date", "tx_date"), col("Transaction Type", "txn_type"), col("Other", "subt_nat_amount"), col("Amount", "subt_nat_home_amount")],
  [[cell("2026-01-05"), cell("Bill", "7"), cell("5.00"), cell("42.00")]],
);
check("home key preferred over subt_nat_amount", parseGLRows(both)[0]?.amount === 42);

// Single-currency shape
const single = report(
  [col("Date", "tx_date"), col("Transaction Type", "txn_type"), col("Amount", "subt_nat_amount")],
  [[cell("2026-02-01"), cell("Check", "55"), cell("-80.25")]],
);
check("single currency: picks subt_nat_amount", parseGLRows(single)[0]?.amount === -80.25);

// No MetaData: ColTitle fallback
const bare = report(
  [col("Date"), col("Transaction Type"), col("Amount")],
  [[cell("2026-03-01"), cell("Deposit", "9"), cell("10.50")]],
);
check("falls back to ColTitle 'Amount' without MetaData", parseGLRows(bare)[0]?.amount === 10.5);

// Foreign amount alone must never be used
const foreignOnly = report(
  [col("Date", "tx_date"), col("Transaction Type", "txn_type"), col("Foreign Amount", "nat_foreign_amount")],
  [[cell("2026-03-01"), cell("Deposit", "9"), cell("77.00")]],
);
check("never picks nat_foreign_amount", findGLAmountColumn(foreignOnly) === -1);

// Missing amount column is reported
const missing = report(
  [col("Date", "tx_date"), col("Transaction Type", "txn_type")],
  [[cell("2026-03-01"), cell("Deposit", "9")]],
);
check("reports amount column missing when absent", findGLAmountColumn(missing) === -1);

// Summary Columns line keeps the first real column
const pl = {
  Header: { ReportName: "ProfitAndLoss", StartPeriod: "2026-01-01", EndPeriod: "2026-12-31" },
  Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Amy's Bird Sanctuary" }, { ColTitle: "Cool Cars" }, { ColTitle: "TOTAL" }] },
  Rows: { Row: [] },
};
const colLine = extractReportSummary(pl, "ProfitAndLoss").split("\n").find(l => l.startsWith("Columns:")) ?? "";
check("summary Columns line contains Amy's Bird Sanctuary", colLine.includes("Amy's Bird Sanctuary"), colLine);
check("summary Columns line contains Cool Cars", colLine.includes("Cool Cars"), colLine);
check("summary Columns line drops the label column", !colLine.includes(", ,") && colLine === "Columns: Amy's Bird Sanctuary, Cool Cars, TOTAL", colLine);
const totalOnly = { ...pl, Columns: { Column: [{ ColTitle: "" }, { ColTitle: "Total" }] } };
check("summary omits Columns line for label+total only", !extractReportSummary(totalOnly, "ProfitAndLoss").includes("Columns:"));

// cheque/check normalization
const n = normalizeTxnTypeLabel;
check("Paycheck equals Paycheque", n("Paycheck") === n("Paycheque"));
check("Check equals Cheque", n("Check") === n("Cheque"));
check("case-insensitive", n("PAYCHEQUE") === n("paycheck"));
check("different types stay different", n("Paycheck") !== n("Check"));

if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
