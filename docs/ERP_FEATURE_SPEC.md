# ERP Feature Spec — logic to bring into the Trade ERP

Derived from an exploration of BullionPro (`BullionPro/Aurify-BullionPro-Nodejs` backend, `BullionPro/Aurify-BullionPro` frontend). **BullionPro is read-only reference material: nothing in it is changed or copied.** This document carries the *logic* — fields, formulas, invariants, state transitions — not its UI.

Audience: an engineer who knows this codebase but has not seen BullionPro. Paths prefixed `BE/` / `FE/` are inside the BullionPro backend / frontend. Unprefixed paths are this repo (`trade ERP node/`).

## Implementation status

| Item | State |
|---|---|
| Trial Balance rewrite (natural balance, opening vs period, closing side, `isBalanced`) | **Done**, tested |
| Expense Summary join | **Done** |
| Reversal sign, log enums, stock lookup | **Done**, tested |
| §1.1 Account groups + tree validation | **Done**, tested (`/api/v1/accounting/account-groups`) |
| §1.2 Atomic account-code minting | **Done**, tested (20 concurrent; floors above manual codes) |
| §1.3 Natural balance | **Done** (`utils/accounting.js`) |
| §1.4 Account configuration + readiness + `resolveAccount` that throws | **Done**, tested (`/api/v1/accounting/account-configuration`). Posting code does **not** consume it yet — see below |
| §1.5 Atomic numbering | **Done**, tested (60 concurrent → 60 distinct, gap-free). Wired into transactions, vouchers and account vouchers |
| §1.6 Fiscal year + period lock | **Done**, tested. Gates create / approve / delete of orders and create / update / approve / delete of vouchers |
| §2.1–2.3 Costing engine, cost basis, auditable movements | **Done**, tested (BullionPro's 38,532,033.24 invariant reproduced) |
| §2.4 COGS **posted to the ledger** | **Not done.** Movements carry `cogsAmount`; orders still write no `LedgerEntry` |
| §2.5 Recost on back-dating | **Not done** |
| Per-location pools | **Not done.** One pool per item; there is no location entity |
| §3 – §9 | Not started |

Known limits of what shipped: `Stock.costValue` is seeded lazily from `currentStock × purchasePrice` on an item's first movement; the stock page's own edit path can still overwrite `currentStock` without adjusting `costValue`; `companyId` / `branchId` resolve to one default scope (`utils/tenant.js`) until real tenancy exists; the existing `forceUpdate` path on approved vouchers is gated by the period lock and, since the approval work, by `finance.deletePosted` and an approval-style judgement of the new amount whenever it changes what the voucher posted (see CLAUDE.md, "Approval limits and a second approver").

Decisions already taken:

| Decision | Choice |
|---|---|
| Phase 1 | Accounting foundation (§1) |
| Inventory valuation | Weighted average per item + location; batch/expiry as attributes, not cost layers (§2) |
| Tenancy | `companyId` + `branchId` on every **new** model, leading every compound index |

---

## 0. How to read this

Each section follows one shape: **Why → Today → Logic → Source → Shape here → Verify.**

Two framing ideas before the detail:

1. **BullionPro's biggest structural mistake is two parallel ledgers** — `Registry` (party/asset) and `Transaction` (general ledger) — written together but not derived from each other. This repo has the same split latent: `DebitLog`/`CreditLog` (party), `LedgerEntry` (GL) and `VATReport`. Pick **`LedgerEntry` as the single authoritative ledger**; make party balances, statements and VAT rows *projections* of it (or of the source documents), never independent truth.
2. **BullionPro's `MetalTransactionService` is 23,711 lines holding 26 near-duplicate `build*Entries` functions** — the Cartesian product of document types × fix/unfix. The remedy is a **declarative posting template per document type**: a list of legs, each `{account source, side rule, amount source}`, evaluated by one engine. This repo's four document types (`purchase_order`, `sales_order`, `purchase_return`, `sales_return`) are exactly the right size for that.

### Defects found in this repo while surveying (all verified in code)

| Defect | Evidence |
|---|---|
| Trial Balance always returns zero rows | `getTrialBalance` matches `{status:"approved"}` on `LedgerEntry`, which has no `status` field — `services/financial/financialService.js:1935`; schema `models/modules/financial/financialModels.js` |
| ~~Cash Flow report always returns zero rows~~ | **Retracted.** It aggregates `Voucher`, which does have a `status` field, so it works. An earlier draft of this spec wrongly grouped it with Trial Balance |
| Expense Summary joins the wrong collection | Groups by `expenseCategoryId` (ref `ExpenseCategory`) but `$lookup`s `from:"expensetypes"` and reads `categoryName`; the collection is `expensecategories` and the field is `name` — `financialService.js` |
| Reversing an approved sales document moved the customer balance the wrong way | `reversePartyBalanceAndLog` used the forward sign for `sales_order` / `sales_return`, so deleting an approved sale doubled its effect |
| Reversing any approved document threw | The reversal log wrote `type: "<type>_reversed"` and `status: "REVERSED"`, neither allowed by the `DebitLog` / `CreditLog` enums, so the whole transaction aborted |
| Stock reversal looked the item up by the wrong key | `getStockByItemId(movement.stockId)` searches `_id`, but `movement.stockId` holds the business `itemId` code |
| `expenseCategoryService` is dead on arrival | Imports `{ ExpenseCategory }` from `financialModels.js`, which does not export it (not fixed; noted) |
| Trial Balance has no natural balance | `balance = totalDebits − totalCredits` for every account type, so liabilities/equity/income all show negative — `financialService.js:~1968` |
| Item cost is dimensionally wrong | `services/stock/stockService.js:~265`: `currentValue = purchasePrice × currentStock` (a value) is added to `item.rate` (a unit price). 100 @ 10 then 50 @ 12 gives `(1000+12)/150 = 6.75`, not `10.667`. Cost drifts toward zero as stock grows |
| No COGS anywhere | No `cogs`/`wac` outside that one comment; gross margin is not computable |
| Document numbers are random | `generateTransactionNo` = prefix + `Math.random()*999`, date computed and discarded — `services/orderPurchase/transactionService.js:34-45`, against a `unique` index. Same in `FinancialService.generateVoucherNo` (per-day). ~50% collision chance by the ~37th document of a type |
| Fiscal year is April–March | `voucherSchema.pre("save")` uses `getMonth() >= 3` (`financialModels.js`). No period lock exists |

---

## 1. Accounting foundation (Phase 1)

### 1.1 Account groups with categories

**Why.** `LedgerAccount.subType` is a frozen 10-value enum the user cannot extend, and nothing says which accounts roll up where. Reports cannot be correct without a category per account.

**Today.** `LedgerAccount { accountType: asset|liability|equity|income|expense, subType (frozen enum), parentAccountId, level, openingBalance (min 0), currentBalance, allowDirectPosting, isSystemAccount }`. `accountCode` is nullable with no generator.

**Logic** (BullionPro `AccountMode`, `BE/models/modules/AccountMode.js`):

```
AccountGroup {
  companyId, branchId?            // tenancy
  name        unique per company
  prefix      /^[A-Z0-9]{1,5}$/   unique per company
  category    ASSET | LIABILITY | INCOME | EXPENSE | EQUITY
  accountCode String ≤10          unique per company
  lastAccountSeq Number|null      // high-water mark for minting
  isChild, parentGroup → AccountGroup   (self-ref; cleared when !isChild)
  status
}
```

Tree helpers to port: `validateParentGroup`, `wouldCreateCircularRelation` (walk ancestors; reject if the candidate parent is a descendant), `collectDescendantIds` (used by reports that include "everything under this group").

**Shape here.** New `models/modules/financial/accountGroupModel.js` + `services/financial/accountGroupService.js`. `LedgerAccount` gains `groupId` (required) and keeps `accountType` as a denormalised copy of `group.category` for query speed. Migration: create one group per existing `subType`, point every account at it.

**Verify.** Cannot set a group's parent to its own descendant; changing a group's category re-denormalises its accounts.

### 1.2 Atomic account-code minting

**Logic** (`AccountMode.generateNextAccountCode`, `BE/models/modules/AccountMode.js:130-189`):

1. Find the highest existing `Account.accountCode` matching `^PREFIX[0-9]{4}$`. Use an **uppercase-only** regex so the index is usable.
2. In one `findOneAndUpdate` with an aggregation-pipeline update: `$set lastAccountSeq = max(lastAccountSeq ?? 0, highestExisting) + 1`.
3. Return `PREFIX + String(next).padStart(4,"0")` → `AR0026`.

The `max(...)` floor is the clever part: it stays correct even when codes were created outside this path (imports, manual edits). Concurrent callers each get a distinct number.

**Verify.** 50 parallel mints on one group return 50 distinct codes; mint after a manual insert of `AR0100` returns `AR0101`.

### 1.3 Natural balance by category

**Logic** (`BE/services/modules/accountingReportsServices.js` — `getNaturalBalanceExpression`, `computeNaturalBalance`, `computePlAmount`):

```
LIABILITY | EQUITY | INCOME   →  credit − debit
ASSET     | EXPENSE          →  debit  − credit
```

Trial Balance pipeline (BullionPro `getTrialBalanceReportUncached`): match `{company, transactionStatus ≠ "REVERSED", entryStatus ≠ "CANCELLED", date ≤ endDate}`; group by account into **opening** (strictly before `fromDate`) and **period** debit/credit; `$lookup` the group's category; apply natural balance.

**Shape here.** Fix `getTrialBalance`: drop the invalid `status` match (filter through the `Voucher` instead: `isReversed: false` on the entry, voucher `status: "approved"`), add opening vs period split, add category and natural balance. (Cash Flow needed no fix: it reads `Voucher`, which has a `status`.) Make `LedgerAccount.openingBalance` **signed** with an explicit `openingSide: "debit"|"credit"` — today `min: 0` makes a credit opening balance unrepresentable.

**Verify.** Seed a sale + a payment; TB debits equal credits; a liability shows positive; opening ≠ period.

### 1.4 Account configuration (the posting map)

**Why.** This is the "Account configuration side" you asked for. It is the table that says *which ledger account a given business event posts to*, so posting code never hard-codes an account. This repo finds the cash account by string match: `accountCode: "CASH001"` or `accountName: "Cash"` (`services/financial/accountService.js:~489`).

**Logic** (`Organization.configuration.accountConfiguration[]`, `BE/models/core/organizationModel.js:134-205`):

```
{ configKey      /^[a-z0-9-]+$/ ≤100   (stable identity)
  displayName
  accountCategory ASSET|INCOME|EXPENSE|LIABILITY|EQUITY|null   (what may be picked)
  target         → AccountGroup | LedgerAccount                 (the tenant's choice)
  parentConfigKey "purchase-group" | "sales-group" | null
  isActive }
```

**Seeding and merging** (`BE/utils/seedAccountConfiguration.js`): the seed list is canonical for `configKey`, `parentConfigKey`, `displayName`, `accountCategory`; the tenant's chosen target is preserved and matched **by `configKey` only**, so moving a key under a new parent never loses a mapping.

**Resolution at posting time** (`BE/services/modules/TransactionService.js:1246-1310`): build `configMap[parentConfigKey || "root"][configKey] = target`, then `getAccount(key)` / `getRootAccount(key)`.

**One deliberate inversion: an unmapped key must throw.** BullionPro silently falls back to a hard-coded ObjectId (`FALLBACK_ACCOUNT_ID`, `TransactionService.js:172`), so a missing mapping posts to the wrong account with no error. Here: `throw new AppError("Account not configured: <key>", 422)`, and a readiness page lists every unmapped key.

**Food-trade key list** (replaces BullionPro's 48 bullion keys):

| parent | keys |
|---|---|
| root | `cash-account-group`, `bank-account-group`, `account-receivable-group`, `account-payable-group`, `inventory-asset-group`, `sales-income-group`, `purchase-expense-group`, `direct-income-group`, `indirect-income-group`, `direct-expense-group`, `indirect-expense-group`, `share-capital-group`, `stock-adjustment`, `pdc-receipt-group`, `pdc-issue-group` |
| `purchase-group` | `vat-purchase`, `rcm-purchase`, `discount-purchase`, `freight-purchase`, `round-off-purchase`, `purchase-variance` |
| `sales-group` | `vat-sales`, `discount-sales`, `freight-sales`, `round-off-sales`, `cogs`, `write-off-expiry`, `damage-loss` |

**Frontend behaviour worth keeping** (`FE/src/pages/AccountConfigurationPage.jsx:30-120`): keys are classified so the page shows the right picker —
- *header-only* keys (no picker): `purchase-group`, `sales-group`
- *group pickers* (choose an AccountGroup, filtered by the seed's `accountCategory`)
- *single-account pickers* (choose one LedgerAccount)
- *whole-category* keys (`share-capital-group` implies every EQUITY group; nothing stored)

Endpoints: `GET /account-configuration`, `PUT /account-configuration`.

**Bullion-specific, drop:** refinery keys, `derivative-gain/loss`, fixing/hedge groups, `pos-*`, card keys (re-add card keys only if you add card settlement).

**Verify.** Posting a sale with `vat-sales` unmapped returns 422 naming the key; re-parenting a key in the seed preserves a tenant's mapping.

### 1.5 Document numbering

**Why.** Random 3-digit suffixes collide (see §0).

**Do not copy the generator.** BullionPro's `VoucherMasterService.generateVoucherNumber` (`BE/services/modules/VoucherMasterService.js:3146-3300, 5718-5900`) computes the next number by aggregating `$max` over existing documents, outside the transaction, retries up to 20 times, and keeps a pool of deleted numbers to re-issue. It races under concurrency (the unique index merely turns the loser into an error), and number reuse means one invoice number can refer to two different documents over time.

**Take BullionPro's configuration shape** (`BE/models/modules/VoucherMaster.js`): `prefix` (/^[A-Z0-9]+$/ ≤5), `numberLength` 3–10, `includeDateInNumber` + `dateFormat`, `isAutoIncrement`, `dateValidation {allowFutureDate, allowBackDate, futureDateDays, backDateDays}`, `lockSettings`.

**Generator here:**

```
NumberSeries { companyId, branchId, series, fiscalYear, prefix, numberLength, next }
unique index { companyId, branchId, series, fiscalYear }

allocate(series, date, session):
  doc = findOneAndUpdate({companyId, branchId, series, fiscalYear}, {$inc:{next:1}},
                         {upsert:true, new:true, session})
  return `${prefix}${fiscalYearSuffix}${String(doc.next).padStart(numberLength,"0")}`
```

Atomic, gaps tolerated, **numbers never reused**, resets per fiscal year. Allocate **inside** the posting transaction. Series: `PO SO PR SR RV PV JV CV EV`.

**Verify.** 200 concurrent allocations → 200 distinct, strictly increasing numbers; a rolled-back transaction leaves a gap but never a duplicate.

### 1.6 Fiscal year and period lock

**Why.** There is no period lock, and the fiscal year is hard-coded April–March.

**Today in BullionPro:** `FinancialYearMaster {code, startDate, endDate, voucherReset, status}` and `VoucherMaster.dateValidation` exist, but **no posting service consults either** — they are declared and unenforced. This section implements what BullionPro only promised.

**Logic:**

```
FiscalYear { companyId, code, startDate, endDate (> startDate), status: open|closed, voucherReset }
unique { companyId, code }; periods must not overlap.

assertPostingAllowed(date, series, {companyId, branchId}):
  fy = fiscal year containing date                      → else 422 NO_FISCAL_YEAR
  fy.status == closed                                   → 422 PERIOD_CLOSED
  series.dateValidation: reject future/back dates beyond the configured day limits
```

Called by **every** create/update/delete/cancel path. Configurable start month, default **January** (replacing the `getMonth() >= 3` hook). `financialYear` on `Voucher`/`LedgerEntry` becomes a reference-by-code derived from the fiscal year table, not computed from the date.

**Verify.** Posting into a closed year is rejected on create, edit, delete and reversal.

---

## 2. Inventory valuation and COGS

**Why.** No COGS means no gross margin, and the stored item cost is wrong.

**Decision:** weighted average per **item + location**; batch/expiry stay attributes.

### 2.1 The costing engine (pure, no I/O)

Port `BE/utils/inventoryCosting.js` (read its header comment first) and its tests `BE/utils/wacReplay.test.js`. Five concepts kept strictly apart: **established WAC (sticky)**, **selling rate** (never enters the pool), **COGS rate**, **quantity**, **cost value**. Precision: rate 5 dp, value 2 dp, half-up with a `1e-9` nudge.

| Movement | Rule |
|---|---|
| Purchase | `qty += q; costValue += documentedCost; WAC = costValue / qty` |
| Purchase return | removes the **original purchase cost** (document cost, else `qty × rate`, else `qty × WAC`); if qty reaches 0, `costValue := 0` so no dust |
| Sale | `cogs = qty × WAC_before`; **WAC is carried forward unchanged — a sale never changes it**; the selling rate is not even a parameter |
| Sales return | restores at the **original sale's COGS rate**, else current WAC; the sales rate is never used |

`recalcAvg` is **sticky**: an empty or negative pool keeps the last good rate instead of publishing 0 (a full sale drives qty and value to 0, and `0/0` would erase the rate).

### 2.2 Cost basis is a second axis, independent of direction

The most transferable idea in BullionPro. Direction (stock up/down) is derived from document type; **cost basis** is separate:

```
purchase_order   → in,  basis purchase
purchase_return  → out, basis purchaseReturn   (priced at documented purchase cost)
sales_order      → out, basis sale             (priced at WAC)
sales_return     → in,  basis salesReturn      (priced at original COGS)
```

This repo's `getQuantityChange`/`getEventType` already handle direction; add `costBasis` beside them.

### 2.3 Auditable movements

Extend `InventoryMovement` (`models/modules/inventoryMovementModel.js`, which already has `previousStock`, `newStock`, `unitCost`, `totalValue`, `isReversed`) with:

```
rateBefore, rateAfter, costPoolAfter, poolQtyAfter, costBasis, locationId, companyId, branchId
index { companyId, branchId, stockId, locationId, date, _id }
```

BullionPro stamps `wacRateBefore/After`, `costPoolAfter`, `poolPureWeightAfter` on **every** row, so each movement is independently auditable without replaying the ledger. Copy that verbatim.

### 2.4 Posting COGS

On sales approval post **Dr `cogs` / Cr `inventory-asset-group`** at `qty × WAC_before` (via the §1.4 map). On sales return, the reverse at original COGS. On purchase, **Dr inventory / Cr payable** at the VAT-exclusive documented cost.

### 2.5 Recost on back-dating

Port the idea of `BE/services/modules/wacRecostService.js:36-54`: after any document save or delete, **replay the item+location pool in document-date order** and rewrite both the movement cost and the GL COGS pair, so the stock ledger and GL cannot disagree.
- Movements dated before `fromDate` keep their stamped cost — **closed periods are never restated**.
- A sale that overdraws the pool is costed at the last WAC and leaves a negative pool; a later purchase that covers it books a **true-up on the purchase's own date**, not the sale's.
- Replay order is `(documentDate, createdAt, _id)`.

### 2.6 Negative stock

BullionPro's polarity is confusing: `BranchMaster.negativeStockControl === true` *permits* negatives. Here, name it `allowNegativeStock` (default `false`); when false, reject with `INSUFFICIENT_STOCK`. Check against the **movement-ledger aggregate**, not the cached `currentStock` — BullionPro's costing code explicitly distrusts its `Inventory` cache after a production incident (a log at 19,670/g while the GL took 855.74/g).

### 2.7 Worked example (carry into tests)

From `BE/utils/wacReplay.test.js`: purchases of 36,000 @ 18,769,833.00 and 37,000 @ 19,762,200.24 → WAC = 38,532,033.24 / 73,000 = **527.83607**. Sale of 5,000 → COGS `2,639,180.35`; sale of 20,000 → `10,556,721.40`. The sale that empties the pool takes the remainder and absorbs the 5-dp residue (rate 527.83608, COGS 8,973,213.32). Sum of all eight sales = **38,532,033.24** exactly. Invariant asserted by the suite: **`Σ purchases − Σ COGS === pool.costValue` to the cent.**

**Skip entirely:** `worker:derivative-fifo` — despite the name it FIFO-matches metal *price-fixing lots*, not stock lots (`BE/services/modules/derivative/FifoAllocationEngine.js`, 3,917 lines). No food analogue.

**Verify.** The invariant above; 100 @ 10 then 50 @ 12 → WAC 10.66667 (regression for the current bug); back-dated purchase re-costs a later sale; a full sell-down then re-purchase restores a sensible rate.

---

## 3. Line pricing and VAT

### 3.1 What this repo already does better

`calculateItems` (`services/orderPurchase/transactionService.js:47`) computes line totals **server-side**, VAT-inclusive. BullionPro does the opposite: the client computes the money (`FE/src/components/MetalTransaction/common/ProductDetailModal.jsx:3650-4467`), the controller maps it straight through, and only tax is recomputed server-side. Keep this repo's approach.

### 3.2 Rounding discipline

**Round each money column to the company's amount precision, *then* sum.** Never sum raw values and round once. BullionPro's own comment gives the reason: the invoice total must equal the visible sum of its columns (`ProductDetailModal.jsx:~4399`).

```
lineValue   = round(qty × unitPrice)
discount    = round(lineValue × discountPct/100)  or  fixed amount
taxable     = lineValue − discount                 // a food discount REDUCES the taxable base
vat         = round(taxable × vatPct/100)
lineTotal   = taxable + vat                        // VAT-inclusive, sums of rounded columns
```

Three independent precisions: money (2), quantity (3), unit price (5), plus **per-SKU quantity precision** (eggs whole, spices 3 dp, bulk oil 2 dp) snapshotted onto the line, as BullionPro does with `pureWeightDecimal`.

**Inverted rule.** BullionPro excludes premium/discount from the VAT base (it is a per-gram differential over spot). For food, a trade discount **must** reduce the taxable base.

### 3.3 Header totals

```
subTotal      = Σ line taxable
totalVat      = Σ line vat (+ charge VAT)
charges       = Σ header charge lines
roundOff      = signed, explicit
grandTotal    = subTotal + totalVat + charges + roundOff
```

BullionPro defect to avoid: its header `totalAmount` omits `roundOff` while the ledger's party amount includes it (`FE …MetalTransactionForm.jsx:16098` vs `BE …TransactionService.js:145`), so the document and the ledger differ by the round-off. Here, `grandTotal` **includes** `roundOff` and the posted party amount equals `grandTotal`.

### 3.4 Header charges as mini-journals

BullionPro's `otherChargeSchema` (`BE/models/modules/MetalTransaction.js:502`): `{code, description, percentage, amount, debit{account…}, credit{account…}, vatDetails{vatType: vat|rcm|none, vatAmount}}`. Each charge carries its own Dr and Cr account, so freight/insurance/handling post exactly where the user said. Adopt it for freight, handling and customs.

### 3.5 Tax code master

Replace the bare `vatPercent` on lines with a `TaxCode` reference (BullionPro `VatMaster`, `BE/models/modules/VatMaster.js`):

```
TaxCode { companyId, name, ratePercent, effectiveDate, rateHistory[{date, ratePercent}],
          kind: standard | zero_rated | exempt | out_of_scope,
          inputAccount, outputAccount, rcmInputAccount?, rcmOutputAccount?, isActive, isDefault }
```

UAE 5% standard; zero-rated (exports, certain staples) and exempt are distinct for the FTA return. Keep the existing `Stock` VAT field reading as a fallback — and note the stock create forms currently save **no** VAT field, so every item falls back to 5%.

### 3.6 Single source of truth for header tax

BullionPro `MetalTransactionService.stampHeaderVatTotals` (`:2041-2135`) **re-runs** the per-line calculation on create, update and backfill, so the three paths cannot disagree, and stamps the policy applied to each line (`vat.appliedOption`) for reporting. The invariant it maintains:

```
totalVatAmount = totalPartyVatAmount + totalRCM
```

RCM (reverse charge) is **self-assessed and never touches the party balance**: Dr input VAT / Cr output VAT for the same amount.

Policy snapshot: BullionPro copies the tax policy onto the document (`voucherConfiguration`) so a later master change never restates a posted document. Do the same.

Option-resolution precedence worth keeping (in order): branch VAT switch off → none; party exempt → none; unregistered supplier on purchase → none; voucher "calculate VAT" off → none; item excluded → none; then the registered/unregistered column. Regression test to carry across: a charge component counted twice in the VAT base.

VAT posting sides (`getVatPostingSides`): purchase → Dr VAT-input / Cr party; sale → Dr party / Cr VAT-output; returns flip both. There is **no second party VAT leg** — the party amount already includes VAT.

**Verify.** `grandTotal` equals the sum of displayed columns; `totalVat = partyVat + rcm`; a discounted line's VAT is computed on the discounted base; posted party amount equals `grandTotal`.

---

## 4. Document lifecycle and posting integrity

### 4.1 This repo is ahead — keep it

`processTransaction` with `validateAction` / `isProcessed`, `DRAFT → APPROVED | REJECTED | CANCELLED`, and a paired reversal for every mutation (`processTransactionStock`/`reverseTransactionStock`, `updatePartyBalanceAndLog`/`reversePartyBalanceAndLog`). BullionPro's `status` is decorative: nothing is gated on `confirmed`/`completed`, posting happens unconditionally at create, and delete is a hard delete with a full replay.

### 4.2 Add

- `postedAt`, `postedBy`; posting is an explicit, **idempotent** step.
- Cancellation as a **reversing document**, not delete-and-repost. BullionPro's only real reversal rows are for cheques/PDC.
- Idempotency key on postings: `sourceType` + `sourceId` with a unique partial index (BullionPro's `Entry.sourceType/sourceId` does this; its `Registry.transactionId` is a free-form string that sometimes holds an ObjectId — do not copy that).
- Policy snapshot on the document (§3.6).

### 4.3 Post-commit assertions (cheap insurance)

BullionPro asserts after commit that the writes actually landed: `assertRegistryForMetalTransaction` (≥1 party row), `assertInventoryLogsForTransaction` (one movement per stock line; else `INVENTORY_LOG_LINE_MISSING`), `assertMetalTransactionPersistence` (document readable). Add: every stock line produced a movement; every posting produced balanced `LedgerEntry` rows; the document re-reads.

### 4.4 Session helper — unify and add retry

`services/orderPurchase/transactionService.js` `withTransactionSession` has **no retry**; `financialService.withTransactionRetry` does. Use one helper, shaped like BullionPro `EntryService.js:45-59, 1746-1798`:

```js
const MAX_RETRIES = 4, BASE_MS = 40;
const retryable = (e) => e?.code === 112 || e?.codeName === "WriteConflict"
  || e?.errorLabels?.includes("TransientTransactionError");
const delay = (n) => BASE_MS * 2 ** (n - 1) + Math.floor(Math.random() * BASE_MS);
// a FRESH session per attempt; non-retryable errors rethrow immediately
```

### 4.5 Re-entrancy rule

`withTransaction` may re-invoke its callback, so **the callback must be pure with respect to its inputs**. Anything the callback deletes off the payload (acknowledgement flags etc.) must be captured *before* entering (BullionPro `MetalTransactionService.js:4376-4384`).

### 4.6 What stays outside the transaction

Fire-and-forget after commit: activity logging, socket emits, file deletes. Their failure must never fail the request.

**Verify.** Posting the same document twice yields one set of ledger rows; a forced write-conflict retries and succeeds; a payload flag is still present on the second callback invocation.

---

## 5. Returns linked to their original

**Why.** Today `Transaction.linkedRef` is a free string and nothing validates anything: a return can exceed the original in quantity and value. BullionPro has **the same hole** (no `originalTransactionId` anywhere in its models) — so this is designed fresh, not ported.

**One pattern worth taking** — from BullionPro POS (`BE/services/modules/POSSaleService.js` `reconcilePOSSaleReturnFlags`, ~`:863`): re-read **all** active returns for the parent and recompute the returned set, rather than incrementing a counter. Deleting a return automatically un-returns the line. **Derive, don't increment.**

**Shape here:**

```
header:  returnOf { transactionId, transactionNo }       (required on *_return, validated to exist, same party)
line:    returnOfLineId, returnedQty
rule:    for each original line: Σ returnedQty over all active returns ≤ originalQty
         Σ return value ≤ original value
rule:    returnWindowDays (per company/customer class) — reject returns outside the window
carry:   batchNumber + expiryDate on the return line (perishables)
derive:  original line's returnedQty and the header's isFullyReturned recomputed from active returns
```

Cost basis follows §2.2: a sales return restores at the **original line's COGS rate**, which this link makes available (BullionPro can only read it if the client volunteers it).

**Verify.** Over-return rejected; two partial returns summing past the original rejected on the second; cancelling a return frees its quantity; sales-return stock is valued at original COGS.

---

## 6. Party ledger: allocation, ageing, credit control

### 6.1 Allocation — this repo is ahead

`Voucher.linkedInvoices[] { invoiceId, allocatedAmount, previousBalance, newBalance }` plus `onAccountAmount` for unallocated advances. BullionPro has **no bill-wise allocation at all**: receipts are strictly on-account, `invoiceReference` is free text, and a repo-wide search for `settleInvoice|billwise|knockOff` finds nothing. Do not look to BullionPro for this.

### 6.2 Ageing — absent from both, design fresh

BullionPro stores `creditDaysAmt` / `creditDaysMtl` and **never reads them**; no ageing report exists. Here:

```
dueDate  = documentDate + termDays(paymentTerms)    // enum already stored: Net 30/45/60, COD, Prepaid
open     = amount − paid                            // DebitLog / CreditLog already carry paid + status
bucket   = current | 1–30 | 31–60 | 61–90 | 90+ days past due, as of a chosen date
```

Store `dueDate` on the log row at creation. Endpoint `GET /reports/ageing?type=receivable|payable&asOf=`.

### 6.3 Credit control

`Customer.creditLimit` exists and is **never enforced**. Port BullionPro's gate architecture (`BE/src/modules/risk/services/{limitGate,amountGate}.js`, `engine/limitChecks.js`):

```
checkPartyCredit (sales only):
  currentOwed   = max(0, receivableBalance)
  projectedOwed = max(0, receivableBalance + orderValue)
  breach iff projectedOwed > creditLimit AND the order increases exposure
```

**Universal rule, correct and transferable: a transaction that reduces exposure is never blocked** (returns and payments bypass).

Enforcement mode per operation, configurable per company:
- `allow` → pass
- `warn` → HTTP **409** `RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED` with `details.risk.acknowledgementField = "riskAck_limit_party_credit"`; client re-posts with that field `true`; audit event recorded; then pass
- `block` → HTTP **403** `RISK_LIMIT_BLOCKED`, audited

**Each operation owns its own acknowledgement field**, so acknowledging one warning never silently acknowledges another the user has not seen. Capture the flag *before* the transactional callback (§4.5). Audit-write failures never fail the booking.

Also add (BullionPro lacks them): overdue-invoice blocking (any invoice > N days past due), a `blocked` party flag, and per-document approval thresholds.

Dealer ticket/daily limits (`checkDealer`) transfer as per-salesperson order-value limits if wanted; `firm NOP` and metal limits do not.

### 6.4 Statement of account

Opening / Transactions / Closing, with **running balance computed server-side**. BullionPro computes it in the browser across three parallel columns (`FE/src/components/Reports/AccountStatement/accountStatementTableUtils.js`, 1,233 lines), which is how its statement and ledger can disagree. Take two ideas: opening = sum of everything strictly before `fromDate`; and an index shaped for the query — equality keys first, date range last (`{companyId, branchId, party, isActive, type, transactionDate}`).

**Effective document date:** resolve the business date from the *source document* (`voucherDate`), not from the ledger row's own timestamp (`BE/services/modules/RegistryService.js:70-134`).

**Verify.** Statement closing equals the ledger balance; ageing buckets sum to the open balance; an order that would exceed the limit returns 409 then passes when acknowledged; a block-mode company gets 403; a return is never blocked.

---

## 7. e-Invoicing (UAE PINT AE / Peppol)

Backs the `soon: true` entry already live in `trade erp/src/config/navigation.js` (Reports → e-Invoicing, `/e-invoicing`).

### 7.0 The most important finding: there is no engine to port

BullionPro does **not** implement UBL/PINT building, signing, Peppol delivery or FTA reporting. It is a thin client of a separate external service ("Aigentrix", `VITE_E_INVOICE_API_BASE_URL=https://api.einvoice.bullionpro.net/api/v1`). Both repos were searched.

| Where | What lives there |
|---|---|
| **BullionPro frontend** (`FE/src/pages/EInvoicePage.jsx`, 3,547 lines) | Builds the invoice payload (`buildAigentrixPayload`, ~L1070-1137), validates it (~L1180-1290), and calls the external service **directly from the browser** with plain `axios` |
| **BullionPro backend** | Stores the result on the voucher (`eInvoiceEntryId`, `eInvoiceSubmitted`, `eInvoiceTaxStatus`), holds party/branch data, and runs the party readiness check |
| **External service (not in either repo)** | UBL/PINT mapping, signing/hashing, the Peppol access-point hop, retry, status polling/webhooks, the status state machine, the dashboard aggregation, inbound receipt |

Absent entirely: certificates and keys, sandbox/mock mode, an idempotency key, an ERP-side webhook receiver, a retry queue, a scheduler. Submission is **manual, per row, with a confirm dialog** — never automatic on posting.

**Consequence for this repo.** The part that can be ported is the *ERP-side half*: readiness rules, payload build, tax-category resolution, line splitting, cent reconciliation and pre-submit validation. The *engine half* needs a decision before building (§7.7).

**Security: do not copy the call pattern.** The browser holds the engine's HTTP contract, sends **no Authorization header**, and the seller `apiKey` is returned to the browser to prefill a masked form. Do this server-side, with the key encrypted at rest and never sent to the client.

### 7.1 Configuration

**ERP-side (real, in Mongo):**

| Field | Where | Meaning |
|---|---|---|
| `trnNumber` | `BranchMaster` (`BE/models/modules/BranchMaster.js`) | Seller VAT TRN — also the key to the engine's seller config |
| `eInvoiceDueCount` | `BranchMaster` (Number, null, min 1, integer) | Days after voucher date by which an invoice should be submitted. **Display only** — no enforcement or alert. Validated: null/"" → null, else integer ≥ 1 else 400 `VALIDATION_ERROR` |
| seller identity | branch + organization | `registeredName`, `orgAddress.{streetArea, city, emirate, country, countryCode, poBox}`; org fallback `vatRegistrationNumber` |
| party VAT block | `AccountType.vatGstDetails` | `vatStatus` `REGISTERED\|UNREGISTERED\|EXEMPTED`, `vatNumber` (≤50), `participantId` (≤100), `tradeLicenseNumber`, `isVerified`, `designatedZone` |
| party address | `addresses[]` | `streetAddress`, `city`, `country`, `countryCode`, `isPrimary` |
| per-voucher state | `MetalTransaction`, `DebitCreditNote` | `eInvoiceStatus` `open\|edited\|deleted` (ERP edit-lifecycle flag, **never changed automatically**), `eInvoiceTaxStatus` (copied from engine), `eInvoiceEntryId` (engine's id), `eInvoiceSubmitted` Boolean |

`zatcaQrStatus` (`DRAFT\|PROCESSING\|SUBMITTED\|FAILED`) is an orphan **Saudi** ZATCA flag, unrelated to the UAE flow. Do not copy.

**Engine-side seller config** (external): per `sellerVatTrn` + `organizationId`, only three values — `apiKey`, `companyId` (digits), `participantId` matching `/^\d+:\d+$/` (scheme:id; the UAE example is `0235:1051610267`, `0235` being the UAE TIN scheme). Edited with `GET/POST/PATCH {BASE}/seller-config`. Not present anywhere: environment/sandbox switch, per-tenant endpoint, certificates, an enable/disable switch.

**Shape here.** `EInvoiceSettings { companyId, branchId, sellerTrn, participantId, aspProvider, aspCompanyId, apiKeyEncrypted, environment: sandbox|production, enabled, dueDays }` — adding the environment switch and enable flag BullionPro lacks.

### 7.2 Readiness checklist

Validates **parties**, not documents, and answers "which of my customers can I invoice electronically yet?". Rule set (`BE/utils/eInvoicePartyReadiness.js`; also a Mongo aggregation copy in `BE/services/modules/AccountTypeService.js:156-310`; a third copy in `EInvoiceReadinessPage.jsx` — **keep one**):

*Population assessed:* active parties in the receivable/payable groups (resolved through the §1.4 config keys), `vatStatus == "REGISTERED"`, branch in `[branch, null]`.

*Is a buyer required to have e-invoice details?* True only when `vatStatus == REGISTERED` **and** the primary address is UAE (`countryCode == "AE"` or country in `{UAE, UNITED ARAB EMIRATES}`) **or** has no country data (legacy rows are deliberately flagged invalid, not ready). Unregistered, exempt and foreign parties are always "valid". Primary address = the one with `isPrimary`, else the first.

*Checklist — exact labels, each trimmed non-empty:*

| Label | Source |
|---|---|
| Party Name | `customerName` |
| Address Line 1 | `address.streetAddress` |
| Country | `address.countryCode` (the code, not the name) |
| City | `address.city` |
| VAT Number | `vatGstDetails.vatNumber` |
| Participant ID | `vatGstDetails.participantId` |

Result `readiness: "valid"` when none missing, else `"invalid"` with `missingFields[]`. Response `{summary:{total,valid,invalid}, valid:{records,pagination}, invalid:{…}}`; sorted `customerName, accountCode, _id`; page size clamped 1-100; query `maxTimeMS` 8000.

*Fix endpoint:* `PATCH /account-type/:id/e-invoice-details` — `vatStatus` must be a valid enum (400 `INVALID_VAT_STATUS`), `participantId` must match `/^\d+(?::\d+)?$/` (400 `INVALID_PARTICIPANT_ID`), 404 `EINVOICE_PARTY_NOT_FOUND`; writes name, primary address and the VAT block; activity-logged.

**Extend for this repo** (add to the party checklist): TRN format (UAE TRN is 15 digits), and for the *seller*: TRN present, participant ID set, ASP configured, tax codes mapped (§3.5), `vat-sales` / `vat-purchase` config keys mapped (§1.4). Readiness page = party checklist + seller checklist + unmapped-key list.

### 7.3 Pre-submit validation (the most reusable piece)

Runs in the BullionPro browser (`EInvoicePage.jsx`); move it server-side.

**Required invoice fields** (missing if null, NaN, empty array, `""` or `"-"`): `organizationId`, `documentId`, `issueDate`, `invoiceTransactionType`, `documentCurrencyCode`, `sellerName`, `sellerVatTrn`, `sellerRegisteredName`, `sellerAddressLine1`, `sellerCity`, `sellerCountryCode`, `lineExtensionTotal`, `taxAmount`, `totalIncludingTax`, `payableAmount`, `lines`.

**Buyer fields**, required when `buyerVatRegistered === true` (party REGISTERED **and** country `AE`): `buyerName`, `buyerVatTrn`, `buyerAddressLine1`, `buyerCity`, `buyerCountryCode`, `customerParticipantId`.

**Per line**, all present and `quantity > 0`: `lineNumber`, `itemName`, `quantity`, `quantityUom`, `unitPrice`, `lineNetAmount`, `taxCategory`, `taxRatePercent`, `lineTaxAmount`, `inclVatamount`.

**Arithmetic rules** — with the exact messages:

| Rule | Message |
|---|---|
| tax category ∈ `{S, AE, Z, O}` | "E-Invoice tax category could not be resolved from the ERP VAT treatment." |
| category `S` requires rate > 0 | "Standard-rated E-Invoice line must have a VAT rate greater than 0." |
| net ≥ 0, tax ≥ 0 | "Line net amount cannot be negative." / "Line tax amount cannot be negative." |
| `priceBaseQty > 0` | "Price base quantity must be greater than 0." |
| `lineNet == round2(qty × unitPrice / priceBaseQty)` | "Line net amount must equal quantity multiplied by unit price divided by price base quantity." |
| `inclVat == net + tax` | "Amount including VAT must equal line net amount plus line tax amount." |
| header = Σ lines | "Line Extension Total must equal the sum of line net amounts." / "Tax Amount must equal the sum of line tax amounts." / "Total Including Tax must equal Line Extension Total plus Tax Amount." |
| final decimal-exact reconcile | "Sale E-Invoice totals do not reconcile. Please review the transaction and try again." |

**Seller config check:** missing `apiKey`/`companyId`/`participantId` → block with those named.

### 7.4 Payload build and tax categories

**Header mapping** (BullionPro `buildAigentrixPayload`):

| Payload field | Source |
|---|---|
| `documentId` | voucher number |
| `issueDate` | voucher date, `YYYY-MM-DD` — **use Asia/Dubai, not a UTC slice**, or documents before 04:00 are backdated (the bug fixed earlier in `src/utils/format.js`) |
| `invoiceTransactionType` | `sale` or `creditNote` |
| `documentCurrencyCode` | transaction currency, default `AED` |
| `seller*` / `buyer*` | `Name`, `VatTrn`, `RegisteredName`, `AddressLine1`, `City`, `CountryCode` — branch/org and party respectively |
| `buyerVatRegistered` | party REGISTERED **and** country `AE` |
| `customerParticipantId` | `party.vatGstDetails.participantId` |
| totals | `lineExtensionTotal`, `taxAmount`, `totalIncludingTax`, `payableAmount` |
| `invoiceRef` | for credit notes, the original invoice number(s) |

Country names normalise to codes (UAE / U.A.E / United Arab Emirates → `AE`; a 2-char value is uppercased).

**Tax category resolution** (`resolveEInvoiceTaxCategory` / `getTaxProfile`):

| Category | Condition |
|---|---|
| `S` standard | rate > 0 (also inferred when none stored and rate > 0) |
| `AE` reverse charge | rate 0 with reverse-charge treatment |
| `Z` zero-rated | explicit |
| `O` out of scope | no tax applied |
| *(blank)* | **unresolved stays blank so validation stops the invoice** instead of silently emitting S/0 — keep this |

Maps cleanly onto the §3.5 `TaxCode.kind` (`standard`→S, `zero_rated`→Z, `out_of_scope`→O, reverse charge→AE). Add exempt → `E` if you issue exempt supplies.

**Line mapping.** BullionPro splits one stock row into up to three e-invoice lines (product, premium/discount service line, making-charge service line). For food: one **goods line** (`itemTypeGoodsServices: "G"`, `sellerItemId` = SKU) plus, where charges exist, **service lines** (`"S"`, quantity 1, UOM `EA`) for freight/handling, with discounts expressed as a negative line or as a document-level allowance. Unit-price rule worth keeping: `unitPrice = round2(amount/qty)`; **if `qty × unitPrice` does not reproduce the amount to the cent, set `unitPrice = lineNet` and `priceBaseQty = qty`** so the UBL equation still balances.

### 7.5 Cent reconciliation (`FE/src/utils/eInvoiceMoney.js`)

Decimal arithmetic (`decimal.js`, precision 40, `ROUND_HALF_UP`) with a **largest-remainder allocation**: compute exact net and tax per line, round the *document* totals, then distribute the cent residue across lines so that lines sum **exactly** to the rounded totals; tax per line is `net × rate / 100`. Port as a pure function with a property test: for random line sets, `Σ line net == lineExtensionTotal` and `Σ line tax == taxAmount` exactly.

Reconcile this with §3.2: this repo rounds each column then sums, so lines already sum to totals — the allocation is only needed when the engine demands tax computed at the *document* level per category (PINT AE VAT breakdown by category and rate).

### 7.6 Outbound flow, status and inbound

**Flow in BullionPro (manual):** load voucher → enrich party → load seller context → build payload → validate → check seller config → confirm → `POST {BASE}/invoices/submit` (must return `providerResponse.entryId`) → `GET {BASE}/invoices/{entryId}` for status → `PATCH` the ERP voucher with `{eInvoiceSubmitted:true, providerResponse:{entryId, taxStatus}, eInvoiceEntryId}`.

**Defects to design out:**
- **No atomicity between the engine accepting and the ERP recording.** If the ERP `PATCH` fails after the engine accepted, the engine holds an invoice the ERP does not know about, and a resend creates a duplicate. There is no idempotency key; the only natural key is `documentId`.
- **No server-side guard** against re-submitting an already-submitted voucher (`MetalTransactionService.markEInvoiceSubmitted`, `:19104`).
- Status is fetched per row on every list load (a fan-out poll) and **never persisted** — `eInvoiceServiceStatus` is UI-only.

**Shape here:**

```
EInvoiceSubmission {
  companyId, branchId, sourceType, sourceId          // unique partial index = idempotency
  documentNo, payloadHash, payload (snapshot)
  attempt, status, taxStatus, providerEntryId, providerResponse
  submittedAt, acknowledgedAt, lastError, nextRetryAt
}
```

Submit on a server-side job with a retry/backoff, store the payload snapshot (an issued tax invoice must be reproducible), and write status from a webhook or poll — never from the browser.

**Status vocabulary the BullionPro UI recognises** (engine-owned; no transition table exists in either repo): green `ACKNOWLEDGED`, `REPORTING_CONFIRMED`, `SUBMITTED`, `SUCCESS`; red `FAILED`, `REJECTED`, `VALIDATION_FAILED`, `ERROR`; grey `OPEN`, `PENDING`, `PROCESSING`. `taxStatus` is a *second* status for the tax-authority leg. An inferred (unverified) flow: `SUBMITTED → ACKNOWLEDGED` (Peppol delivery) `→ REPORTING_CONFIRMED` (tax leg), with `FAILED / REJECTED / VALIDATION_FAILED` terminal. Define your own machine explicitly:

```
DRAFT → VALIDATED → QUEUED → SUBMITTED → ACKNOWLEDGED → REPORTED
                      ↘ FAILED (retryable) ↘ REJECTED (terminal, needs correction)
corrections after submission = credit note + new invoice, never an edit
```

**Eligible documents:** sales invoices and credit notes. (BullionPro also sends derivative-gain debit notes and has a dormant purchase self-billing path — neither applies.) Debit notes (non-goods) belong here if issued.

**Inbound (BullionPro: read-only).** Received by the external engine as Peppol receiver; the ERP polls `GET {BASE}/invoices/inbound?vatTrn&organizationId&startDate&endDate&searchString&page&perPage`. A detail modal shows header, parties, amounts, lines and payments. **Not implemented:** accept/reject, dispute, message-level response, PO matching, vendor lookup by TRN or participant ID, auto-creating a purchase. The only link is a regex on the sender's own voucher-number convention (`/^(SM\d+)…/`) and a "create purchase invoice" button that pre-fills just the supplier invoice number — meaningful only between two BullionPro tenants. **Do not copy.** Design fresh: match the sender by `participantId` / TRN to a `Vendor`, match to an open `purchase_order` by reference and amount, and offer accept/reject.

**Dashboard** (aggregation entirely in the engine): `summary {totalInvoices, submittedAttempts, successfulInvoices, outbound{count,amount}, inbound{count,amount}, totalAmount, totalVat, successRate}`, `statusBreakdown {acknowledged, failed, validationFailed, totalInbound, failedInbound, totalOutbound, failedOutbound}`, `topCustomer`, `topCurrency`, `recentActivity[]`. Compute these from `EInvoiceSubmission` rows here.

### 7.7 Decision needed before building the engine half

The ERP-side half (readiness, validation, payload, reconciliation, submission log, status) is fully specified above. The **engine half** is not in BullionPro and is a build-or-buy choice:

| Option | What you take on |
|---|---|
| Connect an accredited service provider's API | Map to their payload; they sign, deliver and report. Fastest. Choose one with a sandbox and idempotency keys |
| Another client's engine | **Not an option.** It belongs to a different client's project; this ERP never sends to it |
| Build a PINT AE builder + Peppol access-point integration | UBL generation, signing, 5-corner reporting to the FTA, certificates, webhooks — a project of its own |

Timeline inputs already established: UAE pilot phase from July 2026, mandatory from January 2027 for businesses at or above AED 50M turnover.

**Verify.** A customer missing a participant ID appears in the invalid list with exactly that label; a payload with `qty × unitPrice ≠ lineNet` is rejected with the exact message; random line sets reconcile to the cent; resubmitting the same document returns the existing submission instead of creating a second; an unresolved tax category blocks the invoice.

---

## 8. Masters, permissions, audit

### 8.1 Master data

BullionPro has ~60 master pages. **Generic and reusable:** account groups (`AccountMode`), classification, VAT, currency, document type, cost centre, department, designation, location, salesman, other charges, bank and card masters, country, financial year, voucher master. **Bullion-specific, drop:** karat, commodity, metal rate types, divisions-as-metal, making charges, premium/discount, daily karat, consumables, refinery, derivatives, fixing, hedging, LP.

The Trade ERP's master layer is thin (categories, UOM, vendors, customers, stock, staff, expense types, transactors). Add, in this order of value:

| Master | Why | BullionPro source |
|---|---|---|
| Company / branch settings | Currency, amount/quantity precision, number format, date format, round-off limit, TRN, VAT-registered flag, opening date, default cash/bank | `BranchMaster` (`BE/models/modules/BranchMaster.js`) |
| Tax code | §3.5 | `VatMaster` |
| Location / warehouse | Needed for per-location costing (§2) | `LocationMaster` |
| Cost centre / department | Reporting dimensions | `CostCenterMaster`, `DepartmentMaster` |
| Salesman | Per-salesperson limits and commission reporting | `SalesMan` |
| Other charges | §3.4 | `OtherCharges` |
| Bank account master | Receipts/payments, PDC | `BankAccountMaster` |
| Document type | Party documents with expiry (trade licence, TRN certificate) | `DocumentType` |
| Classification | Party grouping | `Classification` |

**`BranchMaster` fields worth keeping** (generic): `code` (≤10, `/^[A-Z0-9]+$/`), `name`, `companyName`, address block (`emirate`, `countryCode`, `poBox`), `trnNumber`, `vatRegistered`, `vatControl`, trade licence number/issue/expiry, `currency`, `amountDecimal` (0-6, default 2), `numberFormat` (`international|indian`), `dateFormat`, `roundOffLimit`, `branchOpeningDate`, `defaultBankId`/`defaultCashId`, `enableLocation`, `enableCostCenter`, `includeOtherCharges`, `printCopyTypes`, soft delete (`isDeleted/deletedAt/deletedBy`). **Drop:** `metalDecimal`, `purityDecimal`, `goldOzConversion`, margin/spread, hedging, fixing, LP, refinery, e-wallet, POS gold fields. Keep BullionPro's rule that a structural setting (hedging there) **locks once documents exist**; the equivalent here is the costing method and base currency.

Two practical notes: BullionPro has *two* models for the same branch concept (`BranchMaster`, `BranchConfiguration`) — keep one. And its classification code is `first 2 letters + random 3-digit number` retried 100 times (`BE/models/modules/Classification.js`) — use §1.5 series instead.

**Organization-level template + per-tenant copy.** Definitions live in a catalogue (`OrganizationVat`, `OrganizationCharges`, `OrganizationVoucherDefinition`, …) and are cloned into a tenant on provisioning (`BE/services/core/organizationCloneService.js`), with a `definitionId` stamp so re-seeding cannot duplicate. Worth adopting for tax codes, number series and the §1.4 key list when you onboard a second client.

### 8.2 Financial year (what exists in BullionPro, for §1.6)

`FinancialYear { code (uppercase ≤20), startDate, endDate, voucherReset, status, branchId, OrganizationId }`. Rules to keep: end after start (compared at UTC midnight, also on update hooks); **active years may not overlap** in the same org/branch → 409 `DATE_OVERLAP` "Financial year overlaps with existing year: <code>"; unique `{org, branch, code}`; helpers `getFinancialYearForDate`, `getCurrentFinancialYear`. `Organization.configuration.financialYear { label, startMonth 1-12 }` makes the start month configurable. **Caveats:** `voucherReset` is a stored flag nothing reads; there are **no fiscal periods (months), no lock dates, no year-end close** anywhere; the date helpers ignore `branchId`. §1.6 supplies all three.

### 8.3 Permissions

BullionPro's model is **route-based**, not feature-flag based:

```
Permission  { moduleName (unique), routes[{ action, permissionKey, route, method GET|POST|PUT|PATCH|DELETE }] }
ModuleTree  { name, root (parent), pageRoute, order, icon, permissions[] }       // the menu hierarchy
Role        { roleName, roleCode (unique, uppercase), status, permissions[{ moduleName, routes[] }] }   // per organization
User        { username, password (select:false), email, ..., branches[{ branch, roles[≥1] }] }          // roles per BRANCH
```

At login the JWT/session carries the **expanded** role→permission→route list, built once and cached on the session.

**Enforcement** (`BE/middleware/apiAccessMiddleware.js`, `BE/server.js:596`): `guard(router)` = `requireApiAccess()` then the router. `requireApiAccess` builds, once per session, an access index (a set of `METHOD::normalised-route`, a set of lowercased actions/permission keys, a set of route ids, and bucketed `:param` templates) and grants if the permission id, the action, or method + route matches. Notable details: the mount prefix `/api/v1` is stripped before comparing; **a concrete path segment only matches a `:param` template segment if it contains a digit** (`looksLikeParamValue`), so a literal word segment is never swallowed by `:id`; denial is 403 `{code:"API_ACCESS_DENIED", details:{method,route,action,permissionId}}`; it sets `req.apiAccess.{has, hasAction}` for in-controller checks; `requireAnyApiAccess([...])` grants on any rule; Super Admin can be allowed to bypass.

**Trade ERP today:** a flat `role` string on `Admin` checked against `roles: [...]` arrays on navigation tabs (client-side) plus `requirePermission`/`requireRole` middleware. Per the CLAUDE.md, several admin routes are currently unauthenticated and the frontend has no route guard.

**What to take:** the *shape* — a permission catalogue keyed by `METHOD + route` with a stable `permissionKey` for client gating, roles assembled from it, roles assigned per branch. **What to improve:** BullionPro's catalogue is a 4,796-line generated file (`BE/scripts/data/permissions.generated.js`) — instead derive it from the route table at boot so a new route cannot be forgotten. **Gotcha to avoid:** routes not mounted through `guard` are open to any authenticated principal; make guarding the default and unguarded the exception.

### 8.4 Audit and activity trail

`ErpActivityLog` (`BE/models/modules/ErpActivityLog.js`): one row per mutating action —

```
datetime, model (≤120), operationType CREATE|UPDATE|DELETE|PATCH|EXPORT|PRINT|IMPORT|CANCEL|RESTORE,
data (Mixed: the document snapshot), organizationId, userId, branchId, username,
documentId, serialNumber (the Nth write of this document; 1 = create), documentNumber,
macId, deviceName, ipAddress, browser
unique { organizationId, documentId, serialNumber }
```

Written **fire-and-forget** from controllers (`void log…({req, document, operationType})`) so a logging failure never fails the request; the frontend also records print and export events.

**Gaps to close:** no before/after diff (a snapshot only), no immutability or hash chain, and no log of **configuration changes** — account mapping and e-invoice settings are exactly what an auditor asks about. Add `before`/`after` for `UPDATE`, and log §1.4 mapping changes, §1.6 period closes and §7.1 settings changes. Include `PRINT`/`EXPORT` for tax invoices.

Other trails worth having: a login/session log, per-party account log, and the inventory movement ledger (already present here).

---

## 9. What BullionPro has no answer for

Do not expect coverage here — these are designed from scratch.

| Gap | Note |
|---|---|
| **Batch / lot as a first-class entity** | This repo puts `batchNumber` / `expiryDate` on the **item master** (`models/modules/stockModel.js`), which is structurally wrong: a batch is a property of a *receipt lot*, not of the product. Needs `StockBatch { itemId, locationId, batchNumber, expiryDate, qtyOnHand, receivedCost }` and FEFO allocation on issue. Under the chosen costing, batches carry quantity and expiry but **not** separate cost layers |
| Expiry write-off | Needs the `write-off-expiry` config key (§1.4) and a stock adjustment that posts Dr write-off / Cr inventory at WAC |
| Catch-weight items | Sold by case, priced by kg: needs two quantities per line (units and weight) and a price basis |
| Minimum remaining shelf life on dispatch | Per-customer rule checked at allocation |
| Temperature zones / storage class | Item attribute plus location attribute, checked on transfer |
| Bill-wise settlement | Not in BullionPro — this repo already has the right shape (§6.1) |
| Ageing | Absent from both (§6.2) |

The nearest BullionPro analogue to a quality variance is `purityDifference` (assay variance: bill the actual, carry stock at standard, book the difference). For food (moisture, yield, weighbridge variance) take **one** variance account (`purchase-variance`) and **one** posting shape — not BullionPro's two fix/unfix modes.

## 10. Traps — do not copy

1. **Stored `runningBalance` on ledger rows.** In BullionPro it is computed only in `pre("save")`, bypassed by every `insertMany` hot path, and read by no reader. `LedgerEntry.runningBalance` here has the same smell: derive balances, never store them on the ledger row.
2. **A magic fallback account** (`FALLBACK_ACCOUNT_ID`, `TransactionService.js:172`). Unmapped keys must fail (§1.4).
3. **A free-form `transactionId` string that sometimes holds an ObjectId.** Use `sourceType` + `sourceId` and a unique partial index for idempotency.
4. **Delete-and-repost instead of reversal.** BullionPro edits by deleting ledger rows and rebuilding them; the audit trail then shows nothing happened.
5. **Exact float equality for debit = credit.** BullionPro's `JournalService.validateLines` compares `Σdebit === Σcredit`. This repo already uses a 0.01 epsilon — keep it, and let a `ROUND OFF` leg absorb the residue (BullionPro's `balanceLedgerEntries`, `MAX_LEDGER_IMBALANCE = 0.01`, `TransactionService.js:845-928`).
6. **Count-based voucher codes.** `JournalService.generateVoucherCode()` is `countDocuments() + 1`: collides under concurrency and ignores tenancy. Use §1.5.
7. **Representation drift.** `purity` is 0..1 in the service and 0..100 in the schema; a client sending `91.6` passes one and fails the other. Pick one representation per field, validate once.
8. **Declared-but-unenforced controls.** `FinancialYearMaster`, `VoucherMaster.dateValidation`, `lockSettings`, `creditDays*`, `status` — all stored, none consulted. Every control in this spec names the call site that enforces it.
9. **Hard-coded precision.** BullionPro loads branch `metalDecimal`/`amountDecimal` and then hard-codes 2 two lines later (`TransactionService.js:1197-1201`), and never resolves `totalSummary.amountDecimal` on metal vouchers. Resolve precision once, server-side, and pass it down.
10. **Dead code kept beside live code** (`createCompleteRegistryEntries`, a declarative validator never mounted on the routes, a dead `AccountMaster` stub, three overlapping chart-of-accounts families). Prefer one model per concept.
11. **Validation split across four layers** with the declarative one unused (`BE/utils/validators/MetalTransactionValidation.js` is imported by the routes and never applied to `POST /`). This repo's `express-validator` rule arrays in `validations/` are already better — keep applying them as route middleware.
12. **Client-computed money** (§3.1).

## 11. Sequencing

Dependency order. Each phase names its prerequisite.

| Phase | Scope | Needs | Why this position |
|---|---|---|---|
| **0** | Fix the four broken reports (§0 table): Trial Balance filter, Cash Flow, Expense Summary join, natural balance. Fix `stockService` weighted-average arithmetic | — | Independent, small, and visibly wrong today |
| **1** | §1 Accounting foundation: account groups, code minting, posting map, `NumberSeries`, fiscal year + period lock, `companyId`/`branchId` on new models | 0 | Everything else posts through it |
| **2** | §2 Costing engine + COGS posting + movement audit fields + recost | 1 (needs `cogs`, `inventory-asset-group`) | Biggest reporting payoff: real gross margin |
| **3** | §3 Line discount, header charges, `TaxCode` master, round-off, single-source header tax | 1 | Changes the document shape that §4–§5 rely on |
| **4** | §4 Lifecycle hardening: idempotent posting, reversing cancellation, post-commit assertions, unified retry | 1, 2, 3 | Needs the posting engine to be real before hardening it |
| **5** | §5 Linked returns | 2, 4 | Needs per-line COGS to restore at original cost |
| **6** | §6 Ageing, credit-limit gate, server-side statement | 1, 3 | Uses `dueDate` from terms and the per-company enforcement mode |
| **7** | §7 e-Invoicing | 3 (needs `TaxCode`, TRN, document snapshot), 4 | Needs a stable, immutable posted-document shape |
| **8** | §8 Masters, permissions catalogue, audit log | 1 | Can start earlier in parallel for the audit log |
| **9** | §9 Batch/lot, FEFO, expiry | 2 | Food-specific; no source to port |

**SQL portability.** The models are specified to survive the planned move off Mongo: every cross-document invariant (`Σ returnedQty ≤ originalQty`, `Σ purchases − Σ COGS = pool.costValue`, unique series allocation) is stated as a rule over rows, not as a Mongoose feature; the one `findOneAndUpdate($inc)` counter maps to `UPDATE … RETURNING` or a sequence; the aggregation-pipeline update in §1.2 maps to a single `UPDATE` with `GREATEST()`. Put the costing engine and the posting-template evaluator behind plain functions with no Mongoose imports, as BullionPro's `inventoryCosting.js` and `partyMarginMath.js` are.

## 12. Appendix

### 12.1 Field mapping

| BullionPro | Trade ERP | Note |
|---|---|---|
| `MetalTransaction.transactionType` | `Transaction.type` | One collection, type discriminator — already matches |
| `partyCode` → `Account` | `partyId` + `partyTypeRef` | Keep this repo's polymorphic ref |
| `voucherNumber` | `transactionNo` | Replace generator (§1.5) |
| `stockItems[]` | `items[]` | |
| `itemTotal.baseAmount` | `qty × price` | |
| `itemTotal.makingChargesTotal` | *(none)* | Optional per-line processing/packing charge with `%`, per-unit, per-kg bases |
| `itemTotal.premiumTotal` (signed) | `discount` (add at line level) | Food discount reduces taxable base (§3.2) |
| `itemTotal.vatAmount` / `itemTotalAmount` | `vatAmount` / `lineTotal` | |
| `otherCharges[]` | *(none)* | §3.4 |
| `totalSummary` | *(flat fields)* | Add `subTotal`, `totalVat`, `charges`, `roundOff`, `grandTotal` |
| `vat{}` header + `voucherConfiguration` snapshot | *(none)* | §3.6 |
| `InventoryLog` | `InventoryMovement` | Add `rateBefore/After`, `costPoolAfter`, `costBasis` |
| `Registry` (party) | `DebitLog` / `CreditLog` | Make a projection of `LedgerEntry` |
| `Transaction` (GL) | `LedgerEntry` | The authoritative ledger |
| `AccountMode` | `AccountGroup` *(new)* | §1.1 |
| `Account` (party = ledger account) | `Customer`/`Vendor` + `LedgerAccount` | This repo keeps parties separate and lazily creates per-party ledger accounts (`getOrCreateCustomerAccount`) — keep it |
| `accountConfiguration[]` | `CompanySettings.accountConfiguration[]` *(new)* | §1.4 |
| `VoucherMaster` | `NumberSeries` *(new)* | §1.5 |
| `FinancialYearMaster` | `FiscalYear` *(new, enforced)* | §1.6 |
| `VatMaster` | `TaxCode` *(new)* | §3.5 |
| `DebitCreditNote` | *(none; `Voucher` + `creditNoteIssued` flag)* | Financial adjustment note, not a goods return — separate from §5 |
| `Entry` (cash/bank/cheque/card) | `Voucher` (receipt/payment/contra) | |
| `JournalVoucher` | `Voucher.voucherType = "journal"` | |
| `ChequeRegister` + PDC state machine | *(none)* | See below |
| `CardReconciliation` | *(none)* | See below |

### 12.2 Finance features in BullionPro that were reviewed and are optional here

- **Cheque / PDC lifecycle** (`BE/models/modules/ChequeRegister.js`, `BE/services/modules/EntryService.js:2517-3400`): states `pending → hold → resubmit → cleared | cancelled | bounced`, one register row per `{entryId, cashItemIndex}` with `statusHistory[]` snapshots, a dedicated PDC voucher series, real reversal rows, and a maturity cron. Worth adding if UAE customers pay by post-dated cheque (they commonly do); `pdc-receipt-group` / `pdc-issue-group` are already in the §1.4 key list. "Bank reconciliation" in BullionPro **is this cheque worklist** — it does not import or match bank statements.
- **Card settlement reconciliation** (`BE/models/modules/CardReconciliation.js`): card receipts (pending amount = gross − charge − VAT) are applied against one bank settlement; identity `Σ applied = amount credited to bank + commission + VAT`; over-application rejected beyond a 0.01 tolerance; per-line status `pending | partial | reconciled | variance`. Add only if you take card payments.
- **Debit/credit notes** (`BE/models/modules/DebitCreditNote.js`): `DRAFT | POSTED | CANCELLED` — the only real status machine in BullionPro. Debit note: party Dr / detail account Cr; credit note the reverse; VAT split onto its own control account. Useful for non-goods adjustments (rebates, shortage claims, freight recharges). Keep distinct from goods returns (§5).
- **Journal voucher** rules worth keeping: at least 2 lines; each line exactly one of debit/credit > 0; balanced within an epsilon (this repo already has this).
- **Opening balances** (`AccountTypeService.syncOpeningRegistryEntries`, `BE/services/modules/AccountTypeService.js:5872-6097`): written as dated ledger rows (`transactionType: "Opening"`) rather than a stored field, then included in statements via an `isOpening` flag.

### 12.3 Reading order for the BullionPro files

1. `BE/utils/inventoryCosting.js` and `BE/utils/wacReplay.test.js` — pure, tested, start here (§2)
2. `BE/services/modules/wacRecostService.js:1-120` (§2.5)
3. `BE/models/modules/AccountMode.js` (§1.1–1.2)
4. `BE/models/core/organizationModel.js:134-205` and `BE/utils/seedAccountConfiguration.js` (§1.4)
5. `FE/src/pages/AccountConfigurationPage.jsx:30-120` (§1.4 UI classification)
6. `BE/services/modules/MetalTransactionService.js:2041-2135` (`stampHeaderVatTotals`) and `BE/tests/headerVatTotals.test.js` (§3.6)
7. `BE/src/modules/risk/engine/limitChecks.js`, `services/limitGate.js`, `services/amountGate.js` (§6.3)
8. `FE/docs/STOCK_BALANCE_LOGIC.md`, `FE/docs/VAT_CALCULATION_LOGIC.md`, `FE/docs/VAT_POSTING_LOGIC.md` — already written up
9. `BE/services/modules/EntryService.js:45-59, 1746-1798` (retry shape, §4.4)

**Skip:** `FifoAllocationEngine.js`, `TransactionFixingService.js`, `fixingLpHedgeService.js`, `LPHedgingOrderService.js`, `DerivativeGainLossService.js`, `amPmRate*`, `Refinary/`, the `build*Fix/Unfix*Entries` family (`MetalTransactionService.js:8139-16400`, ~8,200 lines of price-fixing).
