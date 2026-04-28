// Handlers for bill tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getDepartmentCache,
  getVendorCache,
  resolveVendor,
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
type GlobalTaxCalc = "TaxExcluded" | "TaxInclusive" | "NotApplicable";
const GLOBAL_TAX_CALC_VALUES = new Set<GlobalTaxCalc>(['TaxExcluded', 'TaxInclusive', 'NotApplicable']);

interface CreateBillLine {
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

interface BillLineChange {
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

const BILL_LINE_CHANGE_KEYS = [
  'line_id', 'account_name', 'amount', 'description',
  'customer_name', 'customer_id', 'class_name', 'tax_code', 'billable_status',
  'delete',
] as const;

const CREATE_BILL_LINE_KEYS = [
  'account_id', 'account_name', 'amount', 'description',
  'customer_name', 'customer_id', 'class_name', 'tax_code', 'billable_status',
] as const;

const EDIT_BILL_KEYS = [
  'id', 'vendor_name', 'txn_date', 'due_date', 'memo',
  'department_name', 'global_tax_calculation', 'doc_number', 'lines', 'draft',
] as const;

const CREATE_BILL_KEYS = [
  'vendor_name', 'vendor_id', 'txn_date', 'due_date',
  'department_name', 'department_id', 'ap_account',
  'memo', 'doc_number', 'lines', 'draft',
] as const;

// ProjectRef is at LINE level (not nested in detail) and server-managed.
// See expense.ts for the long explanation; the bill handler follows the same
// pattern: strip line.ProjectRef on round-trip so QBO re-derives it from the
// (possibly new) detail.CustomerRef.
type LineDetail = {
  AccountRef: { value: string; name?: string };
  DepartmentRef?: { value: string; name?: string };
  CustomerRef?: { value: string; name?: string } | null;
  ClassRef?: { value: string; name?: string } | null;
  TaxCodeRef?: { value: string; name?: string } | null;
  BillableStatus?: BillableStatus;
};

export async function handleCreateBill(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    txn_date: string;
    due_date?: string;
    department_name?: string;
    department_id?: string;
    ap_account?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateBillLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  assertKnownKeys(args as Record<string, unknown>, CREATE_BILL_KEYS, 'create_bill');
  const {
    vendor_name, vendor_id, txn_date, due_date,
    department_name, department_id, ap_account,
    memo, doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }
  lines.forEach((line, idx) =>
    assertKnownKeys(line as unknown as Record<string, unknown>, CREATE_BILL_LINE_KEYS, `create_bill.lines[${idx}]`)
  );

  // Get cached lookups
  const [acctCache, deptCache, vendorCacheData] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client),
    getVendorCache(client),
  ]);

  // Resolve vendor
  const resolveVendorRef = (nameOrId: string): { value: string; name: string } => {
    const byId = vendorCacheData.byId.get(nameOrId);
    if (byId) return { value: byId.Id, name: byId.DisplayName };

    const byName = vendorCacheData.byName.get(nameOrId.toLowerCase());
    if (byName) return { value: byName.Id, name: byName.DisplayName };

    const byPartial = vendorCacheData.items.find(v =>
      v.DisplayName.toLowerCase().includes(nameOrId.toLowerCase())
    );
    if (byPartial) return { value: byPartial.Id, name: byPartial.DisplayName };

    throw new Error(`Vendor not found: "${nameOrId}"`);
  };

  let vendorRef: { value: string; name: string };
  if (vendor_id) {
    vendorRef = resolveVendorRef(vendor_id);
  } else if (vendor_name) {
    vendorRef = resolveVendorRef(vendor_name);
  } else {
    throw new Error("Either vendor_name or vendor_id is required");
  }

  // Resolve account refs
  const lookupAccount = (name: string): { id: string; name: string; acctNum?: string } => {
    let match = acctCache.byAcctNum.get(name.toLowerCase());
    if (!match) match = acctCache.byName.get(name.toLowerCase());
    if (!match) match = acctCache.items.find(a =>
      a.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
    );
    if (match) return { id: match.Id, name: match.FullyQualifiedName || match.Name, acctNum: match.AcctNum };
    throw new Error(`Account not found: "${name}"`);
  };

  // Resolve department (header-level)
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

  // Resolve AP account if specified
  let apAccountRef: { value: string; name: string } | undefined;
  if (ap_account) {
    const acct = lookupAccount(ap_account);
    apAccountRef = { value: acct.id, name: acct.name };
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

    // Per QBO: BillableStatus requires CustomerRef. Default "NotBillable" when neither is set.
    let billableStatus: BillableStatus | undefined = line.billable_status;
    if (!billableStatus && !customerRef) {
      billableStatus = "NotBillable";
    }

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
      billableStatus,
    };
  }));

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amount_cents));

  // Build QuickBooks Bill object
  const billObject: Record<string, unknown> = {
    VendorRef: vendorRef,
    TxnDate: txn_date,
    ...(due_date && { DueDate: due_date }),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(apAccountRef && { APAccountRef: apAccountRef }),
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
        ...(line.billableStatus && { BillableStatus: line.billableStatus }),
      },
    })),
  };

  if (draft) {
    const formatAccount = (l: typeof resolvedLines[0]) => {
      const num = l.account_num ? `${l.account_num} ` : "";
      return `${num}${l.account_name || l.account_id}`;
    };

    const preview = [
      "DRAFT - Bill Preview",
      "",
      `Vendor: ${vendorRef.name}`,
      `Date: ${txn_date}`,
      `Due Date: ${due_date || "(none)"}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `AP Account: ${apAccountRef?.name || "(default)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l => {
        const tags: string[] = [];
        if (l.customerRef) tags.push(`cust: ${l.customerRef.name}`);
        if (l.classRef) tags.push(`class: ${l.classRef.name}`);
        if (l.taxCodeRef) tags.push(`tax: ${l.taxCodeRef.name}`);
        if (l.billableStatus && l.billableStatus !== "NotBillable") tags.push(l.billableStatus);
        const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
        return `  ${formatAccount(l)}${tagStr}: $${l.amount.toFixed(2)}${l.description ? ` "${l.description}"` : ""}`;
      }),
      "",
      "Set draft=false to create this bill.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the bill
  const result = await promisify<unknown>((cb) =>
    client.createBill(billObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = `https://app.qbo.intuit.com/app/bill?txnId=${result.Id}`;

  const response = [
    "Bill Created!",
    "",
    `Vendor: ${vendorRef.name}`,
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

export async function handleGetBill(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const bill = await promisify<unknown>((cb) =>
    client.getBill(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    GlobalTaxCalculation?: string;
    VendorRef?: { value: string; name?: string };
    APAccountRef?: { value: string; name?: string };
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
      ProjectRef?: { value: string; name?: string };
    }>;
  };
  const qboUrl = `https://app.qbo.intuit.com/app/bill?txnId=${bill.Id}`;

  // Format summary
  const lines: string[] = [
    'Bill',
    '====',
    `ID: ${bill.Id}`,
    `SyncToken: ${bill.SyncToken}`,
    `Vendor: ${bill.VendorRef?.name || bill.VendorRef?.value || '(none)'}`,
    `Date: ${bill.TxnDate}`,
    `Due Date: ${bill.DueDate || '(none)'}`,
    `Ref no.: ${bill.DocNumber || '(none)'}`,
    `Memo: ${bill.PrivateNote || '(none)'}`,
    `Department: ${bill.DepartmentRef?.name || bill.DepartmentRef?.value || '(none)'}`,
    `AP Account: ${bill.APAccountRef?.name || bill.APAccountRef?.value || 'Accounts Payable'}`,
    `Tax Calc: ${bill.GlobalTaxCalculation || '(none)'}`,
    `Total: $${(bill.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of bill.Line || []) {
    if (line.AccountBasedExpenseLineDetail) {
      const detail = line.AccountBasedExpenseLineDetail;
      const acctName = detail.AccountRef.name || detail.AccountRef.value;
      const tags: string[] = [];
      if (detail.DepartmentRef?.name) tags.push(`dept: ${detail.DepartmentRef.name}`);
      if (detail.CustomerRef?.name) tags.push(`cust: ${detail.CustomerRef.name}`);
      if (line.ProjectRef?.value) tags.push(`project: ${line.ProjectRef.name || line.ProjectRef.value}`);
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

  return outputReport(`bill-${bill.Id}`, bill, lines.join('\n'));
}

export async function handleEditBill(
  client: QuickBooks,
  args: {
    id: string;
    vendor_name?: string;
    txn_date?: string;
    due_date?: string;
    memo?: string;
    department_name?: string | null;
    global_tax_calculation?: GlobalTaxCalc;
    doc_number?: string;
    lines?: BillLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  assertKnownKeys(args as Record<string, unknown>, EDIT_BILL_KEYS, 'edit_bill');
  const { id, vendor_name, txn_date, due_date, memo, department_name, global_tax_calculation, doc_number, lines: lineChanges, draft = true } = args;

  if (global_tax_calculation !== undefined && !GLOBAL_TAX_CALC_VALUES.has(global_tax_calculation)) {
    throw new Error(`Invalid global_tax_calculation: "${global_tax_calculation}". Expected one of: TaxExcluded, TaxInclusive, NotApplicable.`);
  }

  if (lineChanges) {
    lineChanges.forEach((change, idx) =>
      assertKnownKeys(change as unknown as Record<string, unknown>, BILL_LINE_CHANGE_KEYS, `edit_bill.lines[${idx}]`)
    );
  }

  // Fetch current Bill (include tax-related header fields so we can preserve
  // them on full update — QBO would otherwise reset GlobalTaxCalculation to
  // NotApplicable and drop TxnTaxDetail when any field is missing).
  const current = await promisify<unknown>((cb) =>
    client.getBill(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    DocNumber?: string;
    PrivateNote?: string;
    GlobalTaxCalculation?: string;
    TxnTaxDetail?: Record<string, unknown>;
    DepartmentRef?: { value: string; name?: string };
    VendorRef: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: LineDetail;
      ProjectRef?: { value: string; name?: string };
    }>;
  };

  // Resolve vendor if changing
  const vendorRef = vendor_name
    ? await resolveVendor(client, vendor_name)
    : current.VendorRef;

  // Intent flags computed from user input ------------------------------
  const wantsClearDept = department_name === null;
  const wantsSetDept = typeof department_name === 'string' && department_name.length > 0;

  // Clearing a header ref requires a full update (sparse can't null fields).
  const needsFullUpdate = (lineChanges && lineChanges.length > 0) || wantsClearDept;

  // Build updated Bill
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    VendorRef: vendorRef,
  };

  if (!needsFullUpdate) {
    updated.sparse = true;
  } else {
    // Full update: node-quickbooks defaults sparse=true, so force it off.
    // CRITICAL: preserve every header field QBO cares about — anything
    // omitted from a full update is reset to default server-side.
    updated.sparse = false;
    updated.TxnDate = current.TxnDate;
    updated.DueDate = current.DueDate;
    updated.DocNumber = current.DocNumber;
    updated.PrivateNote = current.PrivateNote;
    if (current.GlobalTaxCalculation) updated.GlobalTaxCalculation = current.GlobalTaxCalculation;
    if (current.TxnTaxDetail) updated.TxnTaxDetail = current.TxnTaxDetail;
    // Only copy existing DepartmentRef when caller is not trying to clear it.
    if (current.DepartmentRef && !wantsClearDept) {
      updated.DepartmentRef = current.DepartmentRef;
    }
    // Copy lines and strip read-only / server-managed fields. Stripping
    // line-level ProjectRef is critical: QBO derives it from CustomerRef when
    // CustomerRef points at a project, and a stale ProjectRef silently rejects
    // customer changes ("invisible" 200 OK that didn't change anything).
    updated.Line = current.Line.map(line => {
      const { LineNum, ProjectRef, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (due_date !== undefined) updated.DueDate = due_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (doc_number !== undefined) updated.DocNumber = doc_number;
  if (global_tax_calculation !== undefined) updated.GlobalTaxCalculation = global_tax_calculation;

  // Resolve department if changing to a new value
  if (wantsSetDept) {
    const deptCache = await getDepartmentCache(client);
    let match = deptCache.byName.get(department_name!.toLowerCase());
    if (!match) match = deptCache.items.find(d =>
      d.FullyQualifiedName?.toLowerCase().includes(department_name!.toLowerCase())
    );
    if (!match) throw new Error(`Department not found: "${department_name}"`);
    updated.DepartmentRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
  }
  // Note: wantsClearDept is handled implicitly — we don't copy it above and
  // don't set it here, so the full-update PUT omits DepartmentRef and QBO
  // clears it.

  // Track recognized / no-op / new-value per submitted lineChange for the draft preview
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
          throw new Error(`Line ID ${change.line_id} not found in bill`);
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
          if (nextAcct.value !== detail.AccountRef?.value) {
            detail.AccountRef = nextAcct;
            changedKeys.push('account_name');
          } else {
            noopKeys.push('account_name');
          }
        }
        // Customer: null or empty string clears; string value sets; undefined
        // leaves alone. Ref clears: assign explicit null (not delete) for
        // CustomerRef / ClassRef / TaxCodeRef — only explicit null clears.
        // (Line-level ProjectRef was stripped when we copied current.Line
        // above; QBO will re-derive it from the new CustomerRef.)
        const customerInput = "customer_id" in change ? change.customer_id : change.customer_name;
        if (customerInput === null || customerInput === '') {
          if (detail.CustomerRef != null) { detail.CustomerRef = null; changedKeys.push('customer'); } else { noopKeys.push('customer'); }
        } else if (typeof customerInput === 'string') {
          const nextCust = await resolveCustomer(client, customerInput);
          if (nextCust.value !== detail.CustomerRef?.value) { detail.CustomerRef = nextCust; changedKeys.push('customer'); } else { noopKeys.push('customer'); }
        }
        if (change.class_name !== undefined) {
          if (change.class_name === null || change.class_name === '') {
            if (detail.ClassRef != null) { detail.ClassRef = null; changedKeys.push('class'); } else { noopKeys.push('class'); }
          } else {
            const nextClass = await resolveClass(client, change.class_name);
            if (nextClass.value !== detail.ClassRef?.value) { detail.ClassRef = nextClass; changedKeys.push('class'); } else { noopKeys.push('class'); }
          }
        }
        if (change.tax_code !== undefined) {
          if (change.tax_code === null || change.tax_code === '') {
            if (detail.TaxCodeRef != null) { detail.TaxCodeRef = null; changedKeys.push('tax_code'); } else { noopKeys.push('tax_code'); }
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

        const customerInput = "customer_id" in change ? change.customer_id : change.customer_name;
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

  const qboUrl = `https://app.qbo.intuit.com/app/bill?txnId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Bill Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Header changes:',
    ];

    const headerRows: string[] = [];
    if (vendor_name) headerRows.push(`  Vendor: ${current.VendorRef?.name || current.VendorRef?.value} → ${(vendorRef as { name?: string }).name || vendor_name}`);
    if (txn_date !== undefined) headerRows.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (due_date !== undefined) headerRows.push(`  Due Date: ${current.DueDate || '(none)'} → ${due_date}`);
    if (memo !== undefined) headerRows.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (doc_number !== undefined) headerRows.push(`  Ref no.: ${current.DocNumber || '(none)'} → ${doc_number}`);
    if (wantsSetDept) headerRows.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${(updated.DepartmentRef as { name?: string })?.name || department_name}`);
    if (wantsClearDept) headerRows.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → (cleared)`);
    if (global_tax_calculation !== undefined) headerRows.push(`  GlobalTaxCalculation: ${current.GlobalTaxCalculation || '(none)'} → ${global_tax_calculation}`);
    if (headerRows.length === 0) previewLines.push('  (none)'); else previewLines.push(...headerRows);

    previewLines.push('');
    if (global_tax_calculation !== undefined) {
      previewLines.push(`Tax calc (override): GlobalTaxCalculation → ${global_tax_calculation}`);
    } else {
      previewLines.push(`Tax calc (preserved): GlobalTaxCalculation: ${current.GlobalTaxCalculation || '(none)'}`);
    }

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
    client.updateBill(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Bill ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
