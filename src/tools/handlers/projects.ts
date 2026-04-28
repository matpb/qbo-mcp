// Handlers for project tools. QBO projects are Customer rows with
// IsProject=true; the field is not queryable, so we fetch every customer and
// filter in-memory. Callers need this to find a project's parent customer
// before moving lines between customers (a project's parent must equal the
// line's customer or QBO silently rejects the change).
//
// Project CREATION is intentionally not exposed: QBO's public REST API silently
// drops IsProject on both Customer.create and Customer.update at every
// minorversion (probed 65, 73, 75 — all returned IsProject=false). There is no
// /project endpoint either. Projects can only be created via the QBO web UI.
// Empirically confirmed against the sandbox on 2026-04-28.

import QuickBooks from "node-quickbooks";
import { getProjectCache } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";

export async function handleListProjects(
  client: QuickBooks,
  args: { active_only?: boolean; parent_customer?: string } = {}
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { active_only = true, parent_customer } = args;

  const cache = await getProjectCache(client);
  let projects = cache.items;

  if (active_only) {
    projects = projects.filter((p) => p.Active !== false);
  }

  if (parent_customer) {
    const lower = parent_customer.toLowerCase();
    projects = projects.filter(
      (p) =>
        p.ParentRef.value === parent_customer ||
        (p.ParentRef.name?.toLowerCase() === lower)
    );
  }

  // Sort by parent customer, then project display name for readability.
  projects = [...projects].sort((a, b) => {
    const ap = (a.ParentRef.name || a.ParentRef.value).toLowerCase();
    const bp = (b.ParentRef.name || b.ParentRef.value).toLowerCase();
    if (ap !== bp) return ap < bp ? -1 : 1;
    return a.DisplayName.toLowerCase() < b.DisplayName.toLowerCase() ? -1 : 1;
  });

  const lines: string[] = [
    `Projects (${projects.length}${active_only ? ", active only" : ""}${parent_customer ? `, parent="${parent_customer}"` : ""})`,
    "=".repeat(60),
  ];

  if (projects.length === 0) {
    lines.push("(none)");
  } else {
    let lastParent = "";
    for (const p of projects) {
      const parentLabel = p.ParentRef.name || p.ParentRef.value;
      if (parentLabel !== lastParent) {
        lines.push("");
        lines.push(`Parent: ${parentLabel} (id: ${p.ParentRef.value})`);
        lastParent = parentLabel;
      }
      const inactive = p.Active === false ? " [INACTIVE]" : "";
      const fq = p.FullyQualifiedName && p.FullyQualifiedName !== p.DisplayName
        ? ` (${p.FullyQualifiedName})`
        : "";
      lines.push(`  ${p.Id}: ${p.DisplayName}${fq}${inactive}`);
    }
  }

  return outputReport(`projects-list`, projects, lines.join("\n"));
}
