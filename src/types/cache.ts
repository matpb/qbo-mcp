// Cache types for account and department lookups

export interface CachedDepartment {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
}

export interface CachedAccount {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  AcctNum?: string;
  AccountType?: string;
  CurrentBalance?: number;
  Active?: boolean;
}

export interface DepartmentCache {
  items: CachedDepartment[];
  byId: Map<string, CachedDepartment>;
  byName: Map<string, CachedDepartment>;  // lowercase key
  fetchedAt: number;
}

export interface AccountCache {
  items: CachedAccount[];
  byId: Map<string, CachedAccount>;
  byName: Map<string, CachedAccount>;      // lowercase key
  byAcctNum: Map<string, CachedAccount>;   // lowercase key
  fetchedAt: number;
}

export interface CachedVendor {
  Id: string;
  DisplayName: string;
  Active?: boolean;
}

export interface VendorCache {
  items: CachedVendor[];
  byId: Map<string, CachedVendor>;
  byName: Map<string, CachedVendor>;       // lowercase key
  fetchedAt: number;
}

export interface CachedCustomer {
  Id: string;
  DisplayName: string;
  Active?: boolean;
  fetchedAt: number;   // per-entry TTL for lazy cache
}

export interface CachedItem {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  Type?: string;       // "Service", "Inventory", "NonInventory", "Group", etc.
  UnitPrice?: number;
  Active?: boolean;
  fetchedAt: number;   // per-entry TTL for lazy cache
}

export interface CachedClass {
  Id: string;
  Name: string;
  FullyQualifiedName?: string;
  Active?: boolean;
}

export interface ClassCache {
  items: CachedClass[];
  byId: Map<string, CachedClass>;
  byName: Map<string, CachedClass>;        // lowercase key on Name
  byFqName: Map<string, CachedClass>;      // lowercase key on FullyQualifiedName
  fetchedAt: number;
}

export interface CachedTaxCode {
  Id: string;
  Name: string;
  Description?: string;
  Active?: boolean;
  Taxable?: boolean;
}

export interface TaxCodeCache {
  items: CachedTaxCode[];
  byId: Map<string, CachedTaxCode>;
  byName: Map<string, CachedTaxCode>;      // lowercase key
  fetchedAt: number;
}

// Projects in QBO are Customer rows with IsProject=true and a ParentRef pointing
// at the customer the project belongs to. IsProject and ParentRef are NOT
// queryable on Customer, so the cache is built by fetching all customers and
// filtering in memory.
export interface CachedProject {
  Id: string;
  DisplayName: string;
  FullyQualifiedName?: string;
  ParentRef: { value: string; name?: string };
  Active?: boolean;
}

export interface ProjectCache {
  items: CachedProject[];
  byId: Map<string, CachedProject>;
  byName: Map<string, CachedProject>;      // lowercase key on DisplayName
  byFqName: Map<string, CachedProject>;    // lowercase key on FullyQualifiedName
  fetchedAt: number;
}
