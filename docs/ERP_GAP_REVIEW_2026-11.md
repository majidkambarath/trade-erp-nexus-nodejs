# The ERP against the market: gaps, and what to build next (21 Nov 2026, v4.1.1.0)

Written for the owner and for whoever builds next. Same idea as `CRM_MARKET_GAP_ANALYSIS.md`, for the whole
product. Every status below was judged from the CODE (models, services, routes, screens), not from the docs:
the docs lag the code (a whole HR workspace exists that `CLAUDE.md` never mentions, and help guide 8.3 still
lists as "planned" things that are built). Web facts (law, deadlines, competitors) were read on 21 Nov 2026
from secondary sources and are marked **verify**: confirm each against the official page before quoting it to
a client.

## 1. The short version

- **The core is strong.** Documents post fully; weighted-average costing; IFRS statements proven on live books;
  month and year close with checks; bank and card reconciliation with proof; UAE e-invoicing through an
  accredited provider (inbound too); India GST by place of supply; multi-tenant SaaS that sells modules;
  roles per branch; two-factor sign-in.
- **Ahead of the market** in van sales (offline, promotions, settlement), garage with insurance claims,
  production with job work and a process board, a CRM that moves itself from the documents, HR with labour
  cost flowing into job cards, and an AI assistant that reads the books and prepares documents.
- **The gaps cluster in five places:**
  1. *Getting paid*: no payment links, no reminders, no customer portal.
  2. *Going live*: no spreadsheet import for customers, vendors, items or opening balances.
  3. *Country compliance*: UAE corporate tax, FTA audit file, WPS salary file; India TDS, e-way bill, IRN,
     GSTR-2B.
  4. *Inventory depth*: one stock figure per item, no stock-take sheets, barcode scanning or landed cost.
  5. *Accounting completeness*: no fixed assets or depreciation, no accrual schedules, FX revaluation not posted.
- **Fix first:** two confirmed data leaks (section 2) and three risks only the owner can close (backups, jobs
  that stop when the free server sleeps, monitoring).

## 2. Fix first: problems found in this review

| # | Problem | Evidence | Fix | Size |
|---|---|---|---|---|
| 1 | **Supplier bank account, IBAN, KYC numbers and credit limit readable by every role** | `GET /stock/stock` needs only `lookups.view` (every role, a CRM-only one too); `services/stock/stockService.js` populated the WHOLE vendor | Populate `vendorName vendorId` only | S |
| 2 | **Staff passport and visa numbers shown to sales users** | `GET /document-expiry` (`sales.view` / `purchase.view` / `accounts.view`) listed staff documents when no party type was sent, and the KYC screen sends none | Customers and vendors by default; staff only for `hr.view` | S |
| 3 | Background jobs stop while the free server sleeps | `render.yaml` `plan: free`; e-invoice retries and polling, messaging retries, recurring invoices and every alert run on `setInterval` in the web process | Always-on server before any client e-invoices | Owner |
| 4 | No scheduled backup | `scripts/backup/export.js` is manual; the free Atlas tier keeps no snapshots | Confirm each live cluster's tier; nightly export; rehearse one restore | Owner |
| 5 | No error monitoring | `console.error` only | Sentry or similar, backend and frontend | Owner + S |
| 6 | **Item codes are random and can clash** | `stockService.js`: 3 letters of the name + random 1000-9999; about a 40% chance of a clash among 100 items whose names start alike, then a confusing error | Retry on an `itemId` duplicate | S |
| 7 | **Two customers or vendors saved at the same moment: one got a bare 500** (measured: 4 of 5 parallel creates refused, for customers and vendors alike) | `createVendor` had no write-conflict retry; `createCustomer` had one that never fired, because the sequence helpers wrapped every error in a plain 500 `AppError`, which strips MongoDB's transient label | Wrap `createVendor`; let a transient error pass through the helpers untouched (both services) | S |
| 8 | A foreign-currency invoice's email stated the base total in the base currency | `services/messaging/documentSource.js` | Use the foreign total and currency when present | S |
| 9 | A typed barcode was replaced by the SKU on item creation; search ignored barcodes | `stockService.js` | Keep the typed value (SKU when blank); search it | S |
| 10 | Stale customer-facing text | Sign-in page: e-invoicing "Coming soon"; Settings "Coming soon: Notifications"; help guides 8.x; `ERP_FEATURE_SPEC.md` status table | Update the text | S |
| 11 | **Payroll ignores attendance and leave** | `services/hr/payrollService.js`, `utils/payroll.js`: unpaid leave never reduces pay; overtime is calculated, never paid | Owner sets the rules (UAE overtime 125% / 150%, day basis), then build | M |
| 12 | Stock can go below zero on an invoice, with no setting | `TransactionService.processTransactionStock` has no shortfall check; the original spec (section 2.6) asked for one | Wave 1, part 4 | S |
| 13 | Master lists are not paged | customers, vendors and items load whole on every order page; garage and HR pickers cap at 500 | Server-side picker search, then paging | M |
| 14 | Dead code that looks live | `stockController.js` `importStock` (no preview, no limit, trusts `req.body.createdBy`) and `exportStock` are reached by no route | Delete when the new import lands | S |
| 15 | Still owed from earlier work | Security headers in `render.yaml` are not applied on the dashboard-made static site (no `X-Frame-Options`, no CSP); the CI workflows have never run on GitHub; Golden Arrow's TRN, emirate, mail provider and Cloudinary | Dashboard settings, GitHub Actions | Owner |

## 3. Compliance gaps

### UAE

| Item | Status | Why it matters | Size |
|---|---|---|---|
| Corporate tax workpaper and return pack | Absent | Every business must FILE a return; Small Business Relief (to tax periods ending 31 Dec 2029, **verify**) is ELECTED on it. Zoho Books has had CT since 2023 | M (rules need an accountant's check) |
| FTA Audit File (FAF) | Absent | Asked for in VAT audits; Tally, Zoho, NetSuite and Dynamics produce it. Take the format from the FTA (sources disagree: CSV v1 or a newer SAF-T style) | M |
| VAT boxes 2, 6, 7 | "Not tracked yet" | Importers paying VAT through customs | M |
| WPS salary file (SIF) | Absent (payroll exists) | Salaries go through WPS; fixed-width file per agent bank, with a 2026 variable-pay section (**verify** with the agent bank) | S-M |
| UAE nationals' pension (GPSSA) | Absent | Once a client employs Emiratis (the Emiratisation tracker exists) | S-M |
| Gratuity final settlement | Accrual only | Paying a leaver | S |
| VAT return filed straight into EmaraTax | Absent | Zoho offers it; check the FTA opens the interface to us | M |
| E-invoicing follow-ups | Built through Wafeq (Wafeq says it became a fully accredited provider in Oct 2026: confirm on the Ministry of Finance register) | Auto-send on approval, XML download, foreign-currency e-invoices, self-billing. Large businesses live 1 Jan 2027, the rest 1 Jul 2027; penalty AED 5,000 plus 5,000 a month, capped at 50,000 a year (**verify**) | S-M each |

### India

| Item | Status | Why it matters | Size |
|---|---|---|---|
| TDS / TCS | Absent | Sections 392-394 of the Income-tax Act 2025 from 1 Apr 2026 (**verify** the table items); Brivox pays a job-work coater | M |
| E-way bill (incl. job-work challans) | Absent | Above the value limit; inter-state job work at any value (check Rule 138) | M |
| E-invoice (IRN via the IRP) | Absent | Mandatory above Rs 5 crore turnover; Brivox is likely below | M-L |
| GSTR-2B / IMS purchase matching | Absent | Input tax claims | M |
| Saved / filed GST returns with a period lock | Absent (UAE VAT has them) | | S |
| ITC-04 (job work) | Absent | The data already exists | S |
| Payroll: TDS on salary, employer PF / ESI, state PT slabs | Absent (employee PF, ESI and a flat PT are built) | | M |
| Brivox's fiscal year | Configuration | It is the calendar year; India's statutory year is 1 Apr-31 Mar. Confirm before year-end | - |

## 4. Missing capabilities, against the market

Size: S up to 1 week, M 2-4 weeks, L 5 weeks or more (rough).

| Area | Capability | Today | Size | Value |
|---|---|---|---|---|
| Getting paid | Payment link on invoices (Network International, Telr, PayTabs, Stripe; Razorpay in India) | Absent | M | High |
| | Automatic payment reminders | Absent | M | High |
| | Alerts: overdue invoices, bills due, expiring documents, failed e-invoices | Absent | S | High |
| | Cash-flow forecast | Cheques only | S-M | High |
| | Customer portal (sign in, invoices, statement, pay) | Per-document secret links only | M | Medium |
| | Bank feeds | Manual statement import | L | Later |
| Going live | Spreadsheet import: customers, vendors, items, opening balances | Absent (only CRM leads and contacts, bank statements) | M | High |
| | Industry starter packs, in-app sample data | Absent (the garage set-up is a command-line script) | M | Medium |
| | In-app organisation export | Command line only; the `backup_restore` permission is defined and unused | M | Medium |
| Inventory | Stock-take sheets with a variance report | One item at a time | S-M | High |
| | Barcode scanning, labels; serial numbers | On-screen barcode only | M | Med-High |
| | Landed cost (freight and duty into item cost) | Freight is expensed | M | High (importers) |
| | Price lists, customer prices, promotions on ordinary invoices | Van sales only (reusable) | S-M | High |
| | Reorder report to a purchase order | Report only | S | Medium |
| | Warehouses / locations, transfers | Absent: one figure per item | L | High (distributors) |
| | Variants, kits; quality check at receipt | Absent | M | Medium |
| Accounting | Fixed assets, depreciation, disposal | Absent (IFRS asset note "Coming soon") | M | High |
| | Accrual / prepayment schedules, reversing journals | Absent | S-M | Medium |
| | FX revaluation journal | Report only | S | Medium |
| | Attachments on vouchers | Absent | S | Medium |
| | Expense claims / petty cash | Absent (by design: expense vouchers) | S-M | Medium |
| | Purchase requisition / RFQ; multi-company consolidation | Absent | M / L | Later |
| HR | Payslip PDF and email; salary advances; muster import | Absent | S-M | Medium |
| Reach | Bilingual Arabic invoice (customer and item names, labels) | Company Arabic name only | M | High (UAE) |
| | WhatsApp Business API | `wa.me` hand-off only | M | High |
| | Scheduled / emailed reports; custom fields; invoice templates | Absent | M | Medium |
| | Full Arabic interface; public API and webhooks; e-commerce connectors | Absent | L | Later |
| | POS, projects and timesheets, helpdesk, subscriptions | Absent | L each | For a paying client only |

## 5. Where this product is ahead

Van sales; garage and insurance claims; production, job work and the process board; a CRM moved by the
documents; an AI that answers from the books and prepares documents; e-invoicing including inbound;
reconciliation with proof; IFRS statements; period close; India GST; HR with labour costing; selling modules
per organisation. **Reuse:** van sales already has price lists, promotions and a count with variance that the
core flows lack; lift them rather than rebuild.

## 6. New features beyond parity

1. **AI bill capture:** a photo or PDF of a supplier bill becomes a draft purchase or expense through the
   existing prepare-then-confirm flow (`services/assistant/actionTools.js`).
2. **Collections autopilot:** reminders (Wave 1), then promise-to-pay notes, a pay link, WhatsApp.
3. **A 13-week cash forecast** (Wave 1), then "what if" scenarios.
4. **An owner's morning digest** by email or WhatsApp.
5. **Industry packs** (trading, garage, manufacturing, services) for onboarding.
6. **A month-end assistant:** duplicate supplier bill numbers, round-sum payments, back-dated entries, added to
   the month-close checks.
7. **Phone-camera barcode scanning** for counting and order entry.

## 7. The programme

| Wave | Contents | Rough size |
|---|---|---|
| 0 | Fixes 1, 2, 6, 7, 8, 9, 10 (14 with Wave 1); owner checklist 3, 4, 5, 15 | 3-5 days |
| 1 - Go live and get paid (**chosen**) | Alerts; spreadsheet imports; payment reminders; cash forecast; stock-below-zero setting | 5-6 weeks with full tests |
| 2 - Year end and UAE tax | Fixed assets and depreciation; corporate tax workpaper; FAF; WPS file; payroll reads leave and overtime (fix 11) | 4-6 weeks |
| 3 - India pack (Brivox) | E-way bill incl. job work; ITC-04; TDS; saved GST returns; GSTR-2B matching | 4-6 weeks |
| 4 - Inventory depth | Stock-take sheets; barcode scanning; landed cost; price lists on invoices; picker search (fix 13); then warehouses | 6-8 weeks |
| 5 - Reach | Payment gateway and customer portal; WhatsApp Business API; bilingual Arabic invoice | 4-6 weeks |
| 6 - Differentiate | AI bill capture; morning digest; month-end assistant; industry packs | ongoing |

**Not now:** POS, a full Arabic interface, consolidation, e-commerce connectors, projects and timesheets,
helpdesk; each waits for a paying client who needs it.

## 8. Wave 1 design: "Go live and get paid"

Decisions of the owner (21 Nov 2026): this block first; payment reminders are **reviewed by a person by
default, with an automatic mode an organisation can switch on**. No new permission key, plan feature or
posting key anywhere in Wave 1, so the zarvia-platform parity mirrors stay untouched. Do not edit
`utils/partyMaster.js` or `utils/inventoryCosting.js` (both are parity-tested there). Each part is its own
branch from `main`, in this order.

### 8.1 Alerts (`feature/money-alerts`, 3-4 days)

New entries in `NotificationChecksService.CHECKS`, with wording and keys in a pure `utils/moneyNotices.js`
(the `chequeNotices.js` pattern). **One grouped row per kind**, never one per invoice:
`NotificationService.forPerson` reads only the newest 300 rows, so per-invoice rows would push every other
alert out of the bell. Keys are per week (`overdue_receivables:2026-11-16`): figures update in place, a fresh
unread row appears once a week while the condition lasts, and `resolveMissing` closes it when it clears.

| Check | module / feature | Audience | Source |
|---|---|---|---|
| `overdueReceivables` | finance | `finance.view` | `AgeingService.openInvoices({type: "receivable"})`; critical past 60 days |
| `payablesDue` | finance | `finance.view` | the same, payable: overdue plus due within 7 days |
| `kycExpiry` (two rows) | sales / purchase | `sales.view` / `purchase.view` | `DocumentExpiryService.list({partyType, withinDays: 30})` |
| `staffDocsExpiry` | hr | `hr.view` | the same, `staff`: counts and the soonest day, no names |
| `batchesExpiring` | inventory + `batches` | `inventory.view` | `BatchService.list({expiringWithinDays})` |
| `einvoiceAttention` | sales + `einvoicing` | `sales.approve` | FAILED with no retry pending, plus REJECTED (the counts behind `utils/einvoiceDashboard.js`) |

Rows show organisation totals (no names on the money rows), as party balances already do. `raise()` never
changes a row's audience when it touches an existing row, so each permission must be right the first time.

### 8.2 Spreadsheet imports: customers, vendors, items (`feature/master-imports`, 1.5-2 weeks)

- **Shared engine.** Move the generic half of `utils/crmImport.js` (`MAX_ROWS`, `norm`, `rowOf`, `lineOf`,
  `issue`, `tally`, `issuesOf`, `moneyFrom`, `phoneTail`) into `utils/importRules.js`; `crmImport.js`
  re-exports it, so its tests stay unchanged. `services/core/importService.js` `ImportService.run(plan,
  {dryRun, create})` is the loop from `LeadService.importMany`: one row at a time, each its own transaction
  (never a whole lot: one duplicate key aborts it all), 11000 mapped to `DUPLICATE`, the CRM answer shape.
- **Rules** in `utils/masterImport.js`: `planCustomerImport`, `planVendorImport`, `planItemImport`, plus
  readers for country, emirate, payment terms, item type, status and VAT status; each row is checked with the
  services' own pure validators (`resolveVat` by the organisation's country, `resolveTerms`, `resolveAddress`,
  `normaliseHsn`), so preview and write agree.
- **Writes** go through the form's services (`customerService.createCustomer`, `vendorService.createVendor`,
  `StockService.createStock`), so ledger party accounts and sequences are the same. Missing categories are
  created first (an option, on by default, listed in the preview); unknown units are refused
  (`UNIT_NOT_FOUND`); no quantity is imported (opening stock goes through Opening balances so it reaches the
  books); purchase price is dropped without `inventory.viewCost`.
- **Duplicates, add only:** customer or vendor by name or TRN (an email or phone repeat is a warning: outlets
  share an email); item by SKU or name; inside the file too. Nothing existing is updated in v1.
- **Routes:** `POST /customers/import` (`sales.create`), `POST /vendors/vendors/import` (`purchase.create`),
  `POST /stock/stock/import` (`inventory.create`). Only `dryRun: false` writes; preview up to 200 rows a
  call, write up to 50. Audit `CUSTOMERS_IMPORTED` / `VENDORS_IMPORTED` / `ITEMS_IMPORTED`: counts and the
  file name only.
- **Frontend:** `lib/spreadsheetImport.js`, `lib/masterImport.js`, `lib/importApi.js`, a generic
  `components/imports/ImportDialog.jsx` with the CRM dialog as a thin wrapper; "Import" beside Add on the
  customer, vendor and item lists (same `<Can>` key as Add) and in each empty list.
- Then delete the dead `importStock` / `exportStock`. **Opening balances follow as their own step**: each
  section posts one all-or-nothing voucher against Opening Balance Equity, so a read-only
  `POST /opening-balances/match/:section` turns names and codes into ids and fills the existing grids.
- Traps: Excel drops leading zeros (HSN 0402 becomes 402: tell the person to format the column as text);
  `lean()` skips the TRN transform, so read both TRN fields; masters are organisation-wide.

### 8.3 Payment reminders (`feature/payment-reminders`, 1.5-2 weeks)

- **Settings** `MessagingSettings.reminders {mode: off | review | automatic, steps (days from the due date,
  default -3, 0, 7, 14, 30), sendHour: 9, catchUpDays: 7, lastAutoRunDay}`, on its own route so the Sending
  form cannot overwrite it. Default `off`; switching on starts in `review`. Per customer
  `Customer.remindersOff` (no schema default).
- **Planner** `utils/paymentReminders.js` (pure): due day = the stored due date, else date + the customer's
  terms (as ageing does); the latest step reached and no more than `catchUpDays` old, so after a sleep, a
  pause or a fresh switch-on only one current reminder goes, never old ones. Qualifies: an APPROVED
  `sales_order`, not opening, outstanding more than 0.005, a customer with an address and not opted out, a
  step not yet used. Organisation calendar days.
- **Exactly once:** the claim is the `DocumentSend` row itself, idempotency key
  `reminder:<invoiceId>:<stepKey>` on the existing unique index, written before the provider is called. Safe
  across retries, two servers and a person racing the job. Released only on an organisation-wide provider
  refusal, which also stops the pass.
- **Sending:** extract the second half of `MessagingService.send` into `deliver(...)` with an explicit sender
  (today `senderOf` and `idempotencyKeyFor` need a request); `send` keeps its behaviour and tests. The email
  says before due / due today / N days overdue, the amount in the invoice's own currency, bank details and
  the secure link; **no PDF** (drawn only in the browser) and it says so. "Recorded only" with the console
  provider. Reminders share the daily allowance but never use its last 20%; an automatic pass sends at most 25.
- **Job:** one `CHECKS` entry (module sales, feature messaging). Review mode raises "N payment reminders
  ready" (`sales.send`); automatic mode sends after `sendHour`, once a day.
- **Routes** in the messaging router: `GET|PUT /messaging/reminders/settings`, `GET /messaging/reminders/due`,
  `POST /messaging/reminders/send`. **Screens:** Sales > Reminders (`/payment-reminders`), Settings > Sending >
  Reminders, "Reminder sent 3 Dec" on the invoice list.
- Fix on the way: the daily limit in `send` counts only document sends; count every kind of email.

### 8.4 Cash-flow forecast (`feature/cash-forecast`, about 1 week)

Pure `utils/cashForecast.js`, reusing `chequeReports.forwardPeriods`: 13 weekly buckets of money in (open
invoices by due day, cheques received, next recurring invoices) and out (open bills, cheques issued, payroll),
net and closing balance, an "overdue" line kept OUT of the running balance, a "later" total and the lowest
point. `services/reports/cashForecastService.js` reads cash today from the ledger (so a branch view is honest),
open documents from `AgeingService.openInvoices`, cheques from the cheque report rows, active recurring
templates' coming runs, and payroll only where the organisation has `hr`. `GET
/accounting/reports/cash-forecast` (`reports.financial`); screen Reports > Cash forecast (`/cash-forecast`).

### 8.5 Stock below zero (`feature/stock-below-zero`, 3-4 days)

`CompanySettings.stockControl.mode: off | warn | block`, copying `creditControl`; absent reads as `off`, so
live organisations behave as today with no migration, and `OrganisationService.create` (never `provision`,
which is re-run on live organisations) writes `block` for a NEW organisation, as the spec intended. Checked in
`processTransaction` before stock moves, for sales invoices and purchase returns; judged on free stock
(`freeDepot`: on hand less job work and vans), lines of one item summed. `warn` uses the existing 409
`RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED` protocol, `block` answers 409 `INSUFFICIENT_STOCK` naming each item.

## 9. Status

| Item | State |
|---|---|
| Wave 0, fixes 1, 2, 6, 7, 8, 9, 10 | **Done** on branch `fix/review-quick-fixes` (backend and frontend), 21 Nov 2026. Each fix has a test, and each test was shown to fail with its fix reverted (on a copy of the backend). Not pushed |
| Fix 14 (dead `importStock` / `exportStock`) | With the import, Wave 1 part 8.2 |
| Wave 1 | Not started |

## Sources (web research, 21 Nov 2026; verify before quoting)

- UAE e-invoicing: [Deloitte](https://www.deloitte.com/middle-east/en/services/tax/perspectives/uae-e-invoicing-asp-appointment-deadline-extended-but-go-live-remains-01012027.html), [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2026/07/tnf-uae-phased-implementation-of-e-invoicing-beginning-january-1-2027.html), [Gulf News](https://gulfnews.com/business/tax-news/uae-e-invoicing-deadline-extended-what-this-means-for-businesses-now-1.500535992), [MoF ASP register](https://mof.gov.ae/en/about-us/initiatives/einvoicing/einvoicing-accredited-service-providers-asps/), [Wafeq release](https://www.wafeq.com/en-ae/press-releases/business-regulations-brief/wafeq-listed-as-an-e-invoicing-service-provider-by-the-uae-ministry-of-finance)
- UAE corporate tax: [MoF, relief to 2029](https://mof.gov.ae/en/news/ministry-of-finance-announces-extension-of-small-business-relief-for-corporate-tax-purposes-until-31-december-2029/), [Gulf News, must still file](https://gulfnews.com/business/corporate-tax/uae-reminds-small-businesses-to-file-corporate-tax-returns-even-if-no-tax-is-due-1.500629117), [Zoho Books CT](https://www.zoho.com/ae/books/help/corporate-tax), [Zoho direct VAT filing](https://www.zoho.com/blog/books/direct-vat-filing.html)
- FAF: [Tally](https://tallysolutions.com/mena/uae-vat/fta-audit-file-faf-uae), [NetSuite](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1539749458.html), [Dynamics 365](https://learn.microsoft.com/es-mx/dynamics365/finance/localizations/uae-faf)
- WPS: [Zoho Payroll, SIF format](https://www.zoho.com/en-ae/payroll/academy/compliance/wps-sif-file-format.html)
- India: [Tally, e-invoicing 2026](https://tallysolutions.com/business-guides/what-changed-in-e-invoicing-compliance-in-2026/), [Thomson Reuters](https://europe.thomsonreuters.com/compliance/regulatory-updates/india), [ClearTax, GST April 2026](https://cleartax.in/s/gst-changes-from-april-2026), [ClearTax, TDS/TCS](https://cleartax.in/s/tds-and-tcs-changes-from-april-2026), [Zoho, Income-tax Act 2025](https://www.zoho.com/in/books/academy/taxes-and-compliance/income-tax-act-tds-tcs-updates-india.html)
