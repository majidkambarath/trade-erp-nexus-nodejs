# HRMS module: research, standard method, and the design

Status: **proposal, awaiting the owner's confirmation.** Nothing is built. 6 Nov 2026.

---

## 1. What exists today (the honest baseline)

There is no HR module. There is one thin master:

| Thing | Where | What it is |
| --- | --- | --- |
| `Staff` | `models/modules/staffModel.js` (37 lines) | name, designation, contact, ID number, joining date, two Cloudinary uploads, Active/Inactive |
| Service / routes | `services/staff/staffService.js` (228 lines), `routes/staff/staffRoutes.js` | plain CRUD + a stats count |
| Permissions | `utils/permissions.js` → module `staff` | two actions only: `view`, `manage` |
| Screen | `trade erp/src/components/Staff/staff.jsx` (747 lines) | one list, one form, at `/staff-records`, a tab inside the **People** module |

That is a contact list with two attachments. It has no concept of a contract, a salary, a working day, an absence, or a payment. Everything below is new.

**What is already built that an HRMS needs and must NOT be rebuilt** — this is the reason the module is worth doing here rather than buying one:

- **The ledger.** Double entry, posting map by key, period locks by year and month, reversal of any posting, approval limits and a second approver, an audit trail per document. Payroll is an accounting event; most standalone HR products bolt a weak ledger on, or none.
- **`utils/documentExpiry.js`** — pure expiry classification (VALID / EXPIRING_SOON / EXPIRED, organisation calendar days, configurable warning window) plus the `DocumentType` master and `/document-expiry`. Built for customer KYC. A visa, passport, labour card, Emirates ID or medical card is the same shape. **Already mirrored in zarvia (`documentExpiry.ts`), so reuse costs nothing in parity.**
- **The approvals queue.** `GET /approvals/waiting`, `services/core/approvalQueueService.js`, the rail badge, the page, `rules.decide`. A leave request is a third source for it, not a new worklist.
- **The notification registry.** `NotificationChecksService.CHECKS` — one entry per scheduled check, each naming the `module` an organisation must hold. Visa expiring, probation ending, payroll not yet run: one row each.
- **The import platform.** `utils/crmImport.js` + `lib/crmImport.js` + `lib/statementFile.js`: read a sheet in the browser, the **server** decides each row, preview first, `dryRun: false` to write, lots for big files, line numbers that point at the person's own spreadsheet. Every biometric device on earth exports a spreadsheet. This is the attendance importer, already written.
- **Documents to people.** `InvoiceSheet` / `VoucherSheet` / `DeliverySheet` + `printMarkup()` + `downloadSheetsPdf()` + the messaging pipeline (`DocumentSend`, retries, providers, idempotency) + the secret share link `/d/:token` with its whitelisted snapshot. A payslip is a sheet, emailed, with a link. All of it exists.
- **`utils/countryRules.js`** — `taxTerms(country)`, `countryFeatures(org)`, `localAccountName`. The pattern for "an Indian organisation must not read VAT or TRN" is the same pattern for "an Indian organisation must not read gratuity the UAE way".
- **The warning-tick pattern.** `utils/yearEnd.js` `assessClose`: blockers that cannot be set aside, warnings the person must acknowledge **by code** (`acknowledge: [codes]`). A payroll run needs exactly this and nothing new.
- **Attachments.** `Attachment.ownerType` is an enum (`transaction, voucher, account, einvoice, customer, vendor, lead, opportunity, jobcard, vehicle, claim`). Add `employee`. The type whitelist, magic-byte check and 10 MB limit come free — **through a separate door, as the CRM's files did**, because `/accounting/attachments` answers to finance and sales keys an HR-only organisation will not hold.

---

## 2. What the market calls an HRMS

Vendor sources converge on a consistent core and a consistent **order of adoption**: core HR records, then attendance, then leave, then payroll; recruitment, learning, performance and engagement phased in afterwards ([uKnowva](https://uknowva.com/blogs/complete-guide-to-hr-management-system-software), [nialabs](https://nialabs.in/blog/what-is-hrms-meaning-modules-and-how-it-works-2026-guide-for-indian-businesses/), [Superworks](https://superworks.com/features-of-hr-software/), [mhcognition](https://mhcognition.com/blogs/hrms-modules-explained)). One guide puts the dependency plainly: at month end payroll pulls attendance, leave and overtime, then applies the salary structure and the statutory deductions.

Read against this codebase, the market set tiers like this:

**Table stakes — without these it is not an HRMS and cannot be sold as one**
1. Employee record with a **job and pay history**, not a single current salary
2. Documents with expiry and a warning
3. Shifts, a holiday calendar, and an attendance record per person per day
4. Leave types, balances, requests, an approval chain
5. Payroll: a run, a payslip, a bank payment file, statutory deductions, and a posting to the books
6. Employee self-service (phone): punch, request leave, see payslips

**Competitive — expected of a credible product, not needed on day one**
7. Overtime from actual punches, and attendance regularisation (a missed punch corrected with a reason)
8. Probation, confirmation, transfers, increments as dated events
9. Onboarding and exit checklists; final settlement
10. Reports: headcount and attrition, muster, leave ledger, payroll register, statutory returns, cost per department

**Differentiator — what this product can do that a standalone HRMS cannot**
11. **Payroll posts to the real ledger**, inside the real period lock, reversible like any voucher
12. **Labour cost flows into product cost.** Process orders already stamp a step's assignee and its start and finish; garage job cards already carry technician tasks. Costed labour hours into `ProductionOrder` cost lines and job-card labour is a genuine moat — no HR vendor can reach your production costing, and no ERP vendor's HR module reaches it either.
13. One chart, one period lock, one audit trail, one organisation, one bill

### The research caveat that decides the architecture

The statutory figures **conflict across sources**, including on live questions:

- India PF wage ceiling: ₹15,000 in some 2026 sources, ₹25,000 "from 17 September 2026" in others ([incorpx](https://www.incorpx.io/blog/payroll-compliance-india-pf-esi-tds-guide), [Wisemonk](https://www.wisemonk.io/blogs/payroll-compliance-in-india), [Commenda](https://www.commenda.io/india/statutory-compliance))
- Gratuity tax-free cap: ₹20 lakh or ₹25 lakh depending on the source
- TDS authority: Section 192 of the old Act, or Section 392 of the Income-tax Act 2025 in force 1 April 2026
- UAE maternity leave: 60 days in several guides, 45 + 15 + 45 in [Morgan Lewis](https://www.morganlewis.com/pubs/2021/12/united-arab-emirates-updates-federal-labour-law)
- UAE gratuity: sources agree on 21 days' basic per year for five years then 30 days ([ProConsult](https://uaeahead.com/uae-gratuity-law-guide-2026/), [paci.ae](https://paci.ae/blogs/uae-end-of-service-gratuity/)), but several calculator sites still publish the **abolished** resignation reductions
- WPS SIF: sources disagree on delimiter (comma vs pipe), filename pattern and ID lengths ([HR Chronicle](https://www.hrchronicle.com/wps-salary-file-sif-salary-information-file-explained/), [HRMantra](https://hrmantra.com/ar-ae/guide/wps-sif-file-template-validation-checklist.html), [RemotePass](https://www.remotepass.com/blog/step-by-step-guide-to-implementing-a-wps-compliant-payroll-system-in-uae))

**Therefore: not one statutory number may be a constant in code.** Every rate, ceiling, slab, cap and accrual is a configurable row with an **effective date**, exactly as a tax code's rate is already "the rate in force on the document date". The engine computes; the country pack is data an administrator can correct the week a notification changes, without a deploy. This is the single most important engineering consequence of the research, and the thing that makes the product globally sellable rather than UAE-shaped.

The SIF format must likewise be a **template** read from configuration, confirmed against the client's own WPS agent before the first live file. CLAUDE.md's rule applies: verify the current text before quoting any of this as advice.

---

## 3. The five decisions to make before any code

These are expensive to reverse. Each has a recommendation.

### D1 — An employee is not a user. (Recommend: separate identity, and not in wave 1.)

`UsageService.current` counts the `users` limit as `Admin.countDocuments({ isActive: true, status: "active" })`. Premium allows **50**. Give 200 factory workers a sign-in and the plan is blown by the HR module itself, and every one of them lands in "Users and roles" beside the finance manager.

Three options:

| | Cost | Verdict |
| --- | --- | --- |
| (a) Employees as `Admin` rows | Breaks the `users` limit and the pricing with it; HR records leak into the access screen | **No** |
| (b) A separate `EmployeeUser` collection, own JWT secret and audience, own login, own portal | One new identity to build and harden | **Yes, wave 3** |
| (c) No employee login at all: HR and managers operate it; payslips reach people by the existing email + share link | Nothing to build; punch-in must be manual or imported | **Yes, waves 0–2** |

(b) is not speculative: `PlatformUser` + `middleware/platformAuth.js` is already exactly this — a second identity with its own collection, secret, audience and 8-hour token that provably cannot open customer data. ESS copies that shape. Until it exists, (c) ships a complete HR product for an office of any size, and payslip delivery already works.

### D2 — HRMS is priced per employee, not per user. (Recommend: add `limits.employees`.)

The whole market prices per employee per month. The ERP prices per user. These are different meters and the plan machinery must carry both: `limits.employees` in `utils/plans.js`, counted in `UsageService.current`, enforced with `assertRoom("employees")` → 403 `LIMIT_REACHED`. Without it the module has no commercial dial.

### D3 — A new `hr` permission module, not more actions on `staff`. (Recommend: new module.)

`staff` is in `ALL_MODULES`, so **every existing customer already holds it**. Add `payroll` as an action on `staff` and every customer gets payroll free — the exact leak CLAUDE.md warns about for a new module.

So: a new module `hr`, named `false` in `standard` and `trading`, present in `trial`, `premium` and `internal`, plus an `hrms` plan for standalone sale (`modulesOnly`, the way the `crm` plan is built). `staff.view/manage` keep working untouched; `/staff-records` redirects to `/hr/people`; no role migration, no data migration.

Proposed actions, and the one that matters:

```
hr: view, manage, attendance, leave, payroll, approve, confidential
```

**`hr.confidential` is the point.** Pay must be separable from the directory. An HR assistant who adds joiners, chases visas and runs the muster must not see the managing director's salary. Every HR product that gets this wrong gets returned. `view` sees people; `confidential` sees money.

Not a vertical: `garage` is in `OPT_IN_MODULES` because workshops are one industry. Every business has employees, so `hr` is horizontal and plan-sold, like `crm`.

### D4 — Payroll posts to the books, through the existing doors. (Recommend: yes, and reversible.)

A posted payroll run is a ledger event: it allocates numbers from `NumberSeriesService`, it calls `FiscalYearService.assertPostingAllowed` (a run dated in a closed month is refused like anything else), it writes one set of entries **per branch**, and it is undone by `FinancialService.reverseLedgerEntries` the way reopening a year undoes its closing entry. Never a second ledger, never a direct write.

New posting keys, seeded in **both** `utils/accountConfigSeed.js` and `utils/defaultChart.js` and mirrored in zarvia, topped up lazily by `DefaultChartService.provision` for existing companies (the `service-expense` / `production-absorbed` pattern):

- `salary-expense` — "Salaries & Wages" already exists as an *account* in `defaultChart.js:73`; it has no key
- `salaries-payable` — net pay owed until the bank file clears
- `payroll-deductions-payable` — one liability per statutory head, per country pack
- `employee-advance` — loans and advances (asset)
- `gratuity-expense` / `gratuity-provision` — IAS 19 / Ind AS 19; a liability that accrues monthly, not a surprise on the day somebody leaves
- `salary-component.expenseAccountId` — **a salary component may name its own account**, else the key. This is the `service-expense` pattern and it is what lets a client post overtime, site allowance or drivers' wages wherever their accountant wants, with no code change.

### D5 — Is an employee a branch document or an organisation master? (Recommend: branch scoped.)

CLAUDE.md's rule is documents per branch, masters organisation-wide. An employee is both: a master to the chart, a branch's person in practice, and payroll runs per branch. Recommendation: `Employee` is **`branchScoped`** — a branch manager sees their own people, head office sees everyone, and HR reads across with `allBranches()` where it genuinely needs to (a group-wide headcount report). Attendance, leave and payroll runs are plainly branch documents.

This is the one decision I hold with least confidence; the alternative (organisation-wide with a `branchId` field, the `VoucherType` choice) is defensible if people move between branches often. Say which your clients do.

---

## 4. Information architecture and UX

### Its own workspace, not a module

HR is a different person's whole day, with its own vocabulary. The shell already supports this and the CRM proved it: `workspace` on a module, `WORKSPACES`, `modulesIn`, `offeredWorkspaces`, `WorkspaceSwitcher`. Adding `workspace: "hr"` needs **no new shell machinery** — `MODULES` stays one flat array, so `findActive`, `pageTitle`, route coverage and the mobile sweep are untouched.

Eight single-tab modules, so each is a plain rail item (`ModuleTabs` draws no strip below two tabs). **No `/hr` route** — a tab's path prefix-matches its children and `navigation.test.js` requires each route in exactly one tab.

| Rail item | Route | What it is |
| --- | --- | --- |
| Overview | `/hr/overview` | headcount, who is off today, documents expiring, approvals waiting, this month's payroll state |
| People | `/hr/people` | the directory; `ListPage` + `useListView("hr-people")` |
| Attendance | `/hr/attendance` | the monthly muster |
| Leave | `/hr/leave` | requests, balances, a calendar |
| Payroll | `/hr/payroll` | the run |
| Documents | `/hr/documents` | the expiry register |
| Reports | `/hr/reports` | seven named reports behind `PillTabs`, **one route** |
| Setup | `/hr/setup` | departments, designations, shifts, holidays, leave types, salary components, pay grades, the country pack |

Reports is one route on purpose — the 88px rail cannot hold seven more items, and the mobile sweep opens `role="tab"` panels by itself, so all seven are swept free. That was the right call for CRM Reports and it is the right call here.

Within the HR workspace the bottom bar comes from `modulesIn("hr", modules)`. Checked: `getMobileNav(modules)` only ever sees the list it is handed, and fills empty slots from the remaining modules in rail order, so the bar is never short. Flagging HR modules `mobilePrimary` therefore **cannot** disturb the ERP bar — and HR gets a sensible bar even with no flags at all. (This is unlike the CRM, where flagging a module would have silently dropped Finance, because that was a flag on the *global* list.)

### The two audiences problem — the real UX decision

HR software serves two people who want opposite things:

- **HR and the owner**: dense tables, a month at a glance, a payroll run, exceptions first. Desktop. **The existing design language fits exactly** — `DataTable`, `FilterBar`, `ListPage`, `table-pin-first`, the blockers-and-warnings dialog.
- **The employee**: three things ever — punch, ask for leave, read a payslip. On a phone, in a queue, one-handed, possibly in a second language.

**Do not serve both with one UI.** The employee portal is a separate, small, phone-first surface with its own shell — not the 88px rail with things hidden. The codebase already has the precedent for a page outside the shell: `/d/:token` renders with its own Suspense, no `Layout`, no `RequireSession`. ESS is built that way: big targets, one task per screen, no tables at all.

### The screens that need real design care

**The muster (`/hr/attendance`) — the hardest layout in the module.** 31 columns across, every employee down. It must stay a table: CLAUDE.md is explicit that figures which must line up stay tables, with `table-pin-first` so the name column freezes and the days scroll under it. It cannot become cards.

Below `md` a 31×N matrix is unreadable at any size, so the phone gets a **different reading of the same data, not a squeezed one**: pick a day, get a list of people with a status chip each. That is the same decision the CRM calendar already made (chips from `md` up, dots below). A `cards: true` sweep step covers it.

**The payroll run — a four-step stepper, with exceptions first.**

1. **Period** — month, pay group, branch. States the headcount in scope and warns at once if attendance is incomplete or leave requests are still pending.
2. **Inputs** — overtime hours, bonuses, deductions, loan instalments, unpaid days. Every figure **says where it came from**: pulled from attendance, or typed. A payroll nobody can audit is a payroll nobody trusts.
3. **Review** — **the exception list before the payslips**: negative net pay, no IBAN, salary that disagrees with the registered contract, a joiner mid-month, someone with no contract at all. This is `assessClose`'s own shape, reused verbatim: blockers that cannot be set aside, warnings acknowledged by code (`acknowledge: [codes]`, else `PAYROLL_WARNINGS`).
4. **Post and pay** — locks the run, allocates its number, posts per branch, generates the bank file, queues the payslips.

A posted run is locked and reversible, never editable — the voucher rule, and the rule the finance QA pass of 1 Nov 2026 had to enforce the hard way (`VOUCHER_POSTED`: delete and re-enter, do not repost in place).

**The employee page** (`/hr/people/:id`) follows `PartyAccountPage`: tabs for Profile, Job and pay, Attendance, Leave, Documents, and the audit timeline. Pay tab behind `hr.confidential`, hidden rather than disabled, as every other guarded action in the product is.

**Leave requests ride the existing approvals queue.** `ApprovalQueueService` already returns draft documents and pending vouchers, judged by `rules.decide`, with the rail badge and the page built. A leave request is a third source. A manager must not approve their own leave — that is `separateApprover`, already written.

**Payslip delivery**: a `PayslipSheet` printed through `printMarkup()` / `downloadSheetsPdf()`, emailed through the messaging pipeline, opened by the employee on a share link. One caution, and it is serious: a payslip is the most sensitive document the product will ever hand out, so its share snapshot goes through `utils/shareSnapshot.js`'s **whitelist, picked field by field and never spread** — the rule that is already mutation-checked for `jobCardRef` and `party.eInvoice`.

---

## 5. Data model sketch

New collections, all `tenantPlugin`, none defaulting `companyId`, indexes declared with `schema.index` so they are per-organisation (`tenantGuard` fails otherwise):

| Collection | Scope | Note |
| --- | --- | --- |
| `Employee` | branch (D5) | absorbs `Staff`; series `EMP` |
| `EmployeeContract` | branch | **versioned**: a raise is a new row with an effective date, never an overwrite. This is what makes "salary ≠ registered contract" checkable and what makes a back-dated payroll honest |
| `EmployeeDocument` | branch | reuses `DocumentType` + `utils/documentExpiry.js` |
| `Shift`, `HolidayCalendar` | organisation | masters |
| `AttendanceDay` | branch | one row per employee per day: in, out, hours, status, overtime, **source** (manual / imported / punch) |
| `LeaveType` | organisation | accrual, carry-forward, encashment, paid-at-what-rate, all dated data |
| `LeaveRequest` | branch | DRAFT → PENDING → APPROVED / REJECTED / CANCELLED; series `LV` |
| `SalaryComponent` | organisation | earning or deduction, formula, taxability, optional `expenseAccountId` |
| `PayrollRun` | branch | DRAFT → REVIEWED → POSTED → REVERSED; series `PAY` |
| `Payslip` | branch | one per employee per run, **immutable once posted** |
| `StatutoryRule` | organisation | the country pack: rate, ceiling, slab, **effective from** — the D-caveat made concrete |

Leave **balance is derived**, not stored: accrual rules plus approved requests, the way `withJobWorker` is derived in job work. A stored balance drifts, and a drifted leave balance is a dispute with an employee.

---

## 6. Build order

Each wave is sellable on its own; none leaves a half-feature on screen.

- **Wave 0 — foundation.** Module registration (the checklist below), `hr` permissions, `limits.employees`, Employee + contract + documents, People directory and profile, Setup's masters, `Staff` → `Employee` migration with `/staff-records` redirecting. Sells as *employee records done properly, with visa and passport expiry warnings*.
- **Wave 1 — time.** Shifts, holiday calendar, the muster (manual entry **and** spreadsheet import through the existing import platform), leave types, requests on the approvals queue, balances, the HR notification checks. Sells as *attendance and leave*.
- **Wave 2 — payroll.** Components, pay grades, the four-step run, the payslip sheet and its sending, ledger posting and reversal, the period lock, gratuity accrual, and the first two country packs: **AE** (gratuity, WPS SIF) and **IN** (PF, ESI, PT, TDS, gratuity). This is the wave that makes it an HRMS.
- **Wave 3 — self-service.** `EmployeeUser` as a separate identity on the `PlatformUser` pattern, the phone-first portal, geofenced punch, regularisation requests.
- **Wave 4 — the ERP moat.** Costed labour hours into process-order cost lines and garage job-card labour. Small to build once waves 1–2 exist, and impossible for any standalone HR vendor to copy.
- **Wave 5 — talent.** Recruitment and ATS, onboarding and exit checklists, appraisals, training. Last on purpose: the research is unanimous that these are phased in after the core, and they do not sell an HRMS to an SME in the GCC or India. Payroll does.

### Deliberately not built
Full ATS with job boards; an LMS; engagement surveys and 9-box grids; US-style benefits administration; biometric **device APIs** in v1 (the spreadsheet import covers every device); shift auto-scheduling and optimisation; drag-to-edit org charts; countries beyond AE and IN in v1. And **expense claims are not rebuilt** — the ERP has expense vouchers and a payment engine; a reimbursement posts through those with the employee as the party.

---

## 7. Registration checklist (derived from where `garage` appears)

A new module is not just files. Every place the garage module had to be registered:

- `utils/permissions.js` — the module and its actions, the role grants, the catalogue bound in `permissions.test.js`
- `utils/plans.js` — `modules` per plan (`false` in standard and trading), the new `hrms` plan, `limits.employees`
- **`zarvia-platform/packages/domain/src/{permissions,plans}.ts` — in the same commit.** The parity suites deep-equal every non-function export. The meetings work learned this the hard way: *any* change to a mirrored module's export surface needs the mirror, even making an internal function public.
- `utils/consoleCatalog.js` — the module's label, hint, group, screens and actions, so the developer console can sell it (`consoleCatalog.test.js` fails if a feature is filed under no module)
- `utils/accountConfigSeed.js` + `utils/defaultChart.js` (+ both zarvia mirrors) — the posting keys
- `utils/voucherTypes.js` — the `EMP` / `LV` / `PAY` series
- `server.js` — the routes, mounted **before** `adminRouter`
- `services/core/notificationChecksService.js` — `CHECKS` entries with `module: "hr"`
- `models/modules/financial/attachmentModel.js` — `employee` in the `ownerType` enum
- `trade erp/src/config/navigation.js` + `lib/organisation.js` — the modules, the workspace, labels
- Tests: pure rules, a database suite, an HTTP suite against a spawned strict server, frontend `lib` and screen tests, and `check:mobile` stubs with deep steps for every new screen

---

## 8. What I need from you before starting

1. **Which client first — Al Manara (AE) or Brivox (IN)?** It decides which country pack ships in wave 2. They also pull in different directions: Brivox is a manufacturer with process orders, so shop-floor attendance and labour costing matter; Al Manara already records technician tasks on job cards.
2. **How many employees, roughly?** Under ~30 and self-service can wait until wave 3 as proposed. Over ~100 and ESS moves earlier, because manual muster entry stops being realistic.
3. **Is payroll in scope at all,** or do you want HR records plus attendance and leave first? Payroll is where the legal risk and most of the work live. Waves 0–1 are genuinely useful without it.
4. **Do you accept pricing per employee** (D2)? If not, the module has no meter and I should not add one.
5. **Daily-wage and hourly workers** — does either client have them? A garage and a factory usually do, and it changes the contract model (wage type, not just monthly salary).
6. **D5**: do people move between branches often?

One thing I will not do without your word: treat any statutory figure in section 2 as settled. The sources contradict each other on live questions, which is exactly why section 3's D-caveat makes them editable data. Before the first live payroll, the client's own accountant and WPS agent confirm the numbers and the file format.
