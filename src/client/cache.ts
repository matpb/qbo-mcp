// Account and department caching for QuickBooks lookups

import QuickBooks from "node-quickbooks";
import { promisify } from "./promisify.js";
import {
  CachedAccount,
  CachedClass,
  CachedCustomer,
  CachedDepartment,
  CachedProject,
  CachedTaxCode,
  CachedVendor,
  CachedItem,
  AccountCache,
  ClassCache,
  DepartmentCache,
  ProjectCache,
  TaxCodeCache,
  VendorCache,
  QBQueryResponse,
} from "../types/index.js";

// Cache TTL (15 minutes)
const LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;

// Module-level cache state
let departmentCache: DepartmentCache | null = null;
let accountCache: AccountCache | null = null;
let vendorCache: VendorCache | null = null;
let classCache: ClassCache | null = null;
let taxCodeCache: TaxCodeCache | null = null;
let projectCache: ProjectCache | null = null;
// Item cache: lazy per-entry lookup (not bulk-loaded like others)
const itemCacheById = new Map<string, CachedItem>();
const itemCacheByName = new Map<string, CachedItem>(); // lowercase key
// Customer cache: lazy per-entry lookup (companies can have thousands)
const customerCacheById = new Map<string, CachedCustomer>();
const customerCacheByName = new Map<string, CachedCustomer>(); // lowercase key

export function clearLookupCache(): void {
  departmentCache = null;
  accountCache = null;
  vendorCache = null;
  classCache = null;
  taxCodeCache = null;
  projectCache = null;
  itemCacheById.clear();
  itemCacheByName.clear();
  customerCacheById.clear();
  customerCacheByName.clear();
}

// Helper to extract entities from QB query response with type safety
function extractQueryResults<T>(result: unknown, entityKey: string): T[] {
  const response = result as QBQueryResponse<T> | undefined;
  const entities = response?.QueryResponse?.[entityKey];
  return Array.isArray(entities) ? entities : [];
}

export async function getDepartmentCache(client: QuickBooks): Promise<DepartmentCache> {
  if (departmentCache && (Date.now() - departmentCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return departmentCache;
  }

  const result = await promisify<unknown>((cb) => client.findDepartments({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedDepartment>(result, 'Department');

  const byId = new Map<string, CachedDepartment>();
  const byName = new Map<string, CachedDepartment>();
  for (const dept of items) {
    byId.set(dept.Id, dept);
    byName.set(dept.Name.toLowerCase(), dept);
  }

  departmentCache = { items, byId, byName, fetchedAt: Date.now() };
  return departmentCache;
}

export async function getAccountCache(client: QuickBooks): Promise<AccountCache> {
  if (accountCache && (Date.now() - accountCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return accountCache;
  }

  const result = await promisify<unknown>((cb) => client.findAccounts({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedAccount>(result, 'Account');

  const byId = new Map<string, CachedAccount>();
  const byName = new Map<string, CachedAccount>();
  const byAcctNum = new Map<string, CachedAccount>();
  for (const acct of items) {
    byId.set(acct.Id, acct);
    byName.set(acct.Name.toLowerCase(), acct);
    if (acct.AcctNum) {
      byAcctNum.set(acct.AcctNum.toLowerCase(), acct);
    }
  }

  accountCache = { items, byId, byName, byAcctNum, fetchedAt: Date.now() };
  return accountCache;
}

// Resolve account by name, AcctNum, or ID using cache
export async function resolveAccount(client: QuickBooks, account: string): Promise<CachedAccount> {
  const cache = await getAccountCache(client);

  // Try exact ID match
  const byId = cache.byId.get(account);
  if (byId) return byId;

  // Try exact AcctNum match (case-insensitive)
  const byAcctNum = cache.byAcctNum.get(account.toLowerCase());
  if (byAcctNum) return byAcctNum;

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(account.toLowerCase());
  if (byName) return byName;

  // Try partial FullyQualifiedName match
  const byPartial = cache.items.find(a =>
    a.FullyQualifiedName?.toLowerCase().includes(account.toLowerCase())
  );
  if (byPartial) return byPartial;

  throw new Error(`Account not found: "${account}". Try using account name, number (AcctNum), or ID.`);
}

export async function getVendorCache(client: QuickBooks): Promise<VendorCache> {
  if (vendorCache && (Date.now() - vendorCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return vendorCache;
  }

  const result = await promisify<unknown>((cb) => client.findVendors({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedVendor>(result, 'Vendor');

  const byId = new Map<string, CachedVendor>();
  const byName = new Map<string, CachedVendor>();
  for (const vendor of items) {
    byId.set(vendor.Id, vendor);
    byName.set(vendor.DisplayName.toLowerCase(), vendor);
  }

  vendorCache = { items, byId, byName, fetchedAt: Date.now() };
  return vendorCache;
}

// Resolve vendor by name or ID using cache
// Returns { value, name } ref object for QuickBooks API
export async function resolveVendor(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  const cache = await getVendorCache(client);

  // Try exact ID match
  const byId = cache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.DisplayName };

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(nameOrId.toLowerCase());
  if (byName) return { value: byName.Id, name: byName.DisplayName };

  // Try partial name match
  const byPartial = cache.items.find(v =>
    v.DisplayName.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (byPartial) return { value: byPartial.Id, name: byPartial.DisplayName };

  throw new Error(`Vendor not found: "${nameOrId}". Try using vendor display name or ID.`);
}

// Resolve item by name or ID using lazy per-entry cache
// Unlike other caches, items are fetched on demand (companies can have thousands)
export async function resolveItem(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  // Check cache first (with TTL)
  const cached = itemCacheById.get(nameOrId) || itemCacheByName.get(nameOrId.toLowerCase());
  if (cached && (Date.now() - cached.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return { value: cached.Id, name: cached.Name };
  }

  // Pure numeric input → treat as QB Item ID and fetch directly
  if (/^\d+$/.test(nameOrId)) {
    try {
      const item = await promisify<{ Id: string; Name: string; FullyQualifiedName?: string; Type?: string; UnitPrice?: number; Active?: boolean }>((cb) =>
        (client as unknown as Record<string, Function>).getItem(nameOrId, cb)
      );
      const entry: CachedItem = {
        Id: item.Id,
        Name: item.Name,
        FullyQualifiedName: item.FullyQualifiedName,
        Type: item.Type,
        UnitPrice: item.UnitPrice,
        Active: item.Active,
        fetchedAt: Date.now(),
      };
      itemCacheById.set(item.Id, entry);
      itemCacheByName.set(item.Name.toLowerCase(), entry);
      return { value: item.Id, name: item.Name };
    } catch {
      // Fall through to name lookup — numeric string might still be a Name
    }
  }

  // Query QB for this specific item
  // Try exact name match first, then partial
  const result = await promisify<unknown>((cb) =>
    client.findItems([
      { field: 'Name', value: nameOrId, operator: '=' },
      { field: 'Active', value: true, operator: '=' },
    ], cb)
  );
  let items = extractQueryResults<{ Id: string; Name: string; FullyQualifiedName?: string; Type?: string; UnitPrice?: number; Active?: boolean }>(result, 'Item');

  // If no exact match, try LIKE for partial matching
  if (items.length === 0) {
    const partialResult = await promisify<unknown>((cb) =>
      client.findItems([
        { field: 'Name', value: `%${nameOrId}%`, operator: 'LIKE' },
        { field: 'Active', value: true, operator: '=' },
      ], cb)
    );
    items = extractQueryResults<typeof items[0]>(partialResult, 'Item');
  }

  if (items.length === 0) {
    throw new Error(`Item not found: "${nameOrId}". Try using the exact item name or ID.`);
  }

  // Use first match and cache it
  const item = items[0];
  const entry: CachedItem = {
    Id: item.Id,
    Name: item.Name,
    FullyQualifiedName: item.FullyQualifiedName,
    Type: item.Type,
    UnitPrice: item.UnitPrice,
    Active: item.Active,
    fetchedAt: Date.now(),
  };
  itemCacheById.set(item.Id, entry);
  itemCacheByName.set(item.Name.toLowerCase(), entry);

  return { value: item.Id, name: item.Name };
}

// Helper to resolve department name to ID using cache
// Accepts: internal ID (e.g., "5"), name (e.g., "20400"), or partial match
export async function resolveDepartmentId(client: QuickBooks, department: string): Promise<string> {
  const cache = await getDepartmentCache(client);

  // Try exact ID match first
  const byId = cache.byId.get(department);
  if (byId) return byId.Id;

  // Try exact name match (case-insensitive)
  const byName = cache.byName.get(department.toLowerCase());
  if (byName) return byName.Id;

  // Try partial/fuzzy match on FullyQualifiedName
  const byPartial = cache.items.find(d =>
    d.FullyQualifiedName?.toLowerCase().includes(department.toLowerCase())
  );
  if (byPartial) return byPartial.Id;

  // If nothing found, return as-is (let API handle error)
  return department;
}

// Resolve customer by name or ID using lazy per-entry cache
// Unlike vendor/account caches, customers are fetched on demand (companies can have thousands)
export async function resolveCustomer(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  // Check cache first (with TTL)
  const cached = customerCacheById.get(nameOrId) || customerCacheByName.get(nameOrId.toLowerCase());
  if (cached && (Date.now() - cached.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return { value: cached.Id, name: cached.DisplayName };
  }

  // Pure numeric input → treat as QB Customer ID and fetch directly
  if (/^\d+$/.test(nameOrId)) {
    try {
      const customer = await promisify<unknown>((cb) =>
        client.getCustomer(nameOrId, cb)
      ) as { Id: string; DisplayName: string; Active?: boolean };
      const entry: CachedCustomer = {
        Id: customer.Id,
        DisplayName: customer.DisplayName,
        Active: customer.Active,
        fetchedAt: Date.now(),
      };
      customerCacheById.set(customer.Id, entry);
      customerCacheByName.set(customer.DisplayName.toLowerCase(), entry);
      return { value: customer.Id, name: customer.DisplayName };
    } catch {
      // Fall through to name lookup — numeric string might still be a DisplayName
    }
  }

  // Query QB for this specific customer — exact DisplayName match first
  const result = await promisify<unknown>((cb) =>
    client.findCustomers([
      { field: 'DisplayName', value: nameOrId, operator: '=' },
      { field: 'Active', value: true, operator: '=' },
    ], cb)
  );
  let customers = extractQueryResults<{ Id: string; DisplayName: string; Active?: boolean }>(result, 'Customer');

  // If no exact match, try LIKE for partial matching
  if (customers.length === 0) {
    const partialResult = await promisify<unknown>((cb) =>
      client.findCustomers([
        { field: 'DisplayName', value: `%${nameOrId}%`, operator: 'LIKE' },
        { field: 'Active', value: true, operator: '=' },
      ], cb)
    );
    customers = extractQueryResults<typeof customers[0]>(partialResult, 'Customer');
  }

  if (customers.length === 0) {
    throw new Error(`Customer not found: "${nameOrId}". Try using the exact customer display name or ID.`);
  }

  // Use first match and cache it
  const customer = customers[0];
  const entry: CachedCustomer = {
    Id: customer.Id,
    DisplayName: customer.DisplayName,
    Active: customer.Active,
    fetchedAt: Date.now(),
  };
  customerCacheById.set(customer.Id, entry);
  customerCacheByName.set(customer.DisplayName.toLowerCase(), entry);

  return { value: customer.Id, name: customer.DisplayName };
}

export async function getClassCache(client: QuickBooks): Promise<ClassCache> {
  if (classCache && (Date.now() - classCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return classCache;
  }

  const result = await promisify<unknown>((cb) => client.findClasses({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedClass>(result, 'Class');

  const byId = new Map<string, CachedClass>();
  const byName = new Map<string, CachedClass>();
  const byFqName = new Map<string, CachedClass>();
  for (const cls of items) {
    byId.set(cls.Id, cls);
    byName.set(cls.Name.toLowerCase(), cls);
    if (cls.FullyQualifiedName) {
      byFqName.set(cls.FullyQualifiedName.toLowerCase(), cls);
    }
  }

  classCache = { items, byId, byName, byFqName, fetchedAt: Date.now() };
  return classCache;
}

export async function resolveClass(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  const cache = await getClassCache(client);

  const byId = cache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.FullyQualifiedName || byId.Name };

  const byFq = cache.byFqName.get(nameOrId.toLowerCase());
  if (byFq) return { value: byFq.Id, name: byFq.FullyQualifiedName || byFq.Name };

  const byName = cache.byName.get(nameOrId.toLowerCase());
  if (byName) return { value: byName.Id, name: byName.FullyQualifiedName || byName.Name };

  const byPartial = cache.items.find(c =>
    c.FullyQualifiedName?.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (byPartial) return { value: byPartial.Id, name: byPartial.FullyQualifiedName || byPartial.Name };

  throw new Error(`Class not found: "${nameOrId}". Try using class name or ID.`);
}

export async function getTaxCodeCache(client: QuickBooks): Promise<TaxCodeCache> {
  if (taxCodeCache && (Date.now() - taxCodeCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return taxCodeCache;
  }

  const result = await promisify<unknown>((cb) => client.findTaxCodes({ fetchAll: true }, cb));
  const items = extractQueryResults<CachedTaxCode>(result, 'TaxCode');

  const byId = new Map<string, CachedTaxCode>();
  const byName = new Map<string, CachedTaxCode>();
  for (const tc of items) {
    byId.set(tc.Id, tc);
    byName.set(tc.Name.toLowerCase(), tc);
  }

  taxCodeCache = { items, byId, byName, fetchedAt: Date.now() };
  return taxCodeCache;
}

// Resolve tax code by name or ID. QBO also accepts special literal IDs "TAX" and
// "NON" for US companies; we pass those through without cache lookup.
export async function resolveTaxCode(client: QuickBooks, nameOrId: string): Promise<{ value: string; name: string }> {
  const upper = nameOrId.toUpperCase();
  if (upper === 'TAX' || upper === 'NON') {
    return { value: upper, name: upper };
  }

  const cache = await getTaxCodeCache(client);

  const byId = cache.byId.get(nameOrId);
  if (byId) return { value: byId.Id, name: byId.Name };

  const byName = cache.byName.get(nameOrId.toLowerCase());
  if (byName) return { value: byName.Id, name: byName.Name };

  const byPartial = cache.items.find(t => t.Name.toLowerCase().includes(nameOrId.toLowerCase()));
  if (byPartial) return { value: byPartial.Id, name: byPartial.Name };

  throw new Error(`Tax code not found: "${nameOrId}". Try using the exact tax code name or ID.`);
}

// Project cache. Projects are Customer rows with IsProject=true; QBO does not
// allow filtering on IsProject, so we fetch every customer and filter
// in-memory. We also cache the parent customer ref per project, which is the
// only way to validate "this line's customer matches this line's project".
export async function getProjectCache(client: QuickBooks): Promise<ProjectCache> {
  if (projectCache && (Date.now() - projectCache.fetchedAt) < LOOKUP_CACHE_TTL_MS) {
    return projectCache;
  }

  type RawCustomer = {
    Id: string;
    DisplayName: string;
    FullyQualifiedName?: string;
    IsProject?: boolean;
    ParentRef?: { value: string; name?: string };
    Active?: boolean;
  };

  const result = await promisify<unknown>((cb) => client.findCustomers({ fetchAll: true }, cb));
  const allCustomers = extractQueryResults<RawCustomer>(result, 'Customer');
  const items: CachedProject[] = allCustomers
    .filter((c): c is RawCustomer & { ParentRef: { value: string; name?: string } } =>
      Boolean(c.IsProject && c.ParentRef && c.ParentRef.value)
    )
    .map((c) => ({
      Id: c.Id,
      DisplayName: c.DisplayName,
      FullyQualifiedName: c.FullyQualifiedName,
      ParentRef: c.ParentRef,
      Active: c.Active,
    }));

  const byId = new Map<string, CachedProject>();
  const byName = new Map<string, CachedProject>();
  const byFqName = new Map<string, CachedProject>();
  for (const p of items) {
    byId.set(p.Id, p);
    byName.set(p.DisplayName.toLowerCase(), p);
    if (p.FullyQualifiedName) {
      byFqName.set(p.FullyQualifiedName.toLowerCase(), p);
    }
  }

  projectCache = { items, byId, byName, byFqName, fetchedAt: Date.now() };
  return projectCache;
}

// Resolve a project by ID, DisplayName, FullyQualifiedName, or partial FQ
// match. Returns the QBO ref shape plus the parent customer's ID/name so
// callers can validate the line's customer matches the project's parent
// (QBO will silently reject customer changes that conflict with an existing
// ProjectRef).
export async function resolveProject(
  client: QuickBooks,
  nameOrId: string
): Promise<{ value: string; name: string; parentValue: string; parentName?: string }> {
  const cache = await getProjectCache(client);

  const toRef = (p: CachedProject) => ({
    value: p.Id,
    name: p.FullyQualifiedName || p.DisplayName,
    parentValue: p.ParentRef.value,
    parentName: p.ParentRef.name,
  });

  const byId = cache.byId.get(nameOrId);
  if (byId) return toRef(byId);

  const byFq = cache.byFqName.get(nameOrId.toLowerCase());
  if (byFq) return toRef(byFq);

  const byName = cache.byName.get(nameOrId.toLowerCase());
  if (byName) return toRef(byName);

  const byPartial = cache.items.find((p) =>
    p.FullyQualifiedName?.toLowerCase().includes(nameOrId.toLowerCase())
  );
  if (byPartial) return toRef(byPartial);

  throw new Error(
    `Project not found: "${nameOrId}". Pass a project ID, exact DisplayName, or "Parent Customer:Project" FullyQualifiedName. Use list_projects to see available projects and their parent customers.`
  );
}
