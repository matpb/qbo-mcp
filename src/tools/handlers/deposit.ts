// Handlers for deposit tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getDepartmentCache,
  getVendorCache,
  resolveClass,
} from "../../client/index.js";
import { validateAmount, toDollars, formatDollars, toCents, sumCents, outputReport, assertKnownKeys } from "../../utils/index.js";
import type { AccountCache, DepartmentCache, VendorCache } from "../../types/index.js";

type GlobalTaxCalc = "TaxExcluded" | "TaxInclusive" | "NotApplicable";

const GLOBAL_TAX_CALC_VALUES = new Set<GlobalTaxCalc>(['TaxExcluded', 'TaxInclusive', 'NotApplicable']);

const CREATE_DEPOSIT_KEYS = [
  'deposit_to_account', 'txn_date', 'lines',
  'department_name', 'department_id', 'memo', 'draft',
] as const;

const EDIT_DEPOSIT_KEYS = [
  'id', 'txn_date', 'memo', 'deposit_to_account', 'department_name',
  'global_tax_calculation', 'lines', 'draft', 'expected_total',
] as const;

const CREATE_DEPOSIT_LINE_KEYS = [
  'amount', 'account_name', 'account_id', 'description',
  'entity_name', 'entity_id', 'class_name',
] as const;

const EDIT_DEPOSIT_LINE_KEYS = [
  'line_id', 'amount', 'account_name', 'description',
  'entity_name', 'entity_id', 'class_name',
] as const;

// --- Interfaces ---

// For create_deposit lines
interface CreateDepositLineInput {
  amount: number;
  account_name?: string;
  account_id?: string;
  description?: string;
  entity_name?: string;
  entity_id?: string;
  class_name?: string;
}

// For edit_deposit lines
interface DepositLineInput {
  line_id?: string;  // Include to update existing line (preserves Entity ref unless overridden)
  amount: number;
  account_name: string;
  description?: string;
  entity_name?: string | null;
  entity_id?: string | null;
  class_name?: string | null;
}

interface DepositLine {
  Id?: string;
  Amount: number;
  Description?: string;
  DetailType: string;
  DepositLineDetail?: {
    AccountRef?: { value: string; name?: string };
    // null is the wire-level signal to clear an existing nested ref on a deposit
    // line. Omitting these keys leaves the server's stored value untouched.
    Entity?: {
      value: string;
      name?: string;
      type?: string;
    } | null;
    ClassRef?: { value: string; name?: string } | null;
    PaymentMethodRef?: { value: string; name?: string };
    CheckNum?: string;
  };
  // ProjectRef is at LINE level (not in detail) and server-managed by QBO.
  // We strip it on round-trip; QBO re-derives it from line entity/customer.
  ProjectRef?: { value: string; name?: string };
}

interface Deposit {
  Id: string;
  SyncToken: string;
  TxnDate: string;
  PrivateNote?: string;
  TotalAmt?: number;
  DepositToAccountRef?: { value: string; name?: string };
  DepartmentRef?: { value: string; name?: string };
  Line?: DepositLine[];
}

// --- Shared resolution helpers ---

function resolveAccountRef(
  acctCache: AccountCache,
  name: string
): { value: string; name: string } {
  let match = acctCache.byAcctNum.get(name.toLowerCase());
  if (!match) match = acctCache.byName.get(name.toLowerCase());
  if (!match) match = acctCache.items.find(a =>
    a.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
  );
  if (!match) throw new Error(`Account not found: "${name}"`);
  return { value: match.Id, name: match.FullyQualifiedName || match.Name };
}

function resolveDepartmentRef(
  deptCache: DepartmentCache,
  nameOrId: string
): { value: string; name: string } {
  const byId = deptCache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.FullyQualifiedName || byId.Name };

  let match = deptCache.byName.get(nameOrId.toLowerCase());
  if (!match) match = deptCache.items.find(d =>
    d.FullyQualifiedName?.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (!match) throw new Error(`Department not found: "${nameOrId}"`);
  return { value: match.Id, name: match.FullyQualifiedName || match.Name };
}

function resolveEntityRef(
  vendorCache: VendorCache,
  nameOrId: string
): { value: string; name: string; type: string } {
  const byId = vendorCache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.DisplayName, type: "VENDOR" };

  const byName = vendorCache.byName.get(nameOrId.toLowerCase());
  if (byName) return { value: byName.Id, name: byName.DisplayName, type: "VENDOR" };

  const byPartial = vendorCache.items.find(v =>
    v.DisplayName.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (byPartial) return { value: byPartial.Id, name: byPartial.DisplayName, type: "VENDOR" };

  throw new Error(`Vendor not found: "${nameOrId}"`);
}

// --- Handlers ---

export async function handleCreateDeposit(
  client: QuickBooks,
  args: {
    deposit_to_account: string;
    txn_date: string;
    lines: CreateDepositLineInput[];
    department_name?: string;
    department_id?: string;
    memo?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  assertKnownKeys(args as Record<string, unknown>, CREATE_DEPOSIT_KEYS, 'create_deposit');
  const {
    deposit_to_account, txn_date, lines,
    department_name, department_id, memo, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }
  lines.forEach((line, idx) =>
    assertKnownKeys(line as unknown as Record<string, unknown>, CREATE_DEPOSIT_LINE_KEYS, `create_deposit.lines[${idx}]`)
  );

  // Parallel cache fetch
  const [acctCache, deptCache, vendorCacheData] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client),
    getVendorCache(client),
  ]);

  // Resolve deposit_to_account
  const depositToRef = resolveAccountRef(acctCache, deposit_to_account);

  // Resolve header-level department
  let departmentRef: { value: string; name: string } | undefined;
  const deptInput = department_id || department_name;
  if (deptInput) {
    departmentRef = resolveDepartmentRef(deptCache, deptInput);
  }

  // Resolve lines
  const resolvedLines = await Promise.all(lines.map(async (line, i) => {
    const label = `Line ${i + 1}`;

    // Resolve account
    let accountRef: { value: string; name: string };
    if (line.account_id) {
      const byId = acctCache.byId.get(line.account_id);
      if (byId) {
        accountRef = { value: byId.Id, name: byId.FullyQualifiedName || byId.Name };
      } else {
        throw new Error(`${label}: Account ID not found: "${line.account_id}"`);
      }
    } else if (line.account_name) {
      accountRef = resolveAccountRef(acctCache, line.account_name);
    } else {
      throw new Error(`${label}: Either account_name or account_id is required`);
    }

    // Validate amount
    const amountCents = validateAmount(line.amount, label);

    // Resolve entity if provided
    let entityRef: { value: string; name: string; type: string } | undefined;
    if (line.entity_id) {
      entityRef = resolveEntityRef(vendorCacheData, line.entity_id);
    } else if (line.entity_name) {
      entityRef = resolveEntityRef(vendorCacheData, line.entity_name);
    }

    // Resolve class if provided
    const classRef = line.class_name ? await resolveClass(client, line.class_name) : undefined;

    return {
      accountRef,
      amountCents,
      amount: toDollars(amountCents),
      description: line.description,
      entityRef,
      classRef,
    };
  }));

  // Calculate total for display
  const totalCents = sumCents(resolvedLines.map(l => l.amountCents));

  // Build QB deposit object
  const depositObject: Record<string, unknown> = {
    DepositToAccountRef: depositToRef,
    TxnDate: txn_date,
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(memo && { PrivateNote: memo }),
    Line: resolvedLines.map(line => {
      const depositLineDetail: Record<string, unknown> = {
        AccountRef: line.accountRef,
      };
      if (line.entityRef) depositLineDetail.Entity = line.entityRef;
      if (line.classRef) depositLineDetail.ClassRef = line.classRef;
      return {
        Amount: line.amount,
        DetailType: "DepositLineDetail",
        ...(line.description && { Description: line.description }),
        DepositLineDetail: depositLineDetail,
      };
    }),
  };

  if (draft) {
    const preview = [
      "DRAFT - Deposit Preview",
      "",
      `Date: ${txn_date}`,
      `Deposit To: ${depositToRef.name}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      "",
      "Lines:",
      ...resolvedLines.map(l => {
        const entityStr = l.entityRef ? ` [${l.entityRef.name}]` : "";
        const descStr = l.description ? ` "${l.description}"` : "";
        return `  ${l.accountRef.name}: $${l.amount.toFixed(2)}${entityStr}${descStr}`;
      }),
      "  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      `  Total: $${formatDollars(totalCents)}`,
      "",
      "Set draft=false to create this deposit.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the deposit
  const result = await promisify<unknown>((cb) =>
    client.createDeposit(depositObject, cb)
  ) as { Id: string };

  const qboUrl = `https://app.qbo.intuit.com/app/deposit?txnId=${result.Id}`;

  const response = [
    "Deposit Created!",
    "",
    `ID: ${result.Id}`,
    `Date: ${txn_date}`,
    `Deposit To: ${depositToRef.name}`,
    `Department: ${departmentRef?.name || "(none)"}`,
    `Total: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetDeposit(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const deposit = await promisify<unknown>((cb) =>
    client.getDeposit(id, cb)
  ) as Deposit;
  const qboUrl = `https://app.qbo.intuit.com/app/deposit?txnId=${deposit.Id}`;

  // Format summary
  const lines: string[] = [
    'Deposit',
    '=======',
    `ID: ${deposit.Id}`,
    `SyncToken: ${deposit.SyncToken}`,
    `Date: ${deposit.TxnDate}`,
    `Deposit To: ${deposit.DepositToAccountRef?.name || deposit.DepositToAccountRef?.value || '(default)'}`,
    `Department: ${deposit.DepartmentRef?.name || deposit.DepartmentRef?.value || '(none)'}`,
    `Memo: ${deposit.PrivateNote || '(none)'}`,
    `Total: $${(deposit.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of deposit.Line || []) {
    if (line.DepositLineDetail) {
      const detail = line.DepositLineDetail;
      const acctName = detail.AccountRef?.name || detail.AccountRef?.value || '(no account)';
      const entityStr = detail.Entity?.name
        ? ` from ${detail.Entity.type || 'Entity'}: ${detail.Entity.name}`
        : '';
      const tags: string[] = [];
      if (detail.ClassRef?.name) tags.push(detail.ClassRef.name);
      if (line.ProjectRef?.value) tags.push(`project: ${line.ProjectRef.name || line.ProjectRef.value}`);
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: ${acctName} $${line.Amount.toFixed(2)}${entityStr}${tagStr}${descStr}`);
    }
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`deposit-${deposit.Id}`, deposit, lines.join('\n'));
}

export async function handleEditDeposit(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    memo?: string;
    deposit_to_account?: string;
    department_name?: string | null;
    global_tax_calculation?: GlobalTaxCalc;
    lines?: DepositLineInput[];
    draft?: boolean;
    expected_total?: number;  // For fixing corrupted deposits - bypasses validation
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  assertKnownKeys(args as Record<string, unknown>, EDIT_DEPOSIT_KEYS, 'edit_deposit');
  const { id, txn_date, memo, deposit_to_account, department_name, global_tax_calculation, lines: newLines, draft = true, expected_total } = args;

  if (global_tax_calculation !== undefined && !GLOBAL_TAX_CALC_VALUES.has(global_tax_calculation)) {
    throw new Error(`Invalid global_tax_calculation: "${global_tax_calculation}". Expected one of: TaxExcluded, TaxInclusive, NotApplicable.`);
  }

  if (newLines) {
    newLines.forEach((line, idx) =>
      assertKnownKeys(line as unknown as Record<string, unknown>, EDIT_DEPOSIT_LINE_KEYS, `edit_deposit.lines[${idx}]`)
    );
  }

  const wantsClearDept = department_name === null;
  const wantsSetDept = typeof department_name === 'string' && department_name.length > 0;

  // Fetch current Deposit
  const current = await promisify<unknown>((cb) =>
    client.getDeposit(id, cb)
  ) as Deposit & { GlobalTaxCalculation?: string; TxnTaxDetail?: Record<string, unknown> };

  // Clearing a header ref requires full update
  const needsFullUpdate = (newLines && newLines.length > 0) || wantsClearDept;

  // Build updated Deposit
  let updated: Record<string, unknown>;

  // Only use sparse for non-line updates; full update needed for line modifications
  // Note: node-quickbooks auto-sets sparse=true, so we must explicitly set sparse=false for full updates
  if (!needsFullUpdate) {
    updated = {
      Id: current.Id,
      SyncToken: current.SyncToken,
      sparse: true,
    };
    // DepositToAccountRef is required for sparse updates
    if (current.DepositToAccountRef) {
      updated.DepositToAccountRef = current.DepositToAccountRef;
    }
  } else {
    // Full update: preserve every header field — anything omitted is reset server-side.
    updated = {
      Id: current.Id,
      SyncToken: current.SyncToken,
      sparse: false,
      TxnDate: current.TxnDate,
      PrivateNote: current.PrivateNote,
    };
    if (current.DepositToAccountRef) updated.DepositToAccountRef = current.DepositToAccountRef;
    if (current.DepartmentRef && !wantsClearDept) updated.DepartmentRef = current.DepartmentRef;
    if (current.GlobalTaxCalculation) updated.GlobalTaxCalculation = current.GlobalTaxCalculation;
    if (current.TxnTaxDetail) updated.TxnTaxDetail = current.TxnTaxDetail;
    if ((current as unknown as Record<string, unknown>).CurrencyRef) {
      updated.CurrencyRef = (current as unknown as Record<string, unknown>).CurrencyRef;
    }
    // Copy lines and strip read-only / server-managed fields. Line-level
    // ProjectRef is server-derived from line entity (see expense.ts).
    updated.Line = (current.Line || []).map(line => {
      const { LineNum, CustomExtensions, ProjectRef, ...rest } = line as unknown as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (global_tax_calculation !== undefined) updated.GlobalTaxCalculation = global_tax_calculation;

  // Fetch caches when needed for header-level resolution or line processing
  const needsAcctCache = deposit_to_account !== undefined || (newLines && newLines.length > 0);
  const needsDeptCache = wantsSetDept;

  const [acctCache, deptCache] = await Promise.all([
    needsAcctCache ? getAccountCache(client) : Promise.resolve(null),
    needsDeptCache ? getDepartmentCache(client) : Promise.resolve(null),
  ]);

  // Resolve deposit_to_account if provided
  if (deposit_to_account !== undefined) {
    const ref = resolveAccountRef(acctCache!, deposit_to_account);
    updated.DepositToAccountRef = ref;
  }

  // Resolve header-level department if provided (null = clear, handled by full-update branch)
  if (wantsSetDept) {
    const ref = resolveDepartmentRef(deptCache!, department_name!);
    updated.DepartmentRef = ref;
  }

  // Process full line replacement if provided
  // QB API does not support deleting individual deposit lines, so we do full replacement
  // The new lines must sum to the same total as the original deposit (bank amount cannot change)
  if (newLines && newLines.length > 0) {
    // Build new lines array (full replacement)
    // If line_id is provided, find existing line and update it (preserves Entity ref)
    // If line_id is not provided, create a new line
    const currentLines = current.Line || [];
    const currentLinesById = new Map(currentLines.map(l => [l.Id, l]));
    const finalLines: DepositLine[] = [];
    const lineCents: number[] = [];

    // Lazy-load vendor cache (only if any line has an entity_name/entity_id string value)
    let vendorCacheData: VendorCache | null = null;
    const needsVendorCache = newLines.some(l =>
      typeof l.entity_name === 'string' && l.entity_name.length > 0 ||
      typeof l.entity_id === 'string' && l.entity_id.length > 0
    );
    if (needsVendorCache) vendorCacheData = await getVendorCache(client);

    for (let i = 0; i < newLines.length; i++) {
      const input = newLines[i];
      const amountCents = validateAmount(input.amount, `Line ${i + 1}`);
      lineCents.push(amountCents);

      let line: DepositLine;

      if (input.line_id) {
        // Update existing line - preserve Entity ref unless overridden
        const existing = currentLinesById.get(input.line_id);
        if (!existing) {
          throw new Error(`Line ID ${input.line_id} not found in deposit`);
        }
        // Clone the existing line to preserve Entity (strip read-only fields)
        const existingAny = existing as unknown as Record<string, unknown>;
        const { LineNum, CustomExtensions, ...rest } = existingAny;
        line = rest as unknown as DepositLine;
        line.Amount = toDollars(amountCents);
        line.DepositLineDetail = {
          ...line.DepositLineDetail,
          AccountRef: resolveAccountRef(acctCache!, input.account_name),
        };
      } else {
        // Create new line
        line = {
          Amount: toDollars(amountCents),
          DetailType: 'DepositLineDetail',
          DepositLineDetail: {
            AccountRef: resolveAccountRef(acctCache!, input.account_name),
          },
        };
      }

      if (input.description !== undefined) {
        line.Description = input.description;
      }

      // Apply entity override / clear. Deposit line refs are QBO-quirky:
      // neither key omission nor explicit null actually clears a nested ref
      // on a deposit line — the server silently preserves the prior value.
      // Empirically confirmed: sending { value: "0" } is the clear sentinel
      // QBO honors for deposit line Entity and ClassRef. For bill/expense/
      // vendor_credit/sales_receipt the opposite holds — { value: "0" } 400s
      // and null clears cleanly — so this workaround is scoped to deposit
      // only. (Probe: probe-deposit-entity-clear.mjs)
      const CLEAR = { value: '0' };
      // Use `in` to distinguish explicit-null from absent (`??` would collapse
      // `entity_id: null` with entity_name absent into undefined).
      const entityInput = 'entity_id' in input ? input.entity_id : input.entity_name;
      if (entityInput === null || entityInput === '') {
        line.DepositLineDetail = {
          ...line.DepositLineDetail!,
          Entity: CLEAR as unknown as { value: string; name?: string; type?: string },
        };
      } else if (typeof entityInput === 'string') {
        line.DepositLineDetail = {
          ...line.DepositLineDetail!,
          Entity: resolveEntityRef(vendorCacheData!, entityInput),
        };
      }

      // Apply class override / clear
      if (input.class_name !== undefined) {
        if (input.class_name === null || input.class_name === '') {
          line.DepositLineDetail = {
            ...line.DepositLineDetail!,
            ClassRef: CLEAR,
          };
        } else {
          line.DepositLineDetail = {
            ...line.DepositLineDetail!,
            ClassRef: await resolveClass(client, input.class_name),
          };
        }
      }

      finalLines.push(line);
    }

    // Validate that new total matches expected total
    // Use expected_total if provided (for fixing corrupted deposits), otherwise use current total
    const targetTotalCents = expected_total !== undefined
      ? validateAmount(expected_total, "expected_total")
      : toCents(current.TotalAmt || 0);
    const newTotalCents = sumCents(lineCents);

    if (newTotalCents !== targetTotalCents) {
      const diff = toDollars(newTotalCents - targetTotalCents);
      const targetLabel = expected_total !== undefined ? "expected" : "original deposit";
      throw new Error(
        `Line amounts must sum to the ${targetLabel} total. ` +
        `Target: $${toDollars(targetTotalCents).toFixed(2)}, ` +
        `New total: $${toDollars(newTotalCents).toFixed(2)} ` +
        `(difference: $${diff >= 0 ? '+' : ''}${diff.toFixed(2)}). ` +
        (expected_total === undefined ? `The bank deposit amount cannot change.` : '')
      );
    }

    updated.Line = finalLines;
  }

  const qboUrl = `https://app.qbo.intuit.com/app/deposit?txnId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Deposit Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Changes:',
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} \u2192 ${txn_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} \u2192 ${memo}`);
    if (deposit_to_account !== undefined) {
      const newAcct = (updated.DepositToAccountRef as { name?: string })?.name || deposit_to_account;
      previewLines.push(`  Deposit To: ${current.DepositToAccountRef?.name || '(default)'} \u2192 ${newAcct}`);
    }
    if (wantsSetDept) {
      const newDept = (updated.DepartmentRef as { name?: string })?.name || department_name;
      previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} \u2192 ${newDept}`);
    }
    if (wantsClearDept) {
      previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} \u2192 (cleared)`);
    }
    if (global_tax_calculation !== undefined) {
      previewLines.push(`  GlobalTaxCalculation: ${current.GlobalTaxCalculation || '(none)'} \u2192 ${global_tax_calculation}`);
    }
    previewLines.push('');
    if (global_tax_calculation !== undefined) {
      previewLines.push(`Tax calc (override): GlobalTaxCalculation \u2192 ${global_tax_calculation}`);
    } else {
      previewLines.push(`Tax calc (preserved): GlobalTaxCalculation: ${current.GlobalTaxCalculation || '(none)'}`);
    }

    if (updated.Line) {
      previewLines.push('');
      previewLines.push(`New Lines (replacing ${current.Line?.length || 0} existing lines):`);
      let lineTotal = 0;
      for (const line of updated.Line as DepositLine[]) {
        const detail = line.DepositLineDetail;
        if (detail) {
          const acctName = detail.AccountRef?.name || detail.AccountRef?.value || '(account)';
          const tags: string[] = [];
          if (detail.Entity?.name) tags.push(`entity: ${detail.Entity.name}`);
          if (detail.ClassRef?.name) tags.push(`class: ${detail.ClassRef.name}`);
          if (line.ProjectRef?.value) tags.push(`project: ${line.ProjectRef.name || line.ProjectRef.value}`);
          const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
          const descStr = line.Description ? ` "${line.Description}"` : '';
          previewLines.push(`  ${acctName}${tagStr}: $${line.Amount.toFixed(2)}${descStr}`);
          lineTotal += line.Amount;
        }
      }
      previewLines.push(`  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
      if (expected_total !== undefined) {
        previewLines.push(`  Total: $${lineTotal.toFixed(2)} (expected: $${expected_total.toFixed(2)}, current: $${(current.TotalAmt || 0).toFixed(2)})`);
      } else {
        previewLines.push(`  Total: $${lineTotal.toFixed(2)} (must equal original: $${(current.TotalAmt || 0).toFixed(2)})`);
      }
    }

    previewLines.push('');
    previewLines.push('Set draft=false to apply these changes.');

    return {
      content: [{ type: "text", text: previewLines.join('\n') }],
    };
  }

  const result = await promisify<unknown>((cb) =>
    client.updateDeposit(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Deposit ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
