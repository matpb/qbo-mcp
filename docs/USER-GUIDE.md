# QuickBooks + Claude — User Guide

This guide explains what you can do with Claude when it's connected to your QuickBooks account.

Claude can read your accounting data, pull reports, look up transactions, and create or edit entries — all through natural conversation. You don't need to learn any special commands. Just ask questions in plain English.

---

## What You Can Ask

### Reports

Ask Claude for any of these reports and it will pull them directly from QuickBooks:

- **"What's our profit and loss this quarter?"**
- **"Show me the P&L for January through March, broken down by month"**
- **"What does our balance sheet look like?"**
- **"Give me the balance sheet broken down by department"**
- **"Pull the trial balance for March"**

You can specify date ranges, departments/locations, and whether you want accrual or cash basis.

### Account Inquiries

- **"What's the balance on accounts receivable?"**
- **"Show me all transactions hitting the Checking account this month"**
- **"What's the activity on the Fuel account in Q1?"**
- **"How much did we spend on Legal & Professional Fees this year?"**
- **"List all our bank accounts and their balances"**

### Looking Up Records

- **"Show me invoice 1037"**
- **"Pull up the details on bill #147"**
- **"What's the status of the invoice for Sonnenschein Family Store?"**
- **"Look up customer Amy's Bird Sanctuary"**
- **"Find all unpaid invoices"**
- **"Show me all bills from Books by Bessie"**
- **"List all our vendors"**

### Custom Queries

You can ask Claude to search for almost anything in QuickBooks:

- **"Find all invoices from March"**
- **"Which customers have outstanding balances?"**
- **"Show me all sales receipts over $500"**
- **"List all active customers in California"**

---

## What You Can Create

Claude can create the following in QuickBooks. Everything starts as a **draft preview** — Claude will show you exactly what it's about to create and ask you to confirm before anything is saved.

| What | Example |
|------|---------|
| **Invoices** | "Create an invoice for Cool Cars for 3 hours of Design at $75/hour" |
| **Bills** | "Record a bill from Ellis Equipment Rental for $112 to Equipment Rental" |
| **Expenses** | "Log a $55 gas expense on the Mastercard from Chin's Gas and Oil" |
| **Journal entries** | "Make a journal entry to reclassify $200 from Office Expenses to Advertising" |
| **Deposits** | "Record a $500 deposit to Checking from Services income" |
| **Sales receipts** | "Create a sales receipt for Cool Cars — 1 Pest Control at $35" |
| **Vendor credits** | "Record a $10 credit from Books by Bessie against Office Expenses" |
| **Customers** | "Add a new customer: Riverside Landscaping, email riverside@example.com" |

### Name Resolution

You don't need to know account numbers or IDs. Just use names:

- Say **"Mastercard"** not "account ID 41"
- Say **"Books by Bessie"** not "vendor ID 30"
- Say **"Office Expenses"** not "account 15"

Claude will look up the correct IDs automatically.

---

## What You Can Edit

You can modify any existing record by referencing it:

- **"Change the memo on invoice 1038 to 'Revised estimate'"**
- **"Update the due date on bill 147 to April 30"**
- **"Add a line to journal entry 146 for $50 debit to Advertising"**
- **"Change the customer email for Amy's Bird Sanctuary to newemail@example.com"**
- **"Deactivate customer Test Customer LLC"**

Edits also preview before saving, just like creates.

---

## What You CANNOT Do

These are limitations of the QuickBooks API or this particular integration:

| Action | Why |
|--------|-----|
| **Payroll** | QuickBooks does not expose payroll data through its API |
| **Bank feeds / bank connections** | Cannot import bank transactions or connect bank accounts |
| **Reconciliation** | Cannot mark transactions as reconciled |
| **Receive payments against invoices** | No payment recording tool (invoices can be created, but payments against them cannot) |
| **Estimates / Purchase Orders** | Not implemented in this integration |
| **Attach documents** | Cannot upload receipts, PDFs, or images to transactions |
| **Tax filings / tax forms** | Not accessible through the API |
| **Multi-department expense lines** | QuickBooks only allows one department per expense — if a charge covers multiple locations, Claude can create a journal entry to reclassify after the fact |
| **Budgets** | Cannot read or set budgets |
| **Recurring transactions** | Cannot create or manage scheduled/recurring transactions |
| **Classes** | Class tracking is not supported by this integration |
| **Time tracking** | Not available through this integration |
| **Bill payments** | Cannot record payments made to vendors |
| **Transfers between accounts** | Not directly supported (use a journal entry instead) |

---

## Safety Features

- **Draft mode**: Every create and edit shows a preview first. Nothing changes in QuickBooks until you explicitly confirm.
- **No accidental deletes**: Deletion requires a two-step confirmation process.
- **Read-only by default**: Just asking questions never modifies your data.

---

## Tips

1. **Be specific with dates.** "This quarter" works, but "January 1 to March 31, 2026" is unambiguous.
2. **Ask follow-up questions.** If a P&L number looks off, ask Claude to drill into that account's transactions.
3. **Use names, not numbers.** Claude resolves account and vendor names automatically.
4. **Review drafts carefully.** Always read the preview before confirming a create or edit.
5. **Ask "what can you do?"** if you're unsure — Claude knows its own capabilities and will tell you honestly if something isn't possible.
