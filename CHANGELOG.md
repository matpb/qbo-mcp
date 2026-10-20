# Changelog

## 0.4.11

- `get_transaction_detail` fills in amounts from a second ledger call when a company's books don't return the amount column for the detailed view.

## 0.4.10

- `get_transaction_detail` shows amounts in multicurrency companies, and reports an error naming the columns received instead of zeros when no amount column comes back.
- Paychecks are found whether your books say Paycheck or Paycheque (and Check or Cheque). When a transaction type matches nothing, the response lists the types present.
- Profit and loss summaries by customer, class or employee no longer drop the first column from the Columns line.

## 0.4.9

- Updating from an earlier version keeps your settings: install the new file from Settings, Extensions, Advanced settings, Install extension, then click Update.
- The Intuit Client ID and Secret are optional. When they're blank, the keys saved by your last QuickBooks sign-in are used.

## 0.4.8

- `get_profit_loss` takes `customer`, `class`, `employee` and `vendor` filters (name or ID). They combine with `summarize_by`, so one customer broken down by employee gives wages per employee for that customer. The report echoes the matched names.
- New `get_transaction_detail` tool: line-level General Ledger detail filterable by account, customer, employee, vendor, class, department and transaction type, with totals grouped by account, customer, employee, class and type. Payroll paychecks show up here with their per-line tags.
- `query_account_transactions` now always merges General Ledger rows for transaction types the entity walk can't read (Paycheck, Transfer, Bill Payment, Sales Tax Payment, ...). `include_tax_lines` keeps its tax-line behavior.
- `get_company_info` reports the installed version (`qbo-mcp version: x.y.z`), and the MCP server reports it too.
- Packaging: the bundle no longer includes previous release archives, local dev config or scripts, so it is much smaller.

## 0.4.7

- Reports API v2 migration prep: `_testing_migration` opt-in via `QBO_REPORTS_TESTING_MIGRATION`, a sturdier trial balance parser, and GL diagnostics.

## 0.4.6

- Tax-affecting edits drop `TxnTaxDetail` so QuickBooks recomputes tax.
- `query_account_transactions` gains `include_tax_lines` (GL-augmented account queries).
