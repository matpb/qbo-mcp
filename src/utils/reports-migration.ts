// Temporary helper for Intuit's QBO Reports API v1 → v2 cutover (deadline
// 2026-06-30). When QBO_REPORTS_TESTING_MIGRATION is truthy, every Reports
// API call gets the `_testing_migration=true` query param so the server
// returns the v2 response shape. Remove this module after the cutover ships.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function reportsMigrationEnabled(): boolean {
  const v = process.env.QBO_REPORTS_TESTING_MIGRATION;
  return v != null && TRUTHY.has(v.toLowerCase());
}

export function applyReportsMigrationFlag<T extends Record<string, string>>(options: T): T {
  if (reportsMigrationEnabled()) {
    (options as Record<string, string>)._testing_migration = "true";
  }
  return options;
}

/**
 * Diagnostic: when the migration flag is active and a Reports API call fails,
 * dump the request options + raw Intuit Fault body to stderr. We learned during
 * sandbox testing that v2 GeneralLedgerDetail returns [6000] business
 * validation errors on calls that work fine against v1 — this gives us the
 * exact Fault payload to share with Intuit / file in dev forum threads.
 *
 * Writes to stderr (not stdout) to avoid corrupting MCP JSON-RPC frames.
 */
export function logReportsMigrationFailure(
  reportType: string,
  options: Record<string, string>,
  err: unknown,
): void {
  if (!reportsMigrationEnabled()) return;
  const raw = (err as { intuitRaw?: unknown })?.intuitRaw ?? err;
  const errMsg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[reports-migration] ${reportType} failed with _testing_migration=true: ${errMsg}\n` +
    `[reports-migration] options: ${JSON.stringify(options)}\n` +
    `[reports-migration] raw intuit fault: ${safeStringify(raw)}\n`
  );
}

// AxiosError carries the Intuit Fault body at err.response.data — promote
// that to the top of the dump and drop the axios config noise (transport
// settings, headers, retry policy, transformer arrays) that crowds out the
// signal we actually want.
function safeStringify(v: unknown): string {
  try {
    const e = v as {
      message?: string;
      response?: { status?: number; statusText?: string; data?: unknown };
    };
    if (e && e.response) {
      return JSON.stringify({
        message: e.message,
        status: e.response.status,
        statusText: e.response.statusText,
        data: e.response.data,
      }, null, 2);
    }
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
