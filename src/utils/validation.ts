// Strict-key validation for edit tool handlers. MCP clients don't always
// enforce JSON Schema additionalProperties:false, so handlers double-check
// that every submitted key is recognized — prevents silent no-op edits
// where e.g. `customer_name` on a bill line would quietly do nothing.

export function assertKnownKeys(
  obj: Record<string, unknown> | undefined,
  allowed: readonly string[],
  context: string
): void {
  if (!obj) return;
  const allowedSet = new Set<string>(allowed);
  const unknown = Object.keys(obj).filter(k => !allowedSet.has(k));
  if (unknown.length > 0) {
    const allowedList = [...allowed].sort().join(', ');
    throw new Error(
      `Unknown ${context} parameter${unknown.length > 1 ? 's' : ''}: ${unknown.map(k => `"${k}"`).join(', ')}. ` +
      `Allowed: ${allowedList}.`
    );
  }
}

// Distinct sentinel so handlers can tell "field was omitted" (keep current)
// from "user wants to clear" (send null / empty to QBO via full update).
export const CLEAR = Symbol('clear');
export type ClearableRef = { value: string; name: string } | typeof CLEAR | undefined;
