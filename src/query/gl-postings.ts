// Extract TransactionLine entries from a GeneralLedgerDetail report.
//
// Why a second extraction path: the entity-walk in account-transactions.ts only
// reads `Line.AccountRef` (and a few header refs like APAccountRef). It misses
// postings that originate from `TxnTaxDetail.TaxLine[]` — i.e. the GL effect
// of a bill/invoice's tax code on the tax payable/receivable account. The GL
// report is the authoritative source for "everything that hit this account",
// including tax-line postings, sales tax payments, and any other entity types
// the entity-walk doesn't cover (e.g. transfers, deposits-of-payments).
//
// Used by query_account_transactions and get_transaction_detail.

import { TransactionLine } from "../types/index.js";

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

export interface GLReport {
  Header?: Record<string, unknown>;
  Columns?: {
    Column?: Array<{ ColTitle?: string; ColType?: string; MetaData?: Array<{ Name: string; Value: string }> }>;
  };
  Rows?: { Row?: GLRow[] };
}

// Same set as account-period-summary.ts — keep in sync.
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

// Map GL "Transaction Type" column values → (urlEntityType, displayType).
// QBO's GL labels these in human form; our QBO URL helper expects lowercased
// entity slugs. urlEntityType keys must match getQboUrl's TXN_URL_MAP.
// displayType is what we surface in the response so callers can match against
// the entity-walk's `type` field (Purchase/Bill/etc.).
export const GL_TYPE_MAP: Record<string, { urlType: string; displayType: string }> = {
  'Bill': { urlType: 'bill', displayType: 'Bill' },
  'Bill Payment (Check)': { urlType: 'payment', displayType: 'BillPayment' },
  'Bill Payment (Cheque)': { urlType: 'payment', displayType: 'BillPayment' },
  'Bill Payment (Credit Card)': { urlType: 'payment', displayType: 'BillPayment' },
  'Bill Payment': { urlType: 'payment', displayType: 'BillPayment' },
  'Cheque': { urlType: 'purchase', displayType: 'Purchase' },
  'Check': { urlType: 'purchase', displayType: 'Purchase' },
  'Expense': { urlType: 'purchase', displayType: 'Purchase' },
  'Cash Expense': { urlType: 'purchase', displayType: 'Purchase' },
  'Cheque Expense': { urlType: 'purchase', displayType: 'Purchase' },
  'Credit Card Expense': { urlType: 'purchase', displayType: 'Purchase' },
  'Credit Card Credit': { urlType: 'purchase', displayType: 'Purchase' },
  'Journal Entry': { urlType: 'journalentry', displayType: 'JournalEntry' },
  'Invoice': { urlType: 'invoice', displayType: 'Invoice' },
  'Sales Receipt': { urlType: 'salesreceipt', displayType: 'SalesReceipt' },
  'Refund': { urlType: 'salesreceipt', displayType: 'RefundReceipt' },
  'Deposit': { urlType: 'deposit', displayType: 'Deposit' },
  'Payment': { urlType: 'payment', displayType: 'Payment' },
  'Vendor Credit': { urlType: 'purchase', displayType: 'VendorCredit' },
  'Credit Memo': { urlType: 'invoice', displayType: 'CreditMemo' },
  'Sales Tax Payment': { urlType: 'purchase', displayType: 'SalesTaxPayment' },
  'Transfer': { urlType: 'deposit', displayType: 'Transfer' },
};

function buildUrl(urlType: string, id: string): string {
  // Mirror utils/urls.ts TXN_URL_MAP — keep paths in sync.
  const PATH: Record<string, string> = {
    journalentry: 'journal',
    purchase: 'expense',
    deposit: 'deposit',
    salesreceipt: 'salesreceipt',
    bill: 'bill',
    invoice: 'invoice',
    payment: 'payment',
  };
  const path = PATH[urlType] || urlType;
  return `https://app.qbo.intuit.com/app/${path}?txnId=${id}`;
}

export interface GLParsedRow {
  date: string;
  type: string;
  txnId: string;
  docNumber?: string;
  name?: string;
  customer?: string;
  vendor?: string;
  employee?: string;
  class?: string;
  department?: string;
  account?: string;
  split?: string;
  memo?: string;
  amount: number;
}

// Flat Data rows of a GeneralLedger report, cells located by column title.
// Amounts keep the report's native sign; txnId is '' when no cell has an id.
export function parseGLRows(report: GLReport): GLParsedRow[] {
  const out: GLParsedRow[] = [];
  const columns = report.Columns?.Column ?? [];
  const colIdx = (title: string) => columns.findIndex(c => c.ColTitle === title);
  const idx = {
    date: colIdx('Date'),
    type: colIdx('Transaction Type'),
    num: colIdx('Num'),
    name: colIdx('Name'),
    customer: colIdx('Customer'),
    vendor: colIdx('Vendor'),
    employee: colIdx('Employee'),
    klass: colIdx('Class'),
    department: colIdx('Department'),
    account: colIdx('Account'),
    split: colIdx('Split'),
    memo: colIdx('Memo/Description'),
    amount: colIdx('Amount'),
  };

  function processRows(rowList: GLRow[]): void {
    for (const row of rowList) {
      if (row.Rows?.Row) processRows(row.Rows.Row);

      if (row.type !== 'Data' || !row.ColData) continue;

      const cd = row.ColData;
      const firstColVal = cd[0]?.value ?? '';
      if (firstColVal === 'Beginning Balance' || firstColVal === 'Total') continue;

      const cell = (i: number): string | undefined => {
        if (i < 0) return undefined;
        const v = cd[i]?.value;
        return v ? v : undefined;
      };

      // txnId can live on any cell; QBO usually puts it on Transaction Type.
      let txnId = '';
      for (const c of cd) {
        if (c.id && c.id.length > 0) { txnId = c.id; break; }
      }

      out.push({
        date: cell(idx.date) ?? '',
        type: cell(idx.type) ?? '',
        txnId,
        docNumber: cell(idx.num),
        name: cell(idx.name),
        customer: cell(idx.customer),
        vendor: cell(idx.vendor),
        employee: cell(idx.employee),
        class: cell(idx.klass),
        department: cell(idx.department),
        account: cell(idx.account),
        split: cell(idx.split),
        memo: cell(idx.memo),
        amount: parseFloat(cell(idx.amount) ?? '') || 0,
      });
    }
  }

  processRows(report.Rows?.Row ?? []);
  return out;
}

/**
 * Extract TransactionLine entries from a GeneralLedgerDetail report.
 *
 * Sign convention: TransactionLine.amount uses DR/CR convention
 * (positive = debit, negative = credit), regardless of the account's natural
 * side. The GL report's Amount column is in the account's native convention
 * (positive grows the balance), so for credit-normal accounts (Liability,
 * Equity, Income) we flip the sign.
 */
export function extractGLLines(
  report: GLReport,
  targetAccount: { Id: string; AccountType?: string; AcctNum?: string; FullyQualifiedName?: string; Name: string },
): TransactionLine[] {
  const lines: TransactionLine[] = [];
  const isDebitNormal = targetAccount.AccountType
    ? DEBIT_NORMAL_TYPES.has(targetAccount.AccountType)
    : false;
  const accountName = targetAccount.AcctNum
    ? `${targetAccount.AcctNum} ${targetAccount.Name}`
    : (targetAccount.FullyQualifiedName || targetAccount.Name);

  for (const row of parseGLRows(report)) {
    if (!row.txnId) continue; // can't link without an id

    const mapped = GL_TYPE_MAP[row.type];
    const displayType = mapped?.displayType || row.type || 'Unknown';
    const qboLink = mapped ? buildUrl(mapped.urlType, row.txnId) : '';

    // Convert from native-balance sign to DR/CR sign.
    const amount = isDebitNormal ? row.amount : -row.amount;

    lines.push({
      date: row.date,
      type: displayType,
      txnId: row.txnId,
      docNumber: row.docNumber,
      // GL doesn't expose the line id of the originating entity line; use a
      // stable placeholder so the response shape stays consistent.
      lineId: 'gl',
      amount,
      description: row.memo,
      qboLink,
      accountId: targetAccount.Id,
      accountName,
      // GL rows by definition match the queried account.
      isMatchingLine: true,
    });
  }
  return lines;
}
