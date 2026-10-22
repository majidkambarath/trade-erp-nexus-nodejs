# Changelog

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
