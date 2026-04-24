// Handlers for expense tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getDepartmentCache,
  getVendorCache,
  resolveCustomer,
  resolveClass,
  resolveTaxCode,
} from "../../client/index.js";
import {
  validateAmount,
  toDollars,
  formatDollars,
  sumCents,
  outputReport,
  assertKnownKeys,
} from "../../utils/index.js";

type BillableStatus = "Billable" | "NotBillable" | "HasBeenBilled";

interface CreateExpenseLine {
  account_id?: string;
  account_name?: string;
  amount: number;
  description?: string;
  customer_name?: string;
  customer_id?: string;
  class_name?: string;
  tax_code?: string;
  billable_status?: BillableStatus;
}

interface ExpenseLineChange {
  line_id?: string;
  account_name?: string;
  amount?: number;
  description?: string;
  customer_name?: string | null;
  customer_id?: string | null;
  class_name?: string | null;
  tax_code?: string | null;
  billable_status?: BillableStatus;
  delete?: boolean;
}

const CREATE_EXPENSE_LINE_KEYS = [
  'account_id', 'account_name', 'amount', 'description',
  'customer_name', 'customer_id', 'class_name', 'tax_code', 'billable_status',
] as const;

const EXPENSE_LINE_CHANGE_KEYS = [
  'line_id', 'account_name', 'amount', 'description',
  'customer_name', 'customer_id', 'class_name', 'tax_code', 'billable_status',
  'delete',
] as const;

const CREATE_EXPENSE_KEYS = [
  'payment_type', 'payment_account', 'txn_date',
  'entity_name', 'entity_id', 'vendor_name', 'vendor_id',
  'department_name', 'department_id', 'memo', 'doc_number', 'lines', 'draft',
] as const;

const EDIT_EXPENSE_KEYS = [
  'id', 'txn_date', 'memo', 'payment_account',
  'department_name', 'entity_name', 'entity_id', 'vendor_name', 'vendor_id',
  'doc_number', 'lines', 'draft',
] as const;

type LineDetail = {
  AccountRef: { value: string; name?: string };
  DepartmentRef?: { value: string; name?: string };
  CustomerRef?: { value: string; name?: string };
  ClassRef?: { value: string; name?: string };
  TaxCodeRef?: { value: string; name?: string };
  BillableStatus?: BillableStatus;
};

export async function handleCreateExpense(
  client: QuickBooks,
  args: {
    payment_type: "Cash" | "Check" | "CreditCard";
    payment_account: string;
    txn_date: string;
    entity_name?: string;
    entity_id?: string;
    vendor_name?: string;
    vendor_id?: string;
    department_name?: string;
    department_id?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateExpenseLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  assertKnownKeys(args as Record<string, unknown>, CREATE_EXPENSE_KEYS, 'create_expense');
  const {
    payment_type, payment_account, txn_date,
    entity_name, entity_id, vendor_name, vendor_id,
    department_name, department_id,
    memo, doc_number, lines, draft = true,
  } = args;

  // vendor_* is an accepted alias for entity_* — QBO's Purchase.EntityRef is
  // the same "Payee" that the Canadian UI labels "Supplier". Accept either.
  const payeeInputName = entity_name ?? vendor_name;
  const payeeInputId = entity_id ?? vendor_id;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }
  lines.forEach((line, idx) =>
    assertKnownKeys(line as unknown as Record<string, unknown>, CREATE_EXPENSE_LINE_KEYS, `create_expense.lines[${idx}]`)
  );

  // Get cached lookups in parallel
  const [acctCache, deptCache, vendorCacheData] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client),
    getVendorCache(client),
  ]);

  // Resolve payment account
  const lookupAccount = (name: string): { id: string; name: string; acctNum?: string } => {
    let match = acctCache.byAcctNum.get(name.toLowerCase());
    if (!match) match = acctCache.byName.get(name.toLowerCase());
    if (!match) match = acctCache.items.find(a =>
      a.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
    );
    if (match) return { id: match.Id, name: match.FullyQualifiedName || match.Name, acctNum: match.AcctNum };
    throw new Error(`Account not found: "${name}"`);
  };

  const paymentAcct = lookupAccount(payment_account);
  const paymentAccountRef = { value: paymentAcct.id, name: paymentAcct.name };

  // Resolve vendor/entity (optional)
  let entityRef: { value: string; name: string; type: string } | undefined;
  const entityInput = payeeInputId || payeeInputName;
  if (entityInput) {
    const byId = vendorCacheData.byId.get(entityInput);
    if (byId) {
      entityRef = { value: byId.Id, name: byId.DisplayName, type: "Vendor" };
    } else {
      const byName = vendorCacheData.byName.get(entityInput.toLowerCase());
      if (byName) {
        entityRef = { value: byName.Id, name: byName.DisplayName, type: "Vendor" };
      } else {
        const byPartial = vendorCacheData.items.find(v =>
          v.DisplayName.toLowerCase().includes(entityInput.toLowerCase())
        );
        if (byPartial) {
          entityRef = { value: byPartial.Id, name: byPartial.DisplayName, type: "Vendor" };
        } else {
          throw new Error(`Vendor not found: "${entityInput}"`);
        }
      }
    }
  }

  // Resolve department (header-level, optional)
  let departmentRef: { value: string; name: string } | undefined;
  const deptInput = department_id || department_name;
  if (deptInput) {
    const byId = deptCache.byId.get(deptInput);
    if (byId) {
      departmentRef = { value: byId.Id, name: byId.FullyQualifiedName || byId.Name };
    } else {
      const byName = deptCache.byName.get(deptInput.toLowerCase());
      if (byName) {
        departmentRef = { value: byName.Id, name: byName.FullyQualifiedName || byName.Name };
      } else {
        const byPartial = deptCache.items.find(d =>
          d.FullyQualifiedName?.toLowerCase().includes(deptInput.toLowerCase())
        );
        if (byPartial) {
          departmentRef = { value: byPartial.Id, name: byPartial.FullyQualifiedName || byPartial.Name };
        } else {
          throw new Error(`Department not found: "${deptInput}"`);
        }
      }
    }
  }

  // Resolve lines (including new optional per-line fields)
  const resolvedLines = await Promise.all(lines.map(async (line) => {
    let accountId = line.account_id;
    let accountName = line.account_name;
    let accountNum: string | undefined;

    if (!accountId && accountName) {
      const account = lookupAccount(accountName);
      accountId = account.id;
      accountName = account.name;
      accountNum = account.acctNum;
    } else if (!accountId && !accountName) {
      throw new Error("Each line must have either account_id or account_name");
    }

    const amountCents = validateAmount(line.amount, `Line ${accountName || accountId}`);

    const customerInput = line.customer_id || line.customer_name;
    const customerRef = customerInput ? await resolveCustomer(client, customerInput) : undefined;
    const classRef = line.class_name ? await resolveClass(client, line.class_name) : undefined;
    const taxCodeRef = line.tax_code ? await resolveTaxCode(client, line.tax_code) : undefined;

    return {
      ...line,
      account_id: accountId!,
      account_name: accountName,
      account_num: accountNum,
      amount_cents: amountCents,
      amount: toDollars(amountCents),
      customerRef,
      classRef,
      taxCodeRef,
    };
  }));

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amount_cents));

  // Build QuickBooks Purchase object
  const purchaseObject: Record<string, unknown> = {
    PaymentType: payment_type,
    AccountRef: paymentAccountRef,
    TxnDate: txn_date,
    ...(entityRef && { EntityRef: entityRef }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    Line: resolvedLines.map((line) => ({
      Amount: line.amount,
      DetailType: "AccountBasedExpenseLineDetail",
      ...(line.description && { Description: line.description }),
      AccountBasedExpenseLineDetail: {
        AccountRef: {
          value: line.account_id,
          name: line.account_name,
        },
        ...(line.customerRef && { CustomerRef: line.customerRef }),
        ...(line.classRef && { ClassRef: line.classRef }),
        ...(line.taxCodeRef && { TaxCodeRef: line.taxCodeRef }),
        ...(line.billable_status && { BillableStatus: line.billable_status }),
      },
    })),
  };

  if (draft) {
    const formatAccount = (l: typeof resolvedLines[0]) => {
      const num = l.account_num ? `${l.account_num} ` : "";
      return `${num}${l.account_name || l.account_id}`;
    };

    const preview = [
      "DRAFT - Expense Preview",
      "",
      `Payment Type: ${payment_type}`,
      `Payment Account: ${paymentAcct.acctNum ? `${paymentAcct.acctNum} ` : ""}${paymentAcct.name}`,
      `Payee: ${entityRef?.name || "(none)"}`,
      `Date: ${txn_date}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l => {
        const tags: string[] = [];
        if (l.customerRef) tags.push(`cust: ${l.customerRef.name}`);
        if (l.classRef) tags.push(`class: ${l.classRef.name}`);
        if (l.taxCodeRef) tags.push(`tax: ${l.taxCodeRef.name}`);
        if (l.billable_status) tags.push(l.billable_status);
        const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
        return `  ${formatAccount(l)}${tagStr}: $${l.amount.toFixed(2)}${l.description ? ` "${l.description}"` : ""}`;
      }),
      "",
      "Set draft=false to create this expense.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the expense
  const result = await promisify<unknown>((cb) =>
    client.createPurchase(purchaseObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = `https://app.qbo.intuit.com/app/expense?txnId=${result.Id}`;

  const response = [
    "Expense Created!",
    "",
    `Payment Type: ${payment_type}`,
    `Payment Account: ${paymentAcct.name}`,
    `Payee: ${entityRef?.name || "(none)"}`,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Total: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetExpense(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const expense = await promisify<unknown>((cb) =>
    client.getPurchase(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    PaymentType: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    GlobalTaxCalculation?: string;
    AccountRef?: { value: string; name?: string };
    EntityRef?: { value: string; name?: string; type?: string };
    DepartmentRef?: { value: string; name?: string };
    Line?: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: LineDetail;
      ItemBasedExpenseLineDetail?: {
        ItemRef: { value: string; name?: string };
        Qty?: number;
        UnitPrice?: number;
      };
    }>;
  };
  const qboUrl = `https://app.qbo.intuit.com/app/expense?txnId=${expense.Id}`;

  // Format summary
  const lines: string[] = [
    'Expense (Purchase)',
    '==================',
    `ID: ${expense.Id}`,
    `SyncToken: ${expense.SyncToken}`,
    `Payment Type: ${expense.PaymentType}`,
    `Payment Account: ${expense.AccountRef?.name || expense.AccountRef?.value || '(none)'}`,
    `Payee: ${expense.EntityRef?.name || expense.EntityRef?.value || '(none)'}`,
    `Department: ${expense.DepartmentRef?.name || expense.DepartmentRef?.value || '(none)'}`,
    `Date: ${expense.TxnDate}`,
    `Ref no.: ${expense.DocNumber || '(none)'}`,
    `Memo: ${expense.PrivateNote || '(none)'}`,
    `Tax Calc: ${expense.GlobalTaxCalculation || '(none)'}`,
    `Total: $${(expense.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of expense.Line || []) {
    if (line.AccountBasedExpenseLineDetail) {
      const detail = line.AccountBasedExpenseLineDetail;
      const acctName = detail.AccountRef.name || detail.AccountRef.value;
      const tags: string[] = [];
      if (detail.DepartmentRef?.name) tags.push(`dept: ${detail.DepartmentRef.name}`);
      if (detail.CustomerRef?.name) tags.push(`cust: ${detail.CustomerRef.name}`);
      if (detail.ClassRef?.name) tags.push(`class: ${detail.ClassRef.name}`);
      if (detail.TaxCodeRef?.name) tags.push(`tax: ${detail.TaxCodeRef.name}`);
      if (detail.BillableStatus && detail.BillableStatus !== 'NotBillable') tags.push(detail.BillableStatus);
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: ${acctName}${tagStr} $${line.Amount.toFixed(2)}${descStr}`);
    } else if (line.ItemBasedExpenseLineDetail) {
      const detail = line.ItemBasedExpenseLineDetail;
      const itemName = detail.ItemRef.name || detail.ItemRef.value;
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: Item: ${itemName} (Qty: ${detail.Qty || 1}) $${line.Amount.toFixed(2)}${descStr}`);
    }
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`expense-${expense.Id}`, expense, lines.join('\n'));
}

export async function handleEditExpense(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    memo?: string;
    payment_account?: string;
    department_name?: string | null;
    entity_name?: string | null;
    entity_id?: string | null;
    vendor_name?: string | null;
    vendor_id?: string | null;
    doc_number?: string;
    lines?: ExpenseLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  assertKnownKeys(args as Record<string, unknown>, EDIT_EXPENSE_KEYS, 'edit_expense');
  const {
    id, txn_date, memo, payment_account, department_name,
    entity_name, entity_id, vendor_name, vendor_id, doc_number,
    lines: lineChanges, draft = true,
  } = args;

  // Accept vendor_* as an alias for entity_*
  const payeeName = entity_name ?? vendor_name;
  const payeeId = entity_id ?? vendor_id;

  if (lineChanges) {
    lineChanges.forEach((change, idx) =>
      assertKnownKeys(change as unknown as Record<string, unknown>, EXPENSE_LINE_CHANGE_KEYS, `edit_expense.lines[${idx}]`)
    );
  }

  // Fetch current Purchase (include tax-related header fields for preservation)
  const current = await promisify<unknown>((cb) =>
    client.getPurchase(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    PaymentType: string;
    DocNumber?: string;
    PrivateNote?: string;
    GlobalTaxCalculation?: string;
    TxnTaxDetail?: Record<string, unknown>;
    AccountRef?: { value: string; name?: string };
    EntityRef?: { value: string; name?: string; type?: string };
    DepartmentRef?: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: LineDetail;
    }>;
  };

  // Intent flags
  const wantsClearDept = department_name === null;
  const wantsSetDept = typeof department_name === 'string' && department_name.length > 0;
  const wantsClearPayee = payeeName === null || payeeId === null;
  const wantsSetPayee = typeof (payeeId ?? payeeName) === 'string' && ((payeeId ?? payeeName) as string).length > 0;

  const needsFullUpdate = (lineChanges && lineChanges.length > 0) || wantsClearDept || wantsClearPayee;

  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    PaymentType: current.PaymentType,
  };

  if (!needsFullUpdate) {
    updated.sparse = true;
  } else {
    // Full update: preserve every header field — anything omitted is reset server-side.
    updated.sparse = false;
    updated.TxnDate = current.TxnDate;
    updated.DocNumber = current.DocNumber;
    updated.PrivateNote = current.PrivateNote;
    if (current.GlobalTaxCalculation) updated.GlobalTaxCalculation = current.GlobalTaxCalculation;
    if (current.TxnTaxDetail) updated.TxnTaxDetail = current.TxnTaxDetail;
    if (current.AccountRef) updated.AccountRef = current.AccountRef;
    if (current.EntityRef && !wantsClearPayee) updated.EntityRef = current.EntityRef;
    if (current.DepartmentRef && !wantsClearDept) updated.DepartmentRef = current.DepartmentRef;
    // Copy lines and strip read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (doc_number !== undefined) updated.DocNumber = doc_number;

  // Resolve payment account if provided
  if (payment_account !== undefined) {
    const acctCache = await getAccountCache(client);
    let match = acctCache.byAcctNum.get(payment_account.toLowerCase());
    if (!match) match = acctCache.byName.get(payment_account.toLowerCase());
    if (!match) match = acctCache.items.find(a =>
      a.FullyQualifiedName?.toLowerCase().includes(payment_account.toLowerCase())
    );
    if (!match) throw new Error(`Payment account not found: "${payment_account}"`);
    updated.AccountRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
  }

  // Resolve header-level department if provided
  if (wantsSetDept) {
    const deptCache = await getDepartmentCache(client);
    let match = deptCache.byName.get(department_name!.toLowerCase());
    if (!match) match = deptCache.items.find(d =>
      d.FullyQualifiedName?.toLowerCase().includes(department_name!.toLowerCase())
    );
    if (!match) throw new Error(`Department not found: "${department_name}"`);
    updated.DepartmentRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
  }

  // Resolve entity (vendor/payee) if provided
  if (wantsSetPayee) {
    const entityInput = (payeeId ?? payeeName) as string;
    const vendorCacheData = await getVendorCache(client);
    const byId = vendorCacheData.byId.get(entityInput);
    if (byId) {
      updated.EntityRef = { value: byId.Id, name: byId.DisplayName, type: "Vendor" };
    } else {
      const byName = vendorCacheData.byName.get(entityInput.toLowerCase());
      if (byName) {
        updated.EntityRef = { value: byName.Id, name: byName.DisplayName, type: "Vendor" };
      } else {
        const byPartial = vendorCacheData.items.find(v =>
          v.DisplayName.toLowerCase().includes(entityInput.toLowerCase())
        );
        if (byPartial) {
          updated.EntityRef = { value: byPartial.Id, name: byPartial.DisplayName, type: "Vendor" };
        } else {
          throw new Error(`Vendor not found: "${entityInput}"`);
        }
      }
    }
  }

  type LineEvent =
    | { kind: 'update'; lineId: string; before: typeof current.Line[0]; after: typeof current.Line[0]; changedKeys: string[]; noopKeys: string[] }
    | { kind: 'delete'; lineId: string; before: typeof current.Line[0] }
    | { kind: 'new'; after: typeof current.Line[0]; providedKeys: string[] };
  const events: LineEvent[] = [];

  let finalLines = [...((updated.Line as typeof current.Line) || current.Line)];

  if (lineChanges && lineChanges.length > 0) {
    const acctCache = await getAccountCache(client);

    const resolveAcct = (name: string) => {
      let match = acctCache.byAcctNum.get(name.toLowerCase());
      if (!match) match = acctCache.byName.get(name.toLowerCase());
      if (!match) match = acctCache.items.find(a =>
        a.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
      );
      if (!match) throw new Error(`Account not found: "${name}"`);
      return { value: match.Id, name: match.FullyQualifiedName || match.Name };
    };

    for (const change of lineChanges) {
      if (change.line_id) {
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in expense`);
        }

        const before = finalLines[lineIndex];

        if (change.delete) {
          finalLines.splice(lineIndex, 1);
          events.push({ kind: 'delete', lineId: change.line_id, before });
          continue;
        }

        const line = { ...before };
        const detail: LineDetail = { ...(line.AccountBasedExpenseLineDetail || { AccountRef: { value: '' } }) };

        const changedKeys: string[] = [];
        const noopKeys: string[] = [];

        if (change.amount !== undefined) {
          const amountCents = validateAmount(change.amount, `Line ${change.line_id}`);
          const next = toDollars(amountCents);
          if (next !== line.Amount) { line.Amount = next; changedKeys.push('amount'); } else { noopKeys.push('amount'); }
        }
        if (change.description !== undefined) {
          if (change.description !== (line.Description || '')) { line.Description = change.description; changedKeys.push('description'); } else { noopKeys.push('description'); }
        }
        if (change.account_name !== undefined) {
          const nextAcct = resolveAcct(change.account_name);
          if (nextAcct.value !== detail.AccountRef?.value) { detail.AccountRef = nextAcct; changedKeys.push('account_name'); } else { noopKeys.push('account_name'); }
        }
        const customerInput = change.customer_id ?? change.customer_name;
        if (customerInput === null || customerInput === '') {
          if (detail.CustomerRef) { delete detail.CustomerRef; changedKeys.push('customer'); } else { noopKeys.push('customer'); }
        } else if (typeof customerInput === 'string') {
          const nextCust = await resolveCustomer(client, customerInput);
          if (nextCust.value !== detail.CustomerRef?.value) { detail.CustomerRef = nextCust; changedKeys.push('customer'); } else { noopKeys.push('customer'); }
        }
        if (change.class_name !== undefined) {
          if (change.class_name === null || change.class_name === '') {
            if (detail.ClassRef) { delete detail.ClassRef; changedKeys.push('class'); } else { noopKeys.push('class'); }
          } else {
            const nextClass = await resolveClass(client, change.class_name);
            if (nextClass.value !== detail.ClassRef?.value) { detail.ClassRef = nextClass; changedKeys.push('class'); } else { noopKeys.push('class'); }
          }
        }
        if (change.tax_code !== undefined) {
          if (change.tax_code === null || change.tax_code === '') {
            if (detail.TaxCodeRef) { delete detail.TaxCodeRef; changedKeys.push('tax_code'); } else { noopKeys.push('tax_code'); }
          } else {
            const nextTax = await resolveTaxCode(client, change.tax_code);
            if (nextTax.value !== detail.TaxCodeRef?.value) { detail.TaxCodeRef = nextTax; changedKeys.push('tax_code'); } else { noopKeys.push('tax_code'); }
          }
        }
        if (change.billable_status !== undefined) {
          if (change.billable_status !== detail.BillableStatus) { detail.BillableStatus = change.billable_status; changedKeys.push('billable_status'); } else { noopKeys.push('billable_status'); }
        }

        line.AccountBasedExpenseLineDetail = detail;
        line.DetailType = 'AccountBasedExpenseLineDetail';
        finalLines[lineIndex] = line;
        events.push({ kind: 'update', lineId: change.line_id, before, after: line, changedKeys, noopKeys });
      } else {
        if (change.amount === undefined || !change.account_name) {
          throw new Error('New lines require amount and account_name');
        }

        const amountCents = validateAmount(change.amount, `New line for ${change.account_name}`);

        const customerInput = change.customer_id ?? change.customer_name;
        const customerRef = typeof customerInput === 'string' && customerInput.length > 0
          ? await resolveCustomer(client, customerInput) : undefined;
        const classRef = typeof change.class_name === 'string' && change.class_name.length > 0
          ? await resolveClass(client, change.class_name) : undefined;
        const taxCodeRef = typeof change.tax_code === 'string' && change.tax_code.length > 0
          ? await resolveTaxCode(client, change.tax_code) : undefined;

        const providedKeys: string[] = ['account_name', 'amount'];
        if (change.description) providedKeys.push('description');
        if (customerRef) providedKeys.push('customer');
        if (classRef) providedKeys.push('class');
        if (taxCodeRef) providedKeys.push('tax_code');
        if (change.billable_status) providedKeys.push('billable_status');

        const newLine = {
          Amount: toDollars(amountCents),
          Description: change.description,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: resolveAcct(change.account_name),
            ...(customerRef && { CustomerRef: customerRef }),
            ...(classRef && { ClassRef: classRef }),
            ...(taxCodeRef && { TaxCodeRef: taxCodeRef }),
            ...(change.billable_status && { BillableStatus: change.billable_status }),
          }
        } as typeof finalLines[0];
        finalLines.push(newLine);
        events.push({ kind: 'new', after: newLine, providedKeys });
      }
    }

    updated.Line = finalLines;
  }

  const qboUrl = `https://app.qbo.intuit.com/app/expense?txnId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Expense Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      `Payment Type: ${current.PaymentType} (cannot be changed)`,
      '',
      'Header changes:',
    ];

    const headerRows: string[] = [];
    if (txn_date !== undefined) headerRows.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (memo !== undefined) headerRows.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (doc_number !== undefined) headerRows.push(`  Ref no.: ${current.DocNumber || '(none)'} → ${doc_number}`);
    if (payment_account !== undefined) {
      const newAcct = (updated.AccountRef as { name?: string })?.name || payment_account;
      headerRows.push(`  Payment Account: ${current.AccountRef?.name || '(none)'} → ${newAcct}`);
    }
    if (wantsSetDept) {
      const newDept = (updated.DepartmentRef as { name?: string })?.name || department_name;
      headerRows.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${newDept}`);
    }
    if (wantsClearDept) headerRows.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → (cleared)`);
    if (wantsSetPayee) {
      const newEntity = (updated.EntityRef as { name?: string })?.name || (payeeId ?? payeeName);
      headerRows.push(`  Vendor/Payee: ${current.EntityRef?.name || '(none)'} → ${newEntity}`);
    }
    if (wantsClearPayee) headerRows.push(`  Vendor/Payee: ${current.EntityRef?.name || '(none)'} → (cleared)`);
    if (headerRows.length === 0) previewLines.push('  (none)'); else previewLines.push(...headerRows);

    previewLines.push('');
    previewLines.push('Tax calc (preserved):');
    previewLines.push(`  GlobalTaxCalculation: ${current.GlobalTaxCalculation || '(none)'}`);

    if (events.length > 0) {
      previewLines.push('');
      previewLines.push('Line changes:');
      for (const ev of events) {
        if (ev.kind === 'delete') {
          const acctName = ev.before.AccountBasedExpenseLineDetail?.AccountRef?.name || '(line)';
          previewLines.push(`  Line ${ev.lineId}: DELETE ${acctName} $${ev.before.Amount.toFixed(2)}`);
        } else if (ev.kind === 'new') {
          const d = ev.after.AccountBasedExpenseLineDetail;
          const acctName = d?.AccountRef?.name || '(new)';
          previewLines.push(`  NEW ${acctName}: $${ev.after.Amount.toFixed(2)} (set: ${ev.providedKeys.join(', ')})`);
        } else {
          const d = ev.after.AccountBasedExpenseLineDetail;
          const acctName = d?.AccountRef?.name || '(line)';
          const parts: string[] = [];
          if (ev.changedKeys.length) parts.push(`changed: ${ev.changedKeys.join(', ')}`);
          if (ev.noopKeys.length) parts.push(`unchanged: ${ev.noopKeys.join(', ')}`);
          const summary = parts.length ? ` [${parts.join('; ')}]` : ' [no-op]';
          previewLines.push(`  Line ${ev.lineId}: ${acctName} $${ev.after.Amount.toFixed(2)}${summary}`);
        }
      }
    }

    previewLines.push('');
    previewLines.push('Set draft=false to apply these changes.');

    return {
      content: [{ type: "text", text: previewLines.join('\n') }],
    };
  }

  const result = await promisify<unknown>((cb) =>
    client.updatePurchase(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Expense ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
