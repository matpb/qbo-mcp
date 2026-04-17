// Transaction line-item summaries for query results
// Enhances text summaries with per-transaction line breakdowns

import { isHttpMode } from "../utils/output.js";

const TRANSACTION_ENTITIES = new Set([
  "journalentry", "purchase", "bill", "deposit",
  "salesreceipt", "invoice", "payment",
]);

interface LineSummary {
  amount: number;
  label: string;       // account name, item name, etc.
  postingType?: string; // DR/CR for journal entries
}

function formatAmount(amount: number): string {
  return `$${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function extractLineSummary(line: Record<string, unknown>): LineSummary | null {
  const amount = (line.Amount as number) ?? 0;
  const detailType = line.DetailType as string;

  if (!detailType || detailType === "SubTotalLineDetail" || amount === 0) {
    return null;
  }

  if (detailType === "JournalEntryLineDetail") {
    const detail = line.JournalEntryLineDetail as Record<string, unknown> | undefined;
    const accountRef = detail?.AccountRef as { name?: string } | undefined;
    const postingType = (detail?.PostingType as string) === "Credit" ? "CR" : "DR";
    return { amount, label: accountRef?.name || "Unknown", postingType };
  }

  if (detailType === "AccountBasedExpenseLineDetail") {
    const detail = line.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
    const accountRef = detail?.AccountRef as { name?: string } | undefined;
    return { amount, label: accountRef?.name || "Unknown" };
  }

  if (detailType === "DepositLineDetail") {
    const detail = line.DepositLineDetail as Record<string, unknown> | undefined;
    const accountRef = detail?.AccountRef as { name?: string } | undefined;
    return { amount, label: accountRef?.name || "Unknown" };
  }

  if (detailType === "SalesItemLineDetail") {
    const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
    const itemRef = detail?.ItemRef as { name?: string } | undefined;
    const qty = detail?.Qty as number | undefined;
    let label = itemRef?.name || "Unknown";
    if (qty && qty > 1) label += ` (x${qty})`;
    return { amount, label };
  }

  if (detailType === "ItemBasedExpenseLineDetail") {
    const detail = line.ItemBasedExpenseLineDetail as Record<string, unknown> | undefined;
    const itemRef = detail?.ItemRef as { name?: string } | undefined;
    const qty = detail?.Qty as number | undefined;
    let label = itemRef?.name || "Unknown";
    if (qty && qty > 1) label += ` (x${qty})`;
    return { amount, label };
  }

  return null;
}

function formatTransaction(entity: string, record: Record<string, unknown>): string {
  const entityLower = entity.toLowerCase();
  const docNumber = record.DocNumber as string | undefined;
  const txnDate = record.TxnDate as string | undefined;
  const totalAmt = (record.TotalAmt as number) ?? 0;

  // Build header: EntityType #DocNumber (date) $total
  let header = entity;
  if (docNumber) header += ` #${docNumber}`;
  if (txnDate) header += ` (${txnDate})`;
  header += ` ${formatAmount(totalAmt)}`;

  // Entity/vendor context
  const vendorRef = record.VendorRef as { name?: string } | undefined;
  const entityRef = record.EntityRef as { name?: string } | undefined;
  const customerRef = record.CustomerRef as { name?: string } | undefined;
  const deptRef = record.DepartmentRef as { name?: string } | undefined;

  const contextParts: string[] = [];
  if (vendorRef?.name) contextParts.push(vendorRef.name);
  if (entityRef?.name) contextParts.push(entityRef.name);
  if (customerRef?.name) contextParts.push(customerRef.name);
  if (deptRef?.name) contextParts.push(`Dept: ${deptRef.name}`);

  // Extract line summaries
  const lines = (record.Line as Array<Record<string, unknown>>) || [];
  const summaries = lines.map(extractLineSummary).filter((s): s is LineSummary => s !== null);

  const isJournal = entityLower === "journalentry";

  if (summaries.length === 0) {
    // No meaningful lines - header only with context
    if (contextParts.length > 0) header += `  [${contextParts.join(", ")}]`;
    return header;
  }

  if (summaries.length === 1 && !isJournal) {
    // Single line - inline
    header += `  ${summaries[0].label}`;
    if (contextParts.length > 0) header += `  [${contextParts.join(", ")}]`;
    return header;
  }

  // Multi-line - header + indented sub-lines
  if (contextParts.length > 0) header += `  [${contextParts.join(", ")}]`;

  const subLines = summaries.map(s => {
    const prefix = isJournal && s.postingType ? `${s.postingType}  ` : "";
    return `  ${prefix}${formatAmount(s.amount)}  ${s.label}`;
  });

  return [header, ...subLines].join("\n");
}

/**
 * Generate a compact line-item summary for transaction query results.
 * Returns null for non-transaction entities (Customer, Vendor, Account, etc.)
 */
export function summarizeTransactionLines(
  entity: string,
  entities: Array<Record<string, unknown>>
): string | null {
  if (!TRANSACTION_ENTITIES.has(entity.toLowerCase())) {
    return null;
  }

  if (entities.length === 0) {
    return null;
  }

  const cap = isHttpMode() ? 25 : 50;
  const displayed = entities.slice(0, cap);
  const remaining = entities.length - displayed.length;

  const lines = displayed.map(record => formatTransaction(entity, record));

  if (remaining > 0) {
    lines.push(`... and ${remaining} more (see full data)`);
  }

  return lines.join("\n");
}
