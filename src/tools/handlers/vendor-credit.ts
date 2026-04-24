// Handlers for vendor credit tools (create, get, edit)

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

interface CreateVendorCreditLine {
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

interface VendorCreditLineChange {
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

const CREATE_VC_KEYS = [
  'vendor_name', 'vendor_id', 'txn_date',
  'department_name', 'department_id', 'ap_account',
  'memo', 'doc_number', 'lines', 'draft',
] as const;

const EDIT_VC_KEYS = [
  'id', 'vendor_name', 'txn_date', 'memo',
  'department_name', 'doc_number', 'lines', 'draft',
] as const;

const CREATE_VC_LINE_KEYS = [
  'account_id', 'account_name', 'amount', 'description',
  'customer_name', 'customer_id', 'class_name', 'tax_code', 'billable_status',
] as const;

const VC_LINE_CHANGE_KEYS = [
  'line_id', 'account_name', 'amount', 'description',
  'customer_name', 'customer_id', 'class_name', 'tax_code', 'billable_status',
  'delete',
] as const;

type LineDetail = {
  AccountRef: { value: string; name?: string };
  DepartmentRef?: { value: string; name?: string };
  CustomerRef?: { value: string; name?: string };
  ClassRef?: { value: string; name?: string };
  TaxCodeRef?: { value: string; name?: string };
  BillableStatus?: BillableStatus;
};

export async function handleCreateVendorCredit(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    txn_date: string;
    department_name?: string;
    department_id?: string;
    ap_account?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateVendorCreditLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  assertKnownKeys(args as Record<string, unknown>, CREATE_VC_KEYS, 'create_vendor_credit');
  const {
    vendor_name, vendor_id, txn_date,
    department_name, department_id, ap_account,
    memo, doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }
  lines.forEach((line, idx) =>
    assertKnownKeys(line as unknown as Record<string, unknown>, CREATE_VC_LINE_KEYS, `create_vendor_credit.lines[${idx}]`)
  );

  const [acctCache, deptCache, vendorCacheData] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client),
    getVendorCache(client),
  ]);

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
  if (vendor_id) vendorRef = resolveVendorRef(vendor_id);
  else if (vendor_name) vendorRef = resolveVendorRef(vendor_name);
  else throw new Error("Either vendor_name or vendor_id is required");

  const lookupAccount = (name: string): { id: string; name: string; acctNum?: string } => {
    let match = acctCache.byAcctNum.get(name.toLowerCase());
    if (!match) match = acctCache.byName.get(name.toLowerCase());
    if (!match) match = acctCache.items.find(a =>
      a.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
    );
    if (match) return { id: match.Id, name: match.FullyQualifiedName || match.Name, acctNum: match.AcctNum };
    throw new Error(`Account not found: "${name}"`);
  };

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

  let apAccountRef: { value: string; name: string } | undefined;
  if (ap_account) {
    const acct = lookupAccount(ap_account);
    apAccountRef = { value: acct.id, name: acct.name };
  }

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

    let billableStatus: BillableStatus | undefined = line.billable_status;
    if (!billableStatus && !customerRef) billableStatus = "NotBillable";

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

  const totalCents = sumCents(resolvedLines.map(l => l.amount_cents));

  const vcObject: Record<string, unknown> = {
    VendorRef: vendorRef,
    TxnDate: txn_date,
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(apAccountRef && { APAccountRef: apAccountRef }),
    Line: resolvedLines.map((line) => ({
      Amount: line.amount,
      DetailType: "AccountBasedExpenseLineDetail",
      ...(line.description && { Description: line.description }),
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: line.account_id, name: line.account_name },
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
      "DRAFT - Vendor Credit Preview",
      "",
      `Vendor: ${vendorRef.name}`,
      `Date: ${txn_date}`,
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
      "Set draft=false to create this vendor credit.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisify<unknown>((cb) =>
    client.createVendorCredit(vcObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = `https://app.qbo.intuit.com/app/vendorcredit?txnId=${result.Id}`;

  const response = [
    "Vendor Credit Created!",
    "",
    `Vendor: ${vendorRef.name}`,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Total: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}

export async function handleGetVendorCredit(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const vc = await promisify<unknown>((cb) =>
    client.getVendorCredit(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
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
    }>;
  };
  const qboUrl = `https://app.qbo.intuit.com/app/vendorcredit?txnId=${vc.Id}`;

  const lines: string[] = [
    'Vendor Credit',
    '=============',
    `ID: ${vc.Id}`,
    `SyncToken: ${vc.SyncToken}`,
    `Vendor: ${vc.VendorRef?.name || vc.VendorRef?.value || '(none)'}`,
    `Date: ${vc.TxnDate}`,
    `Ref no.: ${vc.DocNumber || '(none)'}`,
    `Memo: ${vc.PrivateNote || '(none)'}`,
    `AP Account: ${vc.APAccountRef?.name || vc.APAccountRef?.value || 'Accounts Payable'}`,
    `Department: ${vc.DepartmentRef?.name || vc.DepartmentRef?.value || '(none)'}`,
    `Tax Calc: ${vc.GlobalTaxCalculation || '(none)'}`,
    `Total: $${(vc.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of vc.Line || []) {
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
    }
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`vendor-credit-${vc.Id}`, vc, lines.join('\n'));
}

export async function handleEditVendorCredit(
  client: QuickBooks,
  args: {
    id: string;
    vendor_name?: string;
    txn_date?: string;
    memo?: string;
    department_name?: string | null;
    doc_number?: string;
    lines?: VendorCreditLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  assertKnownKeys(args as Record<string, unknown>, EDIT_VC_KEYS, 'edit_vendor_credit');
  const { id, vendor_name, txn_date, memo, department_name, doc_number, lines: lineChanges, draft = true } = args;

  if (lineChanges) {
    lineChanges.forEach((change, idx) =>
      assertKnownKeys(change as unknown as Record<string, unknown>, VC_LINE_CHANGE_KEYS, `edit_vendor_credit.lines[${idx}]`)
    );
  }

  const current = await promisify<unknown>((cb) =>
    client.getVendorCredit(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    GlobalTaxCalculation?: string;
    TxnTaxDetail?: Record<string, unknown>;
    VendorRef: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: LineDetail;
    }>;
  };

  const wantsClearDept = department_name === null;
  const wantsSetDept = typeof department_name === 'string' && department_name.length > 0;
  const needsFullUpdate = (lineChanges && lineChanges.length > 0) || wantsClearDept;

  let vendorRef = current.VendorRef;

  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    VendorRef: vendorRef,
  };

  if (!needsFullUpdate) {
    updated.sparse = true;
  } else {
    updated.sparse = false;
    updated.TxnDate = current.TxnDate;
    updated.PrivateNote = current.PrivateNote;
    updated.DocNumber = current.DocNumber;
    if (current.GlobalTaxCalculation) updated.GlobalTaxCalculation = current.GlobalTaxCalculation;
    if (current.TxnTaxDetail) updated.TxnTaxDetail = current.TxnTaxDetail;
    if (current.DepartmentRef && !wantsClearDept) updated.DepartmentRef = current.DepartmentRef;
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  // Resolve vendor if changing
  if (vendor_name) {
    const vendorCacheData = await getVendorCache(client);
    const byName = vendorCacheData.byName.get(vendor_name.toLowerCase());
    if (byName) {
      vendorRef = { value: byName.Id, name: byName.DisplayName };
    } else {
      const byPartial = vendorCacheData.items.find(v =>
        v.DisplayName.toLowerCase().includes(vendor_name.toLowerCase())
      );
      if (byPartial) {
        vendorRef = { value: byPartial.Id, name: byPartial.DisplayName };
      } else {
        throw new Error(`Vendor not found: "${vendor_name}"`);
      }
    }
    updated.VendorRef = vendorRef;
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (doc_number !== undefined) updated.DocNumber = doc_number;

  if (wantsSetDept) {
    const deptCache = await getDepartmentCache(client);
    let match = deptCache.byName.get(department_name!.toLowerCase());
    if (!match) match = deptCache.items.find(d =>
      d.FullyQualifiedName?.toLowerCase().includes(department_name!.toLowerCase())
    );
    if (!match) throw new Error(`Department not found: "${department_name}"`);
    updated.DepartmentRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
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
        if (lineIndex === -1) throw new Error(`Line ID ${change.line_id} not found in vendor credit`);
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

  const qboUrl = `https://app.qbo.intuit.com/app/vendorcredit?txnId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Vendor Credit Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Header changes:',
    ];

    const headerRows: string[] = [];
    if (vendor_name) headerRows.push(`  Vendor: ${current.VendorRef?.name || current.VendorRef?.value} → ${(vendorRef as { name?: string }).name || vendor_name}`);
    if (txn_date !== undefined) headerRows.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (memo !== undefined) headerRows.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (doc_number !== undefined) headerRows.push(`  Ref no.: ${current.DocNumber || '(none)'} → ${doc_number}`);
    if (wantsSetDept) headerRows.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${(updated.DepartmentRef as { name?: string })?.name || department_name}`);
    if (wantsClearDept) headerRows.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → (cleared)`);
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

    return { content: [{ type: "text", text: previewLines.join('\n') }] };
  }

  const result = await promisify<unknown>((cb) =>
    client.updateVendorCredit(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Vendor Credit ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
