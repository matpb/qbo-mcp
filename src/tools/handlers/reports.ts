// Handlers for report tools (profit_loss, balance_sheet, trial_balance)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  resolveDepartmentId,
  resolveCustomer,
  resolveClass,
  resolveEmployee,
  resolveVendor,
} from "../../client/index.js";
import { outputReport, applyReportsMigrationFlag } from "../../utils/index.js";
import { extractReportSummary } from "../../reports/index.js";
import { QBReport } from "../../types/index.js";

export async function handleGetProfitLoss(
  client: QuickBooks,
  args: {
    start_date?: string;
    end_date?: string;
    summarize_by?: string;
    department?: string;
    customer?: string;
    class?: string;
    employee?: string;
    vendor?: string;
    accounting_method?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { start_date, end_date, summarize_by, department, customer, accounting_method } = args;

  const options: Record<string, string> = {};
  if (start_date) options.start_date = start_date;
  if (end_date) options.end_date = end_date;
  if (summarize_by) options.summarize_column_by = summarize_by;
  if (department) options.department = await resolveDepartmentId(client, department);
  // Echo resolved names so a partial-name match is visible to the caller.
  const applied: string[] = [];
  const pick = (key: string, ref: { value: string; name: string }) => {
    options[key] = ref.value;
    applied.push(`${key}=${ref.name} (id ${ref.value})`);
  };
  if (customer) pick("customer", await resolveCustomer(client, customer));
  if (args.class) pick("class", await resolveClass(client, args.class));
  if (args.employee) pick("employee", await resolveEmployee(client, args.employee));
  if (args.vendor) pick("vendor", await resolveVendor(client, args.vendor));
  if (accounting_method) options.accounting_method = accounting_method;
  applyReportsMigrationFlag(options);

  const result = await promisify<unknown>((cb) =>
    client.reportProfitAndLoss(options, cb)
  ) as QBReport;

  const summary = extractReportSummary(result, "Profit and Loss");
  const header = applied.length ? `Filters applied: ${applied.join(", ")}\n\n` : "";
  return outputReport("profit-loss", result, header + summary);
}

export async function handleGetBalanceSheet(
  client: QuickBooks,
  args: {
    as_of_date?: string;
    summarize_by?: string;
    department?: string;
    accounting_method?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { as_of_date, summarize_by, department, accounting_method } = args;

  const options: Record<string, string> = {};
  if (as_of_date) {
    // Balance sheet needs both start_date and end_date
    // Set start_date to beginning of time for point-in-time report
    options.start_date = "1970-01-01";
    options.end_date = as_of_date;
  }
  if (summarize_by) options.summarize_column_by = summarize_by;
  if (department) options.department = await resolveDepartmentId(client, department);
  if (accounting_method) options.accounting_method = accounting_method;
  applyReportsMigrationFlag(options);

  const result = await promisify<unknown>((cb) =>
    client.reportBalanceSheet(options, cb)
  ) as QBReport;

  const summary = extractReportSummary(result, "Balance Sheet");
  return outputReport("balance-sheet", result, summary);
}

export async function handleGetTrialBalance(
  client: QuickBooks,
  args: {
    start_date?: string;
    end_date?: string;
    accounting_method?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { start_date, end_date, accounting_method } = args;

  const options: Record<string, string> = {};
  if (start_date) options.start_date = start_date;
  if (end_date) options.end_date = end_date;
  if (accounting_method) options.accounting_method = accounting_method;
  applyReportsMigrationFlag(options);

  const result = await promisify<unknown>((cb) =>
    client.reportTrialBalance(options, cb)
  ) as QBReport;

  const summary = extractReportSummary(result, "Trial Balance");
  return outputReport("trial-balance", result, summary);
}
