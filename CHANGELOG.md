# Changelog

## 1.9.0.0 — 26 October 2026

The cheque register used to know four states (pending, cleared, bounced, cancelled) and nothing else. It now
follows a cheque the way a finance desk does: held in the drawer, taken to the bank, cleared or sent back, with the
reason and the cost of a bounce on file, a view of what falls due, and reminders so nobody has to remember which
cheque is due on Thursday. Every new state is a state of the REGISTER: no new posting key, no new voucher type and
no new voucher status, so the day book, the reports and the Phase 2 parity mirrors are untouched. Backend 1.9.0.0.

### Added

- **Deposit and hold** (`POST /banking/cheques/:id/{deposit,hold,resume}`): a cheque taken to the bank is
  `deposited` (paying-in slip recorded); one kept back on purpose is `hold` (reason required). Neither posts
  anything - the money stays in "Cheques in Hand" until it clears - so neither is stopped by a closed period.
  A deposited cheque is still a bank-reconciliation candidate; a held one is not. **Bulk** deposit / clear /
  hold / resume (`POST /banking/cheques/bulk`, up to 200): one transaction per cheque, each failure reports its
  own code. Bounce is not bulk: it needs a reason for each.
- **The dishonour recorded**: a reason from a fixed list or in words, the bank's memo date and reference, its
  certificate reference, and the part the bank paid, if any (recorded as a fact; the cheque still reverses in
  full and the part paid is entered as a receipt). Optionally the **bank's charge** (an ordinary expense voucher,
  with VAT split from the gross) and a **charge-back to the customer** (an ordinary debit note), posted inside
  the bounce's own transaction: if anything is refused - a closed period, an account, an approval limit - the
  bounce and both charges are undone together.
- **Hand back** (`POST /banking/cheques/:id/return`, status `returned`): a cheque given back to the party before
  it was presented. The voucher is reversed and reads "cancelled". The screen says "Handed back".
- **Reminders** on the notification feed, for people with `banking.view`: a cheque maturing within 7 days or past
  its date and not deposited ("deposit it" for one we hold, "keep the account funded" for one we issued), a
  cheque at the bank more than 5 days without clearing, and a cheque about to go stale. Moving to a later stage
  (past its date) tells a person again even if they read the earlier notice.
- **Due dates and Cash forecast** (`GET /banking/cheques/{maturity,forward}`), as views of the Cheques page:
  what falls due grouped by how soon / party / bank account / month, and week-by-week or month-by-month what the
  cheques do to the bank. A cheque on hold is shown beside the forecast, never in it.

### Changed

- **Cheques belong to a branch.** They did not, so a branch user listed other branches' cheques, whose audit
  trail then answered 404. A branch view now lists, reads and reconciles only its own branch's cheques, as the
  voucher behind each already did. **On first start-up** `backfillChequeBranches` gives every existing cheque its
  voucher's branch (not head office's); it is idempotent and runs before requests are served.
- A voucher whose cheque is at the bank cannot be edited or deleted (`CHEQUE_WITH_BANK`), instead of silently
  cancelling a cheque the bank holds.

### Fixed

- **Background notification checks ignored plan overrides.** The organisation row a job is handed omitted
  `featureOverrides` / `moduleOverrides` / `limitOverrides`, so an organisation that bought the CRM or the garage
  as an override on a lower plan got none of its notifications, and one that had a module switched off still
  did. They now follow the overrides. (Organisations with overrides will see CRM / garage notifications begin
  or stop accordingly.)

### Notes

- Nothing here encodes a legal rule. Cheque validity is 183 days for every country, as it always was, because no
  other country's value could be verified; a country is added to `CHEQUE_VALIDITY_DAYS` only from its primary source.
- **Not built:** entering a strip of cheques in one step, re-presenting a bounced cheque, counting uncleared
  cheques in a customer's credit exposure, and keeping an invoice open until its cheque clears. The last needs a
  decision first: from 1 January 2026 IFRS 9 does not allow a receivable to be removed for a cheque until it
  clears, and the ledger currently credits the customer when the cheque is received.

## 1.8.0.0 — 26 October 2026

The first industry vertical: a garage/workshop module, sold per organisation like the CRM. A vehicle
comes in, is checked in with a walk-around, gets an estimate of parts and labour (sent for approval
by WhatsApp, a call, a signature or an insurer's LPO), is worked through tasks in parallel stages,
invoiced, and handed back on a gate pass with a warranty. An accident repair can split one job into
two invoices - the insurer's share and the customer's excess/depreciation - from one decision.
Almost none of the money machinery is new: a job card is a non-posting document in front of an
ordinary sales invoice, exactly like a delivery note; labour and sublet are service `Stock` items, so
the existing service-posting routing keeps parts, labour and sublet revenue apart with no new
template. Backend 1.8.0.0.

### Added

- **`Vehicle`** (organisation-wide master, found again by plate or chassis however either is typed)
  and **`JobCard`** (branch scoped, series `JC`): DRAFT -> AWAITING_APPROVAL -> IN_PROGRESS -> READY
  -> DELIVERED -> CLOSED, or CANCELLED. One `lines[]` array for parts/labour/sublet/consumable, so the
  estimate and the invoice price from the same figures; `approved`/`invoiced` per line stop a line
  being billed twice, including across an ordinary invoice racing an insurance claim's own split.
  Tasks carry a `stage` - tasks sharing one run in parallel, the next stage opens only once every task
  in this one is settled - the one structural difference from a process order's strictly sequential
  steps.
- **`InsuranceClaim`** (series `CLM`) and `Customer.isInsurer`: survey, the insurer's approval with an
  excess and a parts-depreciation percentage, and `splitBill` - one job, two invoices, proven to add
  back to the job's own total.
- **Setup**: `Bay` (branch scoped: the ramps, lifts and booths a task can be assigned to) and
  `GarageService` (organisation-wide: a saved "standard job" - a labour item plus its usual parts and
  tasks - that fills a job card's estimate in one tap, `GET /garage/services/plan`, the same
  "returns a draft, creates nothing" shape as a process route's own plan).
- **A part short of stock is offered, not guessed**: `JobCardService.shortages` reads what is on hand
  less what every OTHER live, uninvoiced job card has already committed, names the item's own default
  vendor, and `raisePurchaseOrder` raises a real draft purchase order through the ordinary
  `TradeOrderService` (kind `purchase`) - recorded on the card, received and invoiced through the
  ordinary Purchase screens, never through the job card itself.
- **Four notification checks** (`NotificationChecksService.CHECKS`, module `garage`): a job overdue
  against its promised day, an estimate still waiting a decision after 24 hours, a claim waiting on
  the insurer past two days, and a vehicle due or overdue for its next service (date or odometer,
  whichever comes first).
- **Attachments** (`garageAttachmentService.js`, the CRM's own narrow-door pattern) for job cards,
  vehicles and claims - photos, signatures, survey photos - never through the finance attachment
  door, which answers to keys a garage-only person does not hold.
- **The module itself**: `garage` is the first entry in `plans.js` `OPT_IN_MODULES` (in NO plan, not
  even Premium - an organisation only gets it from a developer-console override, like the CRM), with
  its own permission actions (view/create/edit/delete/approve/invoice/manage) and no implied access to
  `sales.*`/`purchase.*`/`inventory.*` - raising an invoice or a purchase order from a job card
  double-asserts the real module's own key in the controller, never a side door through `garage.*`.
  `scripts/demo/garageDemo.js` builds a full demo organisation (Al Manara Auto Garage) through the
  real services: a retail job closed end to end, an accident repair split between insurer and
  customer, three more jobs left open at different stages, and the Setup screen's own bays and
  standard jobs.

### Fixed

- **Two pre-existing bugs found while building this, unrelated to garage**: `customerService.js`'s
  `createCustomer`/`deleteCustomer`/`deleteCustomerByCustomerId` called `session.abortTransaction()`
  unconditionally in their catch block, so a transaction already committed (or already aborted) threw
  a second error that masked the real one; guarded with `session.inTransaction()`. A genuine,
  deterministic transient `WriteConflict` (112) on the `Sequence` collection's very first write in a
  fresh database was surfacing as a raw 500 on `createCustomer`; wrapped with the established
  `retryTransientTransaction` helper.

## 1.7.0.0 — 26 October 2026

The balance sheet is a statement now, not a list of accounts: classified current and non-current,
grouped, in the order IAS 1 reads, with a comparative column beside it. Frontend 1.7.0.0.

### Added

- **The balance sheet is classified and comparative.** `getBalanceSheet(asOf, { compareAsOf })`
  keeps every field it has always answered and adds `sections` - non-current and current assets,
  equity, non-current and current liabilities, each grouped with its own subtotal - and
  `comparative`, the same statement at an earlier date zipped in per account so every line, group
  and total carries `comparative` beside `amount`. IAS 1.60 expects a classified statement and
  IAS 1.38 a comparative; until now this answered three flat arrays of ledger accounts under three
  headings. `positionAt()` is one date's position, and a comparative is simply that function called
  twice. `GET /vouchers/reports/financial?reportType=balance_sheet` takes `compareTo`; the screen
  works out what "a year earlier" means, because that is a reading question and not the ledger's.
- **Profit inside equity is two figures, not one.** `profitBroughtForward` (what earlier years
  nobody closed earned - a closed year has its profit in Retained Earnings already) and
  `profitForPeriod`. `profitToDate` is unchanged and is their sum, so nothing that read it moves.
  A prior year left open used to disappear into that single number with nothing to say it was there.
- **`utils/statementClassification.js`**, new and pure: whether an account is non-current (by its
  GROUP PATH - its own group or any above it in the tree), the order a statement reads in (IAS 1:
  stock, then receivables, then the rest, cash LAST), and what counts as drawings.
  `services/reports/ifrsReportsService.js` imports these instead of declaring its own copies, so the
  product's two balance sheets cannot classify or order the same account differently. It is a new
  module deliberately: `plans.js` and `permissions.js` are mirrored in zarvia-platform and adding
  exports to either needs the mirror changed in the same commit.
- **Every trial balance row carries its `groupPath`**, so a screen can collapse a trial balance to
  its groups and narrow it to the payables, the receivables or the expenses without asking again.

### Fixed

- **An account with a balance at the comparative date and none today vanished from the statement,**
  so the comparative column did not add up. Found on the ABC books: assets 1,979,037.46 against
  equity and liabilities 2,073,547.30. Walking only today's rows is the trap; such lines are carried
  through at nil now, classified as they were on the day they had a balance.
- **The no-offsetting reclassification was name-matching** (`/^Customer( Advance)? - /` and friends),
  so an account somebody renamed was left as a negative on the wrong side. It resolves the configured
  receivable, payable and cash-and-bank group trees first, with the old name-matching behind them:
  `groupSet` skips a posting key that was never mapped, and a company in that state would otherwise
  lose the reclassification altogether.
- **A balance sheet's lines came out in account-code order**, which is an arbitrary order for a
  statement. They read as IAS 1 reads them now.

### Verified

- Every subtotal of the Statements balance sheet equals the IFRS statement of financial position -
  the one proved against live books on 24 October - for Brivox's Indian books and for the 21-month
  ABC books, and a comparative column equals a direct run at that date.
- `utils/__tests__/statementClassification.test.js` (10 pure),
  `services/__tests__/balanceSheetStatement.test.js` (11, including the dropped-line bug and the
  IFRS oracle). Unchanged and green: ifrsReports 15, reportsReview 11, yearEnd 19,
  chartAndPricing 8, httpFlow 16.

## 1.6.0.1 — 24 October 2026

A statement can now be taken of any account in the chart, not only a customer's or a vendor's, and
the IFRS notes are written in the organisation's own tax words. Frontend 1.6.0.1.

### Added

- **A statement of any ledger account** (`GET /accounting/reports/statement?accountId=`): a bank, a
  cash box, a loan, a VAT account, an expense - every posting against it in date order with a running
  balance. It is the account ledger's own read (`ChartOfAccountsService.getLedger`) reshaped into the
  statement's answer, deliberately not a second implementation of the same arithmetic: the statement
  and the ledger drawer behind Reports -> Ledger must read one account the same way or they would
  quietly disagree. **It answers to more than `reports.view`**, which is in `plans.ALWAYS_ON` and
  therefore held by every organisation: with `accountId` the route asks for `accounts.view`,
  `reports.financial` or `finance.view`, the same keys as `/accounts/:id/ledger`, because a statement
  of any account is the general ledger by another name. A party's statement is unchanged.
- **`net` on every statement row, opening and closing** (debit minus credit), beside the `balance`
  that is signed for the party. One field then means one thing whether the statement is a party's or
  an account's, and the screen draws Dr / Cr from it. `subject { kind, name, ... }` says what the
  statement is of, so one screen draws both. With posting off an account's statement answers
  `postingOff: true` rather than an empty page: nothing is posted to accounts at all then, and only a
  customer's or vendor's statement can be rebuilt from the documents themselves.
- **The letterhead logo can be taken off** (`removeLogo` on `PUT /company/profile`; a multipart field
  arrives as text, so `"true"` and the boolean are both accepted). Both halves of `profile.logo` are
  emptied, so documents print without one, and the stored image is deleted from Cloudinary once the
  change is saved - a failure to tidy up never fails the save, as with a replaced logo. The audit row
  says "logo removed".

### Fixed

- **The IFRS notes read "VAT", "TRN" and "the Federal Tax Authority" whatever the country.** An
  Indian company's notes now say GST, GSTIN and "Goods and services tax" throughout, and the heading
  over the tax note follows the same table. Only the UAE's authority is named; everywhere else it is
  "the tax authority", which is true and claims nothing we do not know. `taxTerms` gained `taxName`
  (the tax written out, for a heading that cannot use the initials) and `authority`.

## 1.6.0.0 — 23 October 2026

How a document is numbered is the organisation's own setting now, instead of a table in the source. A
master to set it, a record of every number ever given out, and an answer to "why is there no invoice
41?". Frontend 1.6.0.0.

### Added

- **A voucher type master** (`VoucherType`, `/accounting/voucher-types`). One row per series - all 29,
  not only the finance vouchers - holding what the document is called and how its number is built:
  prefix, suffix, separator, counter width, whether the year appears, when the counter restarts, how
  the branch appears, whether a number may be typed and whether a deleted number may be used again.
  Seeded on first READ from `utils/voucherTypes.js`, never overwriting, and the seed reproduces the old
  hardcoded defaults byte for byte - so an organisation already trading keeps every number it has
  issued. Reading is `accounts.view` (the type list also takes `lookups.view`: a form needs to know
  what a document will be called); changing it is `accounts.manage`.
- **A register of every number issued** (`IssuedNumber`), written in the same transaction as the
  document it numbers. It answers three things at once: the deleted list with the reason each number
  went, the free list for re-use, and whether a sequence is unbroken. A unique index on the rendered
  number is the real guarantee a number is never used twice, independent of any counter - it refused a
  hand-wound counter the day it was written. It also means a number never has to be PARSED to find the
  counter that minted it, which nothing in the product does.
- **Re-use of a deleted number, where that is safe.** Opt-in per type, and refused outright for a
  document we issue bearing tax (`SO`, `SR`, `DN`, `CN` - India CGST Rule 46(b), and an e-invoiced
  number is already lodged with the tax authority), for a series the system writes itself, and for any
  document already sent to the customer. Everywhere else the gap is recorded with its reason instead,
  which is what an auditor asks for. The free list is a query over the register claimed by one
  conditional update, never an array on the counter: an array cannot de-duplicate a double release, and
  that is how two documents end up sharing a number.
- **Continuity report** (`/accounting/number-register/gaps`): for one series and one counter, which
  numbers are in use, which are missing, and why each hole is there - handed back, retired, or no
  record at all (a transaction that took a number and rolled back).
- **Named variants of a built-in type.** "Petty cash payment" under Payment carries its own name,
  prefix and counter and stores its PARENT's `postsAs`, so the twenty-odd places that compare
  `voucherType` against `"payment"`, the reports, the approval queue and the VAT return needed no
  change at all.

### Fixed

- **A number a person typed was silently thrown away.** The sales invoice form has had an Auto /
  Manual switch since before the mass-assignment hardening made the controller strip `transactionNo`
  from request bodies - rightly, a body must not choose a tax invoice's number - and nobody took the
  box away. A person could switch to Manual, type INV-500, save, and the server would file it as
  SO-2026-0043 with no error. Both ends are joined now: `NumberSeriesService.numberFor` is the one
  entry point for every document service, a typed number arrives as `manualNumber` (its own field,
  because `transactionNo` must stay stripped), it is refused unless the voucher type allows it, and
  the counter is FLOATED past it so the automatic series can never reach the same number months later
  and fail on the unique index.
- **The prefix rule never matched what the code produces.** `prefix` was declared
  `/^[A-Z0-9]{1,5}$/` while `prefixFor` has always produced `SHJ-SO` - a hyphen and six characters.
  It survived only because `findOneAndUpdate` does not run validators; the first validated write would
  have thrown on every non-head-office series.
- **Head office could not see a branch's numbering.** `NumberSeriesService.list` was pinned to the one
  branch being worked in. It reads `branchView` from the ambient scope now, which `getTenant()` does
  not carry.
- Three leftover `TEMP LOG` lines in the trade-document path, and a controller comment that claimed
  `transactionNo` "is not a field of the order form" when it was exactly that.

### Upgrading

- **One migration, `markVoucherNumbersHeld`, runs at start-up.** A deleted voucher is kept, cancelled,
  WITH its number, so the unique index held that number for ever and nothing could be given it again.
  `Voucher.numberReleased` was added and the index is partial on it. The migration flags vouchers
  written before that field existed and drops the legacy index; without it those rows match the partial
  filter on nothing and lose the uniqueness the index exists for. It is idempotent and one-time.
- **The partial index is NAMED `voucherNo_unique_held` on purpose.** Mongoose names an index after its
  keys, so it would otherwise be called `companyId_1_voucherNo_1` - the same as the unconditional one
  it replaces - and MongoDB refuses two indexes of one name. Dropping the old one from the migration
  cannot help: `autoIndex` tries to build the new one as soon as the connection opens, long before any
  migration runs, and Mongoose caches that rejection for the life of the process. With its own name the
  two coexist until the migration drops the legacy one.
- Measured on live books: 801 vouchers flagged, the legacy index dropped, clean boot.
- No permission key and no plan changed, so `zarvia-platform` is untouched. `utils/voucherTypes.js` is a
  new module and is not parity-mirrored.

## 1.5.0.2 — 22 October 2026

Two endpoints the screens had grown to need, the routes the assistant and the CRM sign in through,
and the help topics written by hand. Frontend 1.5.0.2.

### Added

- **The company's own accounts at a bank** (`GET /banking/banks/:id/accounts`, `banking.view` or
  `accounts.view`): the chart accounts held at one bank, with a count per bank for the list. A bank
  account is a chart account under the Bank group, so reading one is the chart's key, not a new one.
- **The transaction list carries `pricing` and `charges`.** A printed invoice reads the server's own
  figures (`utils/documentTotals.js`); without them a sheet printed from a LIST row summed the lines
  and lost the header charges, the header discount and the round-off.
- **Signed-in routes for the AI assistant and the CRM**, declared as such so the route-guard test -
  which fails any route under `/api/v1` with neither a permission nor a stated reason - still passes.

### Fixed

- **The server would not boot** where the filesystem is case-sensitive: `utils/AppError` was required
  with a lower-case `a`. Windows and macOS did not care; a Linux container did.

### Internal

- The help topics for the dashboard, the CRM and Quotations are written by hand rather than generated.
- CI: the integration job is given the secrets a clean checkout has no `.env` for.

## 1.5.0.0 — 21 October 2026

Two things a client meets on their first day and we could not answer for: a CRM that can be sold
without the ERP, and an assistant that answers the questions they currently ring us about. Plus the
parts of a salesperson's day the CRM could not see - arranging a meeting, and writing to a customer.
Frontend 1.5.0.0.

### The CRM sold on its own

- **A `crm` plan ("CRM only").** The CRM, the organisation's own people and settings, and nothing of
  the trade. Four separate things stopped this working before, each found by reading the code rather
  than by trying it: qualifying a lead asked for `sales.create`, which such an organisation cannot
  hold, so it could not qualify one enquiry; the new-deal form read the Sales customer master, so it
  could not even choose a customer; no plan sold the CRM alone; and its owner landed on an ERP
  dashboard of zeros with nowhere to add the colleagues who would use it.
- **It is a weaker product, and is sold as one.** All three automation events are ERP documents, so a
  CRM-only client raises none and moves its deals by hand. That is the recorded decision: sell it
  honestly, and make the self-moving pipeline the reason to add the ERP.
- **Import a spreadsheet**, of leads or of people: columns guessed from the headings, previewed first,
  never written unless asked, safe to run twice, and audited with counts but never a name or a number.
  An import leaves no first-contact tasks unless the person asks for them - two hundred old enquiries
  must not land on today's worklist.
- **Files on a lead or a deal**, through a door of the CRM's own onto the existing storage. The
  accounting attachments route answers to finance and sales keys a CRM-only organisation does not hold,
  and widening it would have handed them every voucher's and invoice's files.

### Meetings, with a calendar invitation

- **A meeting at a time**, with the people who will be there and a joining link the organiser pastes
  (their own Meet room, Zoom or Teams), and an invitation that lands in the customer's own Gmail,
  Outlook or Apple calendar with Accept and Decline.
- **A meeting is the follow-up it always was**, with a time added, so the worklist, the calendar, the
  timeline, the deal and the reports needed no change - 33 places read the day, and none of them learns
  that a meeting now has an hour.
- **The invitation is built against RFC 5545** and the fiddly parts are tests: folding at 75 **octets**
  rather than characters (an Arabic subject is multi-byte, and folding by character count splits one in
  half and arrives as mojibake), and keeping the same UID with a higher sequence when a meeting moves -
  send a new one and the attendee's calendar files a second meeting instead of replacing the first.
- **Resend was dropping what a calendar part needs.** Attachments were mapped without their content
  type, so an `.ics` arrived as a generic download and no mail client offered Accept. Only the calendar
  part changed; the existing test that pins the invoice request byte for byte still passes untouched.
- **We cannot see the answer.** The customer's Accept is an email to the organiser's own mailbox, which
  we do not read, so the screen says "Invited" until a person records it.

### A real Google Meet link, if the salesperson wants one

- **Each person connects their own Google account** (Calendar API, one scope) and the meeting is minted
  in their own diary. Optional throughout: without it everything above still works.
- **Two Google rules decide whether this can work at all**, both confirmed before building: an app left
  in "Testing" has its refresh token expired after seven days, so the consent screen must be published;
  and ordinary Gmail accounts force an "External" app, which until Google reviews it shows a warning
  screen and is capped at 100 connected accounts.
- **Nothing Google does can lose a meeting.** The link is fetched after the booking has committed and
  never throws; a refusal leaves the meeting with whatever link the person typed, and says why.
- **No npm package was added**: four REST calls behind one injectable function, which is also why it is
  proved by tests on a machine with no Google account.

### Writing to a customer from the CRM

- **The letter is written here and kept on the lead's or deal's timeline**, beside the calls, with
  templates, a signature and placeholders filled from what we already hold. A salesperson had to leave
  for Outlook to send one email, and nothing of that conversation came back.
- **It is not two-way email, and no screen implies it is.** There is deliberately no empty "reply"
  field, because one reads as "they have not answered". Reading replies needs either the mailbox
  password over IMAP or Gmail's restricted scope, which carries an annual third-party security
  assessment: a decision to take deliberately, not a feature to slip in.
- **Document sending and CRM letters share one daily allowance.** A second uncounted door would simply
  be the way around the cap.
- **The message goes out before the record is written.** A record written first and a send that then
  fails leaves the timeline claiming something the customer never got.
- **An unknown placeholder is left exactly as written**, so the person proof-reading sees
  `{{customer.trn}}` and fixes it; quietly deleting it would send a sentence with a hole.
- **With no mailbox set up nothing leaves the building, and every screen says "Recorded only."**

### Zarvia AI

An assistant inside the app that answers the questions clients currently ring us about, from our own
product guide, and sends us what it cannot answer. On for every plan, because it exists to cut our
support load and switching it off for a client works against us.

#### The content, which is the project

- **The three Word guides were in no git repository at all.** They are now in `docs/help-source/`, and
  `scripts/help/build.sh` turns them into 132 help topics in `docs/help/` — one per section, each with
  the front matter the loader reads. Four pure steps, so correcting a guide and re-running reproduces
  the corpus exactly.
- **The build refuses to finish if the corpus names any code.** The guides cite files, services and
  tests deliberately ("every statement names the key, function or test it relies on") and a client must
  not read a word of it. With the declassifying step disabled, 43 of the 132 topics name code and the
  build exits 1.
- **The roadmap is withheld from clients.** A status promise made by an assistant is a commitment
  nobody authorised, and several of its rows are now false. Nine topics carry a `review` note where the
  5 October wording has been overtaken — roles and access still says role lists "are not applied", and
  nothing in the corpus mentions the CRM, production or job work.

#### Answering

- **A refusal is explained from the code the API already sends.** `utils/assistantCodes.js` holds 29 of
  them with what happened, why, the first step, and who can actually resolve it — themselves, their
  administrator, or only us. "It will not let me" is the commonest support question there is and it
  needs no model to answer well. A test fails on any code the table explains but the API never sends.
- **Retrieval is a deterministic score, not an embedding**, and it returns NOTHING when the corpus has
  nothing to say. A question about production scores 15 against a topic on approving documents, and
  handing that to a model invites an answer assembled from unrelated documentation. The screen a person
  is on ranks topics but cannot qualify one, so a specific question is answered on its words.
- **The system prompt is pinned to a hash**: it is the control over what the assistant will and will
  not say, so changing it has to be a decision. It gives no tax or accounting advice, promises no
  roadmap or price, invents no feature, never asks for a password, and hands over rather than guessing.
- **It reads no business data in this version**, enforced by there being no tool that could. It answers
  and it points at screens; a link to a screen the documentation does not name is refused twice, once by
  the server and again by the browser.

## 1.4.0.0 — 21 October 2026

Work that had been on branches since 17 October, plus the fixes from a security review of the live
deployment. Frontend 1.4.0.0.

### Security

Found by reviewing the deployed system, and verified against it rather than reasoned about.

- **`req.ip` was a Cloudflare address, not the visitor's — and a different one on each request.**
  `GET /api/v1/health` answered `172.71.*`, `162.158.*`, `104.23.*` on successive calls. Counting proxy
  hops is only right when the number is exactly the number of proxies that append to `X-Forwarded-For`,
  and on Render there is at least one more than the two assumed. So **every per-address limit did
  nothing** — failed sign-ins, failed refreshes, forgot and reset password, console sign-ins, the public
  document link — because the key changed per request; and **every stored address was Cloudflare's**:
  session sign-in records, `PasswordReset.requestedFrom`, share-link views and every audit row. The
  per-account lock-out never depended on the address and was unaffected, which is why this was a loss of
  defence in depth rather than a breach. The address now comes from Cloudflare's own `CF-Connecting-IP`,
  which does not depend on the hop count: Cloudflare writes it and refuses a request that supplies its
  own. `TRUST_PROXY_HOPS` is deliberately **not** raised — past the real number of proxies the client's
  own header would win. Corrected in one place, because there were twelve readers of the address.
  **Note: the limits now work for the first time, so a shared office address shares one allowance.**
- **A list row no longer carries bank details, KYC files or party balances.** The transaction list read
  the parties and items without a projection, so every row held the party's account numbers and IBANs,
  its KYC document references, its credit limit and running balance, and each item's total cost value —
  to anyone who may read the list. `.lean()` skips the schema's `toJSON`, so the projection was the only
  place this could be fixed.
- **Render counts as production even when `NODE_ENV` is missing**, the same rule the seed script already
  used. Keyed on `NODE_ENV` alone, a deployment that lost the variable would have signed every token with
  the development key written in the source.
- **A leftover debug hook is gone** — it appended a line to an unrotated log file outside the repository
  on every trade-document create and update, in production.

### Added

- **Production.** A `ProductionOrder` moves materials out at average cost and brings the finished item in
  at materials plus the expenses that made it, so its sale books the true cost of goods; the moved costs
  are offset by a contra account **in each expense's own group**, so gross profit stays right. Plus **job
  work** (parts sent to an outside worker on a challan, received back finished), **process orders**
  (several steps, each in house or sent out, with the owner's board), saved **routes** per product, costs
  taken from the expense vouchers that paid them, and an analysis of lead time, on-time rate, yield and
  rejects. An opt-in feature: no plan includes it unless an organisation is given it.
- **A CRM.** Leads, opportunities, activities and a configurable pipeline — and **the pipeline moves
  itself**: a quotation sent, accepted or rejected and an invoice approved, cancelled or deleted advance
  the deal or put it back, each move claimed once and recorded. Contacts are the same people as the party
  masters, sharing one id. Plus a communications log, a dashboard, seven reports, a calendar and four
  scheduled checks on the notification feed. Sold per organisation: not in Standard or Trade-only.
- **An in-app notification feed**, with a low-stock trigger and a registry of scheduled checks.
- **The organisation's country decides the tax words** — GST and GSTIN for India, VAT and TRN for the UAE
  — and the UAE VAT return and e-invoicing are refused elsewhere. Starter account names follow, and an
  account created under the old name is renamed in place rather than duplicated.
- **A demo generator** that follows the organisation's own country.

### Internal

- Node 22 pinned (`.nvmrc`, `engines`), a `Dockerfile`, a `render.yaml` describing the intended service,
  and GitHub CI workflows.
- An experiment that hid the backend's address behind the frontend was reverted: a static-site rewrite
  destroys the visitor's IP address, which the limits and the audit trail depend on.

## 1.3.0.0 — 13 October 2026

Modules are now sold per organisation. A customer can be given Sales, Purchase, Inventory and the dashboard and
nothing else, and no one inside that organisation — not even its owner — can reach the rest.

### Added

- **A module is what an organisation BOUGHT, and it is the ceiling every role inside it is capped to.** A plan
  carries a set of modules and an organisation its own overrides (all of it, none of it, or named actions, so
  Reports can be sold without the financial statements). `plans.entitledKeys(org)` turns that into permission
  keys and `identityOf` intersects it with the person's role once per request:
  `grants = capTo(grantsOf(role), entitledKeys(organisation))`. Every route in the API already reads those
  grants through `requirePermission` — only seven routes have no permission, all self-service — so one
  intersection shuts the whole product at once, including for the built-in Owner role, which is every
  permission there is in code. Roles could never be this boundary: a customer's own owner can always grant
  themselves back what a role took away.

- **The cap is applied after `expand()`**, so nothing the customer did not buy leaks in through an implication:
  a sales approver in an organisation without Inventory does not receive `inventory.view`. The item, category
  and unit pick lists such a person needs are reached with `lookups.view`, which those routes already accept.

- **Three things no plan can remove** (`ALWAYS_ON`): the pick lists every form fills itself from, the company
  settings printed on every document, and the dashboard the app lands on. Without them an organisation could be
  sold a product that cannot open a form, print a document or show a first screen.

- **A new plan, Trade only** (`trading`): buying and selling with the stock behind it and no books. The
  documents still post to the ledger — they must, or stock has no cost and an invoice no entry — so the books
  are complete and correct; this customer simply did not buy the screens that read them. Switch Accounts on
  later and the history is all there.

- **Its own refusal.** `403 MODULE_NOT_IN_PLAN` with `details { module, required, plan }` and "Finance is not
  included in this organisation's plan", so a person is not told their role is at fault for a door no
  administrator of theirs can open. It writes no activity row, for the same reason.

- **The role editor cannot offer what cannot be held**: the catalogue is narrowed to the organisation's
  ceiling, and `validateCustomRole` already refused granting beyond what the person making the role holds, so
  custom roles are capped for free. A role built while a module was sold keeps listing and saving afterwards;
  the people on it simply hold none of that module from the next request.

- **The developer console**: `GET /platform/catalog` carries the modules with their actions, an organisation can
  be CREATED with its modules already chosen, and a change applies on the token the customer already holds. The
  organisation's own activity trail names the modules that moved.

## 1.2.0.0 — 12 October 2026

The release that makes it safe to put two paying clients on one deployment. No new customer-facing feature:
it closes the defects that only appear once there is real money and a second organisation.

### Fixed

- **Attachments survive a deploy.** They were written to the server's own disk, which Render wipes on every
  deploy and restart, while the database rows stayed — so a client saw a document in the list and got an error
  on clicking it. They now go to Cloudinary, raw and **private**: the plain address answers 401, and only a
  60-second signed address opens it, fetched on the server and piped so the download keeps its organisation
  check and headers. Existing rows record `storage: "disk"` and are still read from where they are.
- **Production no longer runs under a file watcher.** `npm start` was `nodemon server.js`, and nodemon was a
  production dependency. `start` is `node server.js`, `dev` is the watcher, and moving nodemon to
  devDependencies took three high-severity advisories out of what production installs (5 → 2).
- **The developer console shows the figure the limits are enforced on.** It counted a client's monthly
  documents over UTC's month and included the go-live opening invoices, while the enforcer uses the
  organisation's own month and excludes them — so a client just loaded looked nearly out of documents.
- **A limit no longer offers room a feature gate refuses.** The standard plan printed `branches: 3` but does
  not include `multiBranch`, and the feature is checked first, so all three were unreachable.
- **The dev-server addresses are no longer trusted in production.** With `SameSite=None` cookies, a page on
  someone's own machine could call the live API with their session.

### Also fixed, after a security review of the release

- **The backup's `--as` flag could not do what it claimed** and is gone. It rewrote `companyId` but every row
  kept its `_id`, so restoring a copy beside the original — its only purpose — collided on every row and on
  the globally unique `Admin.email`. Minting new ids would mean rewriting every reference between them, and a
  restore that gets one wrong is worse than none. A restore goes into a database of its own.
- **The export dropped every field a schema hides** — nine of them, `Admin.password` and the two-factor
  secrets among them. Row counts matched, so the first proof passed: the restore produced the right number of
  accounts, none of which could sign in. The paths are read off each schema now.
- `insertMany` on restore is ordered, so a row that will not go in stops the restore instead of leaving gaps.

The review found nothing exploitable. Three of the fixes above are themselves security fixes.

### Added

- **Per-organisation backup and restore** — `npm run backup -- --org <code>` and `npm run backup:restore`.
  One shared database means an Atlas snapshot is every client at once; these take and return one. Every read
  runs inside the tenant scope, so the plugin writes the filter and the script cannot read another
  organisation's rows. See `scripts/backup/README.md`, including how to schedule it and why that cannot live
  inside the server.
- **A start-up warning when no mail provider is set**, because `SYSTEM_MAIL_PROVIDER` defaults to sending
  nothing: "forgot my password" answers the person normally and no mail leaves the building.

### Settings

`ATTACHMENT_STORAGE` (`disk` | `cloudinary`; unset follows whether Cloudinary is configured) is new. The
Cloudinary credentials are now needed before the first upload, and `SECRET_BOX_KEY` must be set **before**
anyone enrols two-factor or their recovery codes become unreadable. No database migration.
