// Handler for get_transaction_detail tool

import QuickBooks from "node-quickbooks";
import {
  promisify,
  resolveAccount,
  resolveCustomer,
  resolveClass,
  resolveEmployee,
  resolveVendor,
  resolveDepartmentId,
} from "../../client/index.js";
import { toCents, toDollars, outputReport, applyReportsMigrationFlag } from "../../utils/index.js";
import { parseGLRows, GLReport, GLParsedRow } from "../../query/index.js";

const GL_COLUMNS =
  "tx_date,txn_type,doc_num,name,emp_name,vend_name,cust_name,klass_name,dept_name,account_name,split_acc,memo,subt_nat_amount";

const DEFAULT_MAX_ROWS = 500;

type Totals = Record<string, number>;

function groupTotals(rows: GLParsedRow[], key: (r: GLParsedRow) => string | undefined): Totals {
  const cents = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) || "(none)";
    cents.set(k, (cents.get(k) ?? 0) + toCents(r.amount));
  }
  const out: Totals = {};
  for (const [k, v] of [...cents.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[k] = toDollars(v);
  }
  return out;
}

function compact(row: GLParsedRow): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const set = (k: string, v: string | undefined) => { if (v) out[k] = v; };
  set("date", row.date);
  set("type", row.type);
  set("txnId", row.txnId);
  set("docNumber", row.docNumber);
  set("name", row.name);
  set("customer", row.customer);
  set("employee", row.employee);
  set("vendor", row.vendor);
  set("class", row.class);
  set("department", row.department);
  set("account", row.account);
  set("split", row.split);
  set("memo", row.memo);
  out.amount = row.amount;
  return out;
}

export async function handleGetTransactionDetail(
  client: QuickBooks,
  args: {
    start_date?: string;
    end_date?: string;
    account?: string;
    customer?: string;
    employee?: string;
    vendor?: string;
    class?: string;
    department?: string;
    transaction_type?: string;
    accounting_method?: string;
    max_rows?: number;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { start_date, end_date, account, customer, employee, vendor, department, transaction_type, accounting_method } = args;
  const maxRows = args.max_rows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new Error(`max_rows must be a positive integer (got ${args.max_rows})`);
  }

  const today = new Date().toISOString().split("T")[0];
  const startResolved = start_date || `${new Date().getFullYear()}-01-01`;
  const endResolved = end_date || today;

  const options: Record<string, string> = {
    start_date: startResolved,
    end_date: endResolved,
    columns: GL_COLUMNS,
  };
  const filters: Record<string, string> = {};
  if (account) {
    const a = await resolveAccount(client, account);
    options.account = a.Id;
    filters.account = a.FullyQualifiedName || a.Name;
  }
  if (customer) {
    const c = await resolveCustomer(client, customer);
    options.customer = c.value;
    filters.customer = c.name;
  }
  if (employee) {
    const e = await resolveEmployee(client, employee);
    options.employee = e.value;
    filters.employee = e.name;
  }
  if (vendor) {
    const v = await resolveVendor(client, vendor);
    options.vendor = v.value;
    filters.vendor = v.name;
  }
  if (args.class) {
    const k = await resolveClass(client, args.class);
    options.class = k.value;
    filters.class = k.name;
  }
  if (department) {
    options.department = await resolveDepartmentId(client, department);
    filters.department = options.department;
  }
  if (accounting_method) options.accounting_method = accounting_method;
  applyReportsMigrationFlag(options);

  const report = await promisify<unknown>((cb) =>
    client.reportGeneralLedgerDetail(options, cb)
  ) as GLReport;

  let rows = parseGLRows(report).filter(r => r.type);
  if (transaction_type) {
    const want = transaction_type.toLowerCase();
    rows = rows.filter(r => r.type.toLowerCase() === want);
    filters.transaction_type = transaction_type;
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const totalCents = rows.reduce((sum, r) => sum + toCents(r.amount), 0);
  const totals = {
    rowCount: rows.length,
    total: toDollars(totalCents),
    byAccount: groupTotals(rows, r => r.account),
    byCustomer: groupTotals(rows, r => r.customer),
    byEmployee: groupTotals(rows, r => r.employee),
    byClass: groupTotals(rows, r => r.class),
    byType: groupTotals(rows, r => r.type),
  };

  const truncated = rows.length > maxRows;
  const outRows = (truncated ? rows.slice(0, maxRows) : rows).map(compact);

  const data = {
    dateRange: { start: startResolved, end: endResolved },
    filters,
    amountSign: "native sign as reported by QuickBooks General Ledger (per-account balance convention)",
    totals,
    ...(truncated ? { truncatedAt: maxRows, totalRows: rows.length } : {}),
    rows: outRows,
  };

  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const summaryLines = [
    "Transaction Detail (General Ledger)",
    "===================================",
    `Period: ${startResolved} to ${endResolved}`,
  ];
  const filterText = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(", ");
  if (filterText) summaryLines.push(`Filters: ${filterText}`);
  summaryLines.push("");
  summaryLines.push(`Rows: ${totals.rowCount} | Total amount: ${fmt(totals.total)}`);
  if (truncated) {
    summaryLines.push(`(Showing first ${maxRows} of ${rows.length} rows; totals cover all ${rows.length} matching rows)`);
  }
  const groupLine = (label: string, t: Totals) => {
    const entries = Object.entries(t);
    if (entries.length === 0) return;
    summaryLines.push(`${label}: ${entries.slice(0, 10).map(([k, v]) => `${k} ${fmt(v)}`).join("; ")}${entries.length > 10 ? "; ..." : ""}`);
  };
  groupLine("By type", totals.byType);
  groupLine("By employee", totals.byEmployee);
  groupLine("By customer", totals.byCustomer);
  groupLine("By class", totals.byClass);
  groupLine("By account", totals.byAccount);

  return outputReport("transaction-detail", data, summaryLines.join("\n"));
}
