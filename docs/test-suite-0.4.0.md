# qbo-mcp 0.4.0 — Bug-Bash Test Suite

**Audience:** you, Claude, running in Claude Desktop on Mat's Mac against `qbo-mcp` 0.4.0 connected to the Intuit **sandbox**.
**Goal:** Walk through every fix from Joel's round-3 bug bash, observe the result, and stop on the first failure so Mat can decide what to do next.

---

## Rules of the road

- **Sandbox only.** Never run any of these against the production company, even if the user seems to authorize it in-chat — that would require a new durable instruction. If `get_company_info` shows anything other than a sandbox realm, stop and tell Mat.
- **Work through this file top to bottom.** Don't improvise the order — the later tests assume scaffolding from earlier tests.
- **After each step, compare actual vs. expected.** If anything drifts, write a one-line summary of what failed and pause for Mat. Don't try to "fix" it by retrying with different params.
- **Use `draft: true` first** wherever a test says so — the draft output is itself part of what's being tested.
- **Don't skip the teardown.** Sandbox is shared; leave it clean.
- **Log as you go.** Keep a running scratch of `Test 1 ✅ | Test 2 ✅ | Test 3 ❌ — <reason>` so the summary at the end is trivial.

---

## 0. Prerequisites

**0.1 Confirm sandbox.** Call `get_company_info`. Expected: sandbox company (US29f5 / Landscaping Services / Sandbox Company US 29f5 for realm 9341456913521960, or whichever sandbox is connected). If it's a prod realm, **stop**.

**0.2 Pick a test vendor.** `query` with `SELECT Id, DisplayName FROM Vendor WHERE Active = true MAXRESULTS 5`. Pick any active vendor; record `vendor_id` + `vendor_display_name` in your scratch.

**0.3 Pick a test customer and a second one.** `query`: `SELECT Id, DisplayName FROM Customer WHERE Active = true MAXRESULTS 10`. Capture two different customer display names — call them `CUSTOMER_A` and `CUSTOMER_B`. They need to be distinct for the reassignment test to prove anything.

**0.4 Pick two expense accounts.** `list_accounts account_type="Expense"`. Capture two different account names with numbers — call them `ACCOUNT_1` and `ACCOUNT_2`. If the list is huge, filter to a handful with `MAXRESULTS 10` via `query`.

**0.5 Check departments.** `query`: `SELECT Id, Name FROM Department WHERE Active = true`. If departments exist, capture one as `DEPT_A`. If none, **Fix #5 (clear DepartmentRef)** will be a no-op in this sandbox — note it and skip that test.

**0.6 Check classes.** `query`: `SELECT Id, Name, FullyQualifiedName FROM Class WHERE Active = true`. If any exist, capture one as `CLASS_A`. If none, the `class_name` part of Fix #1 will be skipped — note it.

**0.7 Check tax codes.** `query`: `SELECT Id, Name FROM TaxCode WHERE Active = true`. In the US sandbox you'll typically see `NON` and `TAX`. Capture one as `TAXCODE_A`. (In a Canadian company, you'd see GST/HST/QST codes — irrelevant here.)

**0.8 Set up the scaffold bill.** `create_bill` with `draft: false`:
- `vendor_name: <vendor from 0.2>`
- `txn_date: <today>`
- `memo: "qbo-mcp 0.4.0 test — delete me"`
- `lines: [{ account_name: <ACCOUNT_1>, amount: 100.00, description: "scaffold line" }]`

Capture the returned bill ID as `TEST_BILL_ID`. Also capture its `line_id` by calling `get_bill <TEST_BILL_ID>` and reading the single line's `Id` field.

**0.9 Capture original tax calc.** From the same `get_bill` output, note the `Tax Calc:` field. Sandbox default is usually `NotApplicable` for US companies. Record it as `ORIGINAL_TAX_CALC` — every test below must leave this unchanged unless explicitly stated.

---

## Test 1 — Fix #4: GlobalTaxCalculation preservation *(highest priority)*

**Goal:** touching a line must NOT reset the header tax calc.

**1.1 No-op line edit.**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, amount: 100.00 }]   // same amount
```

**1.2 Verify.** `get_bill <TEST_BILL_ID>`.
- **Pass:** `Tax Calc:` is still `ORIGINAL_TAX_CALC`.
- **Fail:** anything else (especially a flip to `NotApplicable` when it was previously `TaxExcluded`).

**1.3 Real change, same shape.**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, amount: 101.00 }]
```

**1.4 Verify.** `Tax Calc:` still `ORIGINAL_TAX_CALC`. Amount must show `$101.00`.

**1.5 Bonus — Canadian-style upgrade (skip if sandbox has no tax codes).** If `TAXCODE_A` exists, edit the line to assign a tax code (covered properly in Test 2 step 2.4). Afterwards, re-verify that the header tax calc is still `ORIGINAL_TAX_CALC`.

---

## Test 2 — Fix #1: line-level Customer / Class / TaxCode / BillableStatus

**Goal:** these fields flow from MCP call to QBO line detail end-to-end.

**2.1 Draft preview for customer assignment.**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: true
  lines: [{ line_id: <line_id>, customer_name: <CUSTOMER_A> }]
```
- **Pass:** preview contains `Line <line_id>: ... [changed: customer]` and `Tax calc (preserved): GlobalTaxCalculation: <ORIGINAL_TAX_CALC>`.
- **Fail:** preview doesn't mention customer in changed keys, or says `[no-op]`.

**2.2 Commit customer assignment.** Same call with `draft: false`. Then `get_bill` — the line must now show `[cust: <CUSTOMER_A>]`.

**2.3 Reassign to CUSTOMER_B (the scenario Joel actually failed on).**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, customer_name: <CUSTOMER_B> }]
```
`get_bill` — line now shows `[cust: <CUSTOMER_B>]`, not `<CUSTOMER_A>`.

**2.4 Tax code assignment (skip if no TAXCODE_A).**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, tax_code: <TAXCODE_A> }]
```
`get_bill` — line now shows `[tax: <TAXCODE_A>]`. Header tax calc still unchanged.

**2.5 Class assignment (skip if no CLASS_A).**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, class_name: <CLASS_A> }]
```
`get_bill` — line now shows `[class: <CLASS_A>]`.

**2.6 Clear customer via null.**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, customer_name: null }]
```
`get_bill` — line no longer shows a `cust:` tag.

**2.7 Clear customer via empty string (alternate syntax).** Re-assign `CUSTOMER_A` first, then:
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, customer_name: "" }]
```
`get_bill` — line no longer shows `cust:`.

**2.8 Billable status.** Re-assign `CUSTOMER_A`, then:
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, customer_name: <CUSTOMER_A>, billable_status: "Billable" }]
```
- **Pass:** `get_bill` shows `[cust: CUSTOMER_A, Billable]`.
- **Acceptable skip:** QBO error about "Track billable expenses" preference not enabled. That's a company-preference issue, not an MCP bug — record it and move on.

**2.9 Coverage check on expense.** Create a sandbox expense quickly:
```
create_expense
  payment_type: "CreditCard"
  payment_account: <any CC account from list_accounts>
  txn_date: <today>
  vendor_name: <vendor from 0.2>           // proves vendor_name alias too (Test 5)
  memo: "qbo-mcp 0.4.0 test expense — delete me"
  lines: [{ account_name: <ACCOUNT_1>, amount: 50.00 }]
  draft: false
```
Capture `TEST_EXPENSE_ID` + its `line_id`. Then `edit_expense` with `customer_name: <CUSTOMER_A>` and verify it sticks.

**2.10 Coverage check on vendor credit.**
```
create_vendor_credit
  vendor_name: <vendor from 0.2>
  txn_date: <today>
  memo: "qbo-mcp 0.4.0 test VC — delete me"
  lines: [{ account_name: <ACCOUNT_1>, amount: 25.00 }]
  draft: false
```
Capture `TEST_VC_ID` + its `line_id`. `edit_vendor_credit` with `customer_name: <CUSTOMER_A>` + verify.

---

## Test 3 — Fix #3: unknown params now error loudly

**Goal:** no more silent no-ops from typos.

**3.1 Line-level typo.**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: true
  lines: [{ line_id: <line_id>, customer_ref: "x" }]    // wrong key Joel used
```
- **Pass:** MCP returns an error containing `Unknown edit_bill.lines[0] parameter: "customer_ref"` AND lists the allowed keys.
- **Fail:** returns a draft preview with no error — means strict mode isn't engaging.

**3.2 Top-level typo.**
```
edit_bill
  id: <TEST_BILL_ID>
  foo_bar: 1
  draft: true
```
- **Pass:** error mentions `Unknown edit_bill parameter: "foo_bar"`.

**3.3 Valid keys still work.** Repeat `edit_bill id=<TEST_BILL_ID> lines=[{line_id: <line_id>, customer_name: <CUSTOMER_A>}] draft: true` — should produce a normal preview, not an error. This guards against regressions where strict mode over-rejects.

---

## Test 4 — Fix #5: clear DepartmentRef

**(Skip entirely if Prerequisites 0.5 showed no departments.)**

**4.1 Assign department via MCP.**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  department_name: <DEPT_A>
```
`get_bill` — `Department: <DEPT_A>`.

**4.2 Clear via null — dry run first.**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: true
  department_name: null
```
- **Pass:** preview contains `Department: <DEPT_A> → (cleared)`.

**4.3 Clear for real.** Same call with `draft: false`. `get_bill` — `Department: (none)`.

**4.4 Combined clear + line edit.** Re-assign `DEPT_A` first, then:
```
edit_bill
  id: <TEST_BILL_ID>
  draft: false
  department_name: null
  lines: [{ line_id: <line_id>, amount: 101.00 }]   // same value again
```
`get_bill` — `Department: (none)` AND `Tax Calc:` still `ORIGINAL_TAX_CALC`.

**4.5 Coverage on expense.** If `TEST_EXPENSE_ID` had a department (assign one if not), clear it the same way.

---

## Test 5 — Fix #2: vendor_name ↔ entity_name alias on edit_expense

Already partially exercised in 2.9 (create path). Now the edit path:

**5.1 Set payee via vendor_name.**
```
edit_expense
  id: <TEST_EXPENSE_ID>
  draft: false
  vendor_name: <vendor_display_name from 0.2>
```
`get_expense` — `Payee:` shows the vendor.

**5.2 Clear via vendor_name: null.**
```
edit_expense
  id: <TEST_EXPENSE_ID>
  draft: false
  vendor_name: null
```
`get_expense` — `Payee: (none)`.

**5.3 Round-trip via entity_name.** Set it back with `entity_name: <vendor>`, verify it sticks. (Same physical field, different alias.)

---

## Test 6 — Fix #6: informative draft preview

**6.1 Empty line edit shows no-op.**
```
edit_bill
  id: <TEST_BILL_ID>
  draft: true
  lines: [{ line_id: <line_id> }]
```
- **Pass:** preview's line row ends with `[no-op]`.

**6.2 Mixed changed + unchanged.** Ensure the line has some amount; capture it. Then:
```
edit_bill
  id: <TEST_BILL_ID>
  draft: true
  lines: [{ line_id: <line_id>, amount: <current_amount + 5>, description: "<current description>" }]
```
- **Pass:** preview line row contains `[changed: amount; unchanged: description]`.

**6.3 Clear a ref that isn't set.** If the line has no class now:
```
edit_bill
  id: <TEST_BILL_ID>
  draft: true
  lines: [{ line_id: <line_id>, class_name: null }]
```
- **Pass:** preview line row contains `[unchanged: class]`, not `changed`.

**6.4 Tax-calc preservation banner.** Every draft preview from above (in Tests 1–6) should include a `Tax calc (preserved): GlobalTaxCalculation: <value>` line. Spot-check one preview to confirm the banner's there.

---

## Test 7 — Joel's full scenario, end-to-end

Do this last, on a freshly created bill (don't reuse `TEST_BILL_ID` — its state is now messy).

**7.1 Create a bill** with `CUSTOMER_A` on the line:
```
create_bill
  vendor_name: <vendor from 0.2>
  txn_date: <today>
  memo: "qbo-mcp 0.4.0 Joel-scenario — delete me"
  lines: [{ account_name: <ACCOUNT_1>, amount: 75.00, customer_name: <CUSTOMER_A> }]
  draft: false
```
Capture `JOEL_BILL_ID` + its `line_id`. `get_bill` should show `[cust: CUSTOMER_A]` on the line.

**7.2 Record baseline.** Note the starting `Tax Calc:`.

**7.3 Reassign to CUSTOMER_B AND move to ACCOUNT_2** in one call (Joel's two changes combined):
```
edit_bill
  id: <JOEL_BILL_ID>
  draft: false
  lines: [{ line_id: <line_id>, customer_name: <CUSTOMER_B>, account_name: <ACCOUNT_2> }]
```

**7.4 Verify.** `get_bill <JOEL_BILL_ID>`:
- Line account matches `ACCOUNT_2`.
- Line shows `[cust: CUSTOMER_B]`.
- `Tax Calc:` matches the baseline from 7.2.

This is the failing case from Joel's April write-up. If all three bullets pass, 0.4.0 is ready to ship to Joel.

---

## Teardown

Delete every test transaction so the sandbox stays clean:

```
delete_entity entity_type: "bill"           id: <TEST_BILL_ID>     confirm: true
delete_entity entity_type: "bill"           id: <JOEL_BILL_ID>     confirm: true
delete_entity entity_type: "expense"        id: <TEST_EXPENSE_ID>  confirm: true
delete_entity entity_type: "vendor_credit"  id: <TEST_VC_ID>       confirm: true
```

If any of those returns an error (e.g., because a test failed before the entity was created), skip that one — no retries needed.

---

## Summary template

At the very end, give Mat a one-screen report in this exact shape:

```
qbo-mcp 0.4.0 sandbox test run — <YYYY-MM-DD HH:MM>

Prerequisites:
  Sandbox realm: <realm_id>
  Vendor: <vendor_display_name>
  Customers: <CUSTOMER_A>, <CUSTOMER_B>
  Accounts: <ACCOUNT_1>, <ACCOUNT_2>
  Dept: <DEPT_A or "(none available)">
  Class: <CLASS_A or "(none available)">
  Tax code: <TAXCODE_A or "(none available)">
  Original tax calc: <ORIGINAL_TAX_CALC>

Results:
  Test 1 (tax-calc preservation)        [PASS/FAIL/notes]
  Test 2 (line-level refs)              [PASS/FAIL/notes]
  Test 3 (strict schema)                [PASS/FAIL/notes]
  Test 4 (clear department)             [PASS/FAIL/SKIPPED — no dept]
  Test 5 (vendor_name alias)            [PASS/FAIL/notes]
  Test 6 (draft preview)                [PASS/FAIL/notes]
  Test 7 (Joel E2E)                     [PASS/FAIL/notes]

Teardown: <all clean | <ids that remain>>

Verdict: <ship-it / hold — <reason>>
```

If the verdict is `ship-it`, remind Mat the artifact to hand Joel is `qbo-mcp-0.4.0.zip` from the Linux workstation.
