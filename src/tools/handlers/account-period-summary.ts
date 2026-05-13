// Handler for account_period_summary tool
// Uses the GeneralLedger report to provide opening/closing balances,
// total debits/credits, and transaction count for any account over a date range.

import QuickBooks from "node-quickbooks";
import { resolveAccount, resolveDepartmentId, promisify } from "../../client/index.js";
import { outputReport, applyReportsMigrationFlag, logReportsMigrationFailure } from "../../utils/index.js";
import { QBReport } from "../../types/index.js";

interface GLRowColData {
  value?: string;
  id?: string;
}

interface GLRow {
  type?: string;
  group?: string;
  ColData?: GLRowColData[];
  Summary?: { ColData?: GLRowColData[] };
  Rows?: { Row?: GLRow[] };
  Header?: { ColData?: GLRowColData[] };
}

interface GLReport {
  Header?: QBReport["Header"];
  Columns?: {
    Column?: Array<{ ColTitle?: string; ColType?: string; MetaData?: Array<{ Name: string; Value: string }> }>;
  };
  Rows?: {
    Row?: GLRow[];
  };
}

interface PeriodSummary {
  openingBalance: number;
  closingBalance: number;
  totalDebits: number;
  totalCredits: number;
  netActivity: number;
  transactionCount: number;
}

// Debit-normal account types: positive Amount = debit (increase), negative = credit (decrease).
// Credit-normal account types: positive Amount = credit (increase), negative = debit (decrease).
// QB's GL "Amount" column uses the account's native sign convention (positive grows the balance),
// so we must flip the mapping for credit-normal accounts to label debit/credit correctly.
const DEBIT_NORMAL_TYPES = new Set([
  "Bank",
  "Accounts Receivable",
  "Other Current Asset",
  "Fixed Asset",
  "Other Asset",
  "Cost of Goods Sold",
  "Expense",
  "Other Expense",
]);

/**
 * Parse a GeneralLedger report to extract period summary data.
 *
 * GL report structure (nested sections):
 *   Section (parent account) → Section (child account) → Data rows
 *
 * Columns: Date, Transaction Type, Num, Name, Memo/Description, Split, Amount, Balance
 * - "Amount" column: signed in the account's native sign convention
 * - "Balance" column: running balance (present on transaction rows, not on Summary)
 * - "Beginning Balance" row: Balance column has opening balance
 * - Summary row: Amount column has net activity total; Balance column is empty
 * - Closing balance: Balance column of the last transaction row
 */
function parseGLReport(report: GLReport, accountType?: string): PeriodSummary {
  const isDebitNormal = accountType ? DEBIT_NORMAL_TYPES.has(accountType) : false;
  const columns = report.Columns?.Column ?? [];

  const amountIdx = columns.findIndex(c => c.ColTitle === "Amount");
  const balanceIdx = columns.findIndex(c => c.ColTitle === "Balance");

  let openingBalance = 0;
  let closingBalance = 0;
  let totalDebits = 0;
  let totalCredits = 0;
  let transactionCount = 0;

  const rows = report.Rows?.Row ?? [];

  function processRows(rowList: GLRow[]): void {
    for (const row of rowList) {
      // Recurse into nested sections (parent account → child account)
      if (row.Rows?.Row) {
        processRows(row.Rows.Row);
      }

      // Process Data rows (Beginning Balance + transaction rows)
      if (row.type === "Data" && row.ColData) {
        const colData = row.ColData;
        const firstCol = colData[0]?.value ?? "";

        if (firstCol === "Beginning Balance") {
          if (balanceIdx >= 0 && colData[balanceIdx]?.value) {
            openingBalance += parseFloat(colData[balanceIdx].value!) || 0;
          }
          continue;
        }

        // Transaction row
        const amount = amountIdx >= 0 && colData[amountIdx]?.value
          ? parseFloat(colData[amountIdx].value!) || 0
          : 0;

        if (amount !== 0) {
          transactionCount++;
          // For debit-normal accounts: positive Amount increases balance = debit
          // For credit-normal accounts: positive Amount increases balance = credit
          const isDebit = isDebitNormal ? amount > 0 : amount < 0;
          if (isDebit) {
            totalDebits += Math.abs(amount);
          } else {
            totalCredits += Math.abs(amount);
          }
        }

        // Track running balance — last row's balance = closing balance
        if (balanceIdx >= 0 && colData[balanceIdx]?.value) {
          closingBalance = parseFloat(colData[balanceIdx].value!) || 0;
        }
      }
    }
  }

  processRows(rows);

  // If no transactions, closing = opening
  if (transactionCount === 0) {
    closingBalance = openingBalance;
  }

  // Net Activity = closing − opening. For a debit-normal account that's debits − credits;
  // for a credit-normal account it's credits − debits. Compute via sign-agnostic side delta.
  const netActivity = isDebitNormal
    ? totalDebits - totalCredits
    : totalCredits - totalDebits;

  return {
    openingBalance,
    closingBalance,
    totalDebits,
    totalCredits,
    netActivity,
    transactionCount,
  };
}

export async function handleAccountPeriodSummary(
  client: QuickBooks,
  args: {
    account: string;
    start_date?: string;
    end_date?: string;
    department?: string;
    accounting_method?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account, start_date, end_date, department, accounting_method } = args;

  // Resolve account using cache
  const resolvedAccount = await resolveAccount(client, account);

  // Build report options
  const options: Record<string, string> = {
    account: resolvedAccount.Id,
  };

  const today = new Date().toISOString().split("T")[0];
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const startDateResolved = start_date || yearStart;
  const endDateResolved = end_date || today;

  options.start_date = startDateResolved;
  options.end_date = endDateResolved;

  if (department) {
    options.department = await resolveDepartmentId(client, department);
  }
  if (accounting_method) {
    options.accounting_method = accounting_method;
  }
  applyReportsMigrationFlag(options);

  // Call the GeneralLedger report
  let report: GLReport;
  try {
    report = (await promisify<unknown>((cb) =>
      client.reportGeneralLedgerDetail(options, cb)
    )) as GLReport;
  } catch (err) {
    logReportsMigrationFailure("GeneralLedgerDetail (account_period_summary)", options, err);
    throw err;
  }

  // Parse the report (account type determines debit/credit sign convention)
  const summary = parseGLReport(report, resolvedAccount.AccountType);

  // Build summary string
  const formatCurrency = (n: number) => {
    const sign = n < 0 ? "-" : "";
    return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const acctLabel = resolvedAccount.AcctNum
    ? `${resolvedAccount.AcctNum} ${resolvedAccount.FullyQualifiedName || resolvedAccount.Name}`
    : resolvedAccount.FullyQualifiedName || resolvedAccount.Name;

  const summaryLines = [
    "Account Period Summary",
    "======================",
    `Account: ${acctLabel} (${resolvedAccount.AccountType})`,
    `Period: ${startDateResolved} to ${endDateResolved}`,
  ];

  if (department) {
    summaryLines.push(`Department: ${department}`);
  }
  if (accounting_method) {
    summaryLines.push(`Basis: ${accounting_method}`);
  }

  summaryLines.push("");
  summaryLines.push(`Opening Balance:  ${formatCurrency(summary.openingBalance)}`);
  summaryLines.push(`Total Debits:     ${formatCurrency(summary.totalDebits)}`);
  summaryLines.push(`Total Credits:    ${formatCurrency(summary.totalCredits)}`);
  summaryLines.push(`Net Activity:     ${formatCurrency(summary.netActivity)}`);
  summaryLines.push(`Closing Balance:  ${formatCurrency(summary.closingBalance)}`);
  summaryLines.push(`Transactions:     ${summary.transactionCount}`);

  // Build report data
  const reportData = {
    account: {
      id: resolvedAccount.Id,
      acctNum: resolvedAccount.AcctNum,
      name: resolvedAccount.FullyQualifiedName || resolvedAccount.Name,
      type: resolvedAccount.AccountType,
    },
    dateRange: {
      start: startDateResolved,
      end: endDateResolved,
    },
    department: department || undefined,
    accountingMethod: accounting_method || "Accrual",
    summary,
  };

  return outputReport("account-period-summary", reportData, summaryLines.join("\n"));
}
