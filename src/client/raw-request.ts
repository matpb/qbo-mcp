// Raw QBO REST API helper. Reuses the access token managed by node-quickbooks
// and lets us hit endpoints the wrapper doesn't expose (notably /project, which
// is required to create QBO Projects — Customer.IsProject is read-only on the
// Customer endpoint, so a real project must be POSTed to /v3/company/{id}/project).

import QuickBooks from "node-quickbooks";

const QBO_SANDBOX_BASE = "https://sandbox-quickbooks.api.intuit.com";
const QBO_PRODUCTION_BASE = "https://quickbooks.api.intuit.com";

type QBClientInternals = {
  token: string;
  realmId: string;
  useSandbox: boolean;
};

export async function qboRawRequest<T>(
  client: QuickBooks,
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathTemplate: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<T> {
  const c = client as unknown as QBClientInternals;
  const base = c.useSandbox ? QBO_SANDBOX_BASE : QBO_PRODUCTION_BASE;
  const path = pathTemplate.replace("{realmId}", c.realmId);
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const url = `${base}${path}${qs}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.token}`,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`QBO ${method} ${pathTemplate} ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}
