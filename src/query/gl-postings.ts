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
// Used by query_account_transactions when include_tax_lines=true.

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
const GL_TYPE_MAP: Record<string, { urlType: string; displayType: string }> = {
  'Bill': { urlType: 'bill', displayType: 'Bill' },
  'Bill Payment (Cheque)': { urlType: 'payment', displayType: 'BillPayment' },
  'Bill Payment (Credit Card)': { urlType: 'payment', displayType: 'BillPayment' },
  'Bill Payment': { urlType: 'payment', displayType: 'BillPayment' },
  'Cheque': { urlType: 'purchase', displayType: 'Purchase' },
  'Check': { urlType: 'purchase', displayType: 'Purchase' },
  'Expense': { urlType: 'purchase', displayType: 'Purchase' },
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

  const columns = report.Columns?.Column ?? [];
  const colIdx = (title: string) => columns.findIndex(c => c.ColTitle === title);
  const dateIdx = colIdx('Date');
  const typeIdx = colIdx('Transaction Type');
  const numIdx = colIdx('Num');
  const memoIdx = colIdx('Memo/Description');
  const amountIdx = colIdx('Amount');

  function processRows(rowList: GLRow[]): void {
    for (const row of rowList) {
      if (row.Rows?.Row) processRows(row.Rows.Row);

      if (row.type !== 'Data' || !row.ColData) continue;

      const cd = row.ColData;
      const firstColVal = cd[0]?.value ?? '';

      // Skip "Beginning Balance" and any total/summary rows that QBO mixes in.
      if (firstColVal === 'Beginning Balance' || firstColVal === 'Total') continue;

      const date = dateIdx >= 0 ? (cd[dateIdx]?.value ?? '') : '';
      const txnTypeLabel = typeIdx >= 0 ? (cd[typeIdx]?.value ?? '') : '';
      const docNumber = numIdx >= 0 ? (cd[numIdx]?.value ?? undefined) : undefined;
      const memo = memoIdx >= 0 ? (cd[memoIdx]?.value ?? undefined) : undefined;
      const rawAmount = amountIdx >= 0 && cd[amountIdx]?.value
        ? parseFloat(cd[amountIdx].value!) || 0
        : 0;

      // txnId can live on any colData entry; QBO usually puts it on the
      // Transaction Type column. Walk all cells looking for a non-empty id.
      let txnId = '';
      for (const c of cd) {
        if (c.id && c.id.length > 0) { txnId = c.id; break; }
      }
      if (!txnId) continue; // can't link without an id

      const mapped = GL_TYPE_MAP[txnTypeLabel];
      const displayType = mapped?.displayType || txnTypeLabel || 'Unknown';
      const qboLink = mapped ? buildUrl(mapped.urlType, txnId) : '';

      // Convert from native-balance sign to DR/CR sign.
      const amount = isDebitNormal ? rawAmount : -rawAmount;

      lines.push({
        date,
        type: displayType,
        txnId,
        docNumber,
        // GL doesn't expose the line id of the originating entity line; use a
        // stable placeholder so the response shape stays consistent.
        lineId: 'gl',
        amount,
        description: memo,
        qboLink,
        accountId: targetAccount.Id,
        accountName,
        // GL rows by definition match the queried account.
        isMatchingLine: true,
      });
    }
  }

  processRows(report.Rows?.Row ?? []);
  return lines;
}
