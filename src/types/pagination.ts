// Pagination types for QuickBooks queries

export interface PaginationParams {
  maxResults: number;
  startPosition: number | null; // null = auto-paginate
  baseCriteria: string; // Criteria after FROM Entity, without pagination clauses
}

export interface PaginatedQueryResult {
  entities: Array<{ Id?: string; [key: string]: unknown }>;
  entityKey: string;
  apiCalls: number;
  truncated: boolean;
  startPositionSpecified: boolean;
  hasMore: boolean;        // true if more data exists beyond returned results
  returnedCount: number;   // number of records returned
  requestedLimit: number;  // MAXRESULTS that was applied
}
