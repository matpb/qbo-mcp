// Handler for list_accounts tool

import QuickBooks from "node-quickbooks";
import { getAccountCache } from "../../client/index.js";
import { toCents, formatDollars, sumCents, outputReport } from "../../utils/index.js";

export async function handleListAccounts(
  client: QuickBooks,
  args: { account_type?: string; active_only?: boolean }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account_type, active_only = true } = args;

  // Use the account cache (fetches all accounts with pagination)
  const cache = await getAccountCache(client);

  // Apply filters client-side
  let accounts = cache.items;

  if (active_only) {
    accounts = accounts.filter(a => a.Active !== false);
  }
  if (account_type) {
    accounts = accounts.filter(a => a.AccountType === account_type);
  }

  const result = { QueryResponse: { Account: accounts } };

  const accountTypes = [...new Set(accounts.map(a => a.AccountType))];
  // Use cents-based summation for accurate total
  const totalBalanceCents = sumCents(accounts.map(a => toCents(a.CurrentBalance || 0)));

  const summary = [
    `Accounts: ${accounts.length}`,
    `Types: ${accountTypes.join(", ")}`,
    `Total Balance: ${formatDollars(totalBalanceCents)}`,
    "",
    "Sample (first 10):",
    ...accounts.slice(0, 10).map(a => `  ${a.AcctNum || "N/A"} - ${a.Name} (${a.AccountType}): ${a.CurrentBalance || 0}`)
  ].join("\n");

  return outputReport("accounts", result, summary);
}
