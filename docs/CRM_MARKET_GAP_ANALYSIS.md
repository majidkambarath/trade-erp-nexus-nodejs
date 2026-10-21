# The CRM against the market: what we have, what we are missing, and what to build

**Written 21 October 2026.** Covers the CRM as it stands on branch `feature/crm` after waves 1 and 2.
For the owner and anyone deciding what to build next. Every claim about our own system cites the file
that proves it; every claim about a competitor says where it came from, and says so plainly when the
source is a review blog rather than the vendor.

> **Update, 21 October 2026 (later the same day): wave 3 is built.** A CRM-only organisation can now be created, qualify a lead,
> open a deal, add its own colleagues, import its spreadsheet and keep files on a lead or a deal. What was done, and two things the
> plan did not foresee, are in the "Wave 3 status" note under section 9. Everything else in this document describes the position
> BEFORE that work, and the matrix in section 4 has not been redrawn: read the "Us" column as of the morning of 21 October.

---

## 1. The short version

We built a good CRM in two weeks and have not yet checked it against what people actually buy. Having
now done that, five things are true.

**One. Our best feature is one almost nobody else has.** The pipeline moves itself from real
documents: a quotation marked sent moves the deal, an approved invoice wins it *at the invoice's own
figure*, and deleting that invoice takes the win back. Every move is claimed once, is undoable, and is
listed on the deal under "How it got here". Zoho, Pipedrive and HubSpot all make the customer *build*
that automation out of rules, and their rules read a CRM field that somebody has to remember to
change. Ours reads the books, so it cannot drift from them. **This is the product. Lead with it.**

**Two. We are missing what a buyer checks in the first ten minutes.** No email at all — no sync, no
send, no templates, no open tracking, no sequences. No web form to capture a lead. No CSV import. No
custom fields. No duplicate merge. No products on a deal. No mobile app. Pipedrive includes import,
merge, custom fields and a products catalogue in its *cheapest* tier, and HubSpot gives email tracking
away free. A buyer who finds four of those missing in the first demo does not reach the part where we
are better.

**Three. There is no AI in it.** In 2026 lead scoring, call summaries and email drafting are described
as table stakes, and the market conversation has already moved past them to agents that act on their
own. Our scoring is a fixed weighted rule (`utils/crm.js:343-367`). That is not purely a weakness —
buyers now ask to inspect a per-action log and 52% require human review before anything goes to
production, and a rule we can explain line by line answers that better than a model we cannot. But
"no AI" will be read as "behind", and on the generative side it genuinely is.

**Four. Nothing global is built yet.** One language, English, with no Arabic and no right-to-left — in
a product whose home market reads right to left. Deal values in the base currency only. No consent
record, no erasure that cascades, no retention rule, one hosting region, no ISO 27001 and no SOC 2.
Europe and the United States are closed to us today for compliance reasons, not feature reasons.

**Five. "Some clients get CRM only" does not work today.** It is one line of code, one plan entry and
a landing rule — about a week — plus one commercial decision that is harder than the code. Section 7.

---

## 2. What we actually have

Read from the code, not from memory.

**Records.** `Lead` (`models/modules/crm/leadModel.js`, series `LD`), `Opportunity`
(`opportunityModel.js`, series `OPP`), `Contact` (`contactModel.js`), `CrmActivity`
(`crmActivityModel.js`) and `CrmStage` (`crmStageModel.js`). Leads, deals and activities are branch
scoped; contacts and stages are organisation-wide masters.

**The join nobody else can make.** `Contact._id` *is* the `_id` of the matching row in
`Customer.contacts[]` / `Vendor.contacts[]`, so the CRM's people and the ERP's party masters are the
same people with no mapping table (`services/crm/contactService.js`, mirrored back through
`PartyMasterService.finish`).

**Qualifying is real.** `LeadService.qualify` creates a true `Customer` through
`CustomerService.createCustomer` — its customer id, its ledger account, the enquirer kept as a contact
— and an `Opportunity` alongside it. Nothing is duplicated and nothing is a stub.

**The automation.** Three events (`utils/crm.js` `EVENTS`): `quotation_sent`, `quotation_accepted`,
`invoice_approved`, wired in from `quotationService.js` and the last line of
`TransactionService.processTransaction`. Each move is claimed once by key
(`"<event>:<documentId>"`), and the other half of the same table undoes it when the document is
rejected, cancelled or deleted — back to the stage recorded on the move, never to the beginning, and
only while the deal is still where that move put it.

**Scoring** (`utils/crm.js:336-367`): source weight, expected value in four bands, contacts made
(capped), a bonus for CONTACTED/QUALIFIED, and decay after 7 / 14 / 30 idle days, clamped 0-100 into
hot / warm / cold. Transparent on purpose.

**Screens** (nine rail modules in its own workspace): Dashboard, Leads, Contacts, Pipeline,
Communications, Follow-ups (with a board, by day or by person, drag and drop), Calendar, Reports and
Setup.

**Reports** — seven, behind one call that four of them share: Pipeline, Lead conversion, Win/loss,
Sales performance, Aging, Deals register, Communications. Aging measures time on the **current
stage**, not record age, which is the right question and one most tools get wrong.

**Watchers**: four scheduled checks (follow-ups due and late, deals gone quiet, enquiries nobody has
touched, quotations about to lapse) on the notification feed
(`services/core/notificationChecksService.js:194-197`).

**Sold per organisation**: permission module `crm` with six actions, in trial / premium / internal,
excluded from standard and trading.

**40 routes**, all permission-gated (`routes/crm/crmRoutes.js`).

---

## 3. Who we are compared with

| Product | What it is | Where it hurts us |
| --- | --- | --- |
| **Zoho CRM** | The value leader. Several hundred features, custom modules, Blueprint, CPQ, Zia AI, webforms, WhatsApp, Desk, Campaigns. | Depth and customisation. A Zoho demo answers "can it do X" with yes, every time. |
| **HubSpot** | Marketing-led, free tier with unlimited contacts, email tracking and meeting links. Betting heavily on agentic AI. | The free tier. A prospect can be using it this afternoon at no cost. |
| **Pipedrive** | Pure sales pipeline, cheapest tier already includes import, merge, custom fields, products, API, mobile. | It is the honest comparison for us, and it beats us on basics. |
| **Salesforce** | Enterprise. Territories, forecasting, 9,000+ integrations, heavy setup. | Not our buyer, but it sets what "a CRM has" means. |
| **Odoo CRM** | The other ERP-with-a-CRM. Won opportunity becomes a quotation in Odoo Sales. | The closest shape to ours, and the direct competitor in our segment. |
| **Freshsales / Bigin** | SMB price point. Freshsales advertises 150+ currencies and 10+ languages. | Price and global basics. |
| **Frappe CRM** | Standalone, open source, integrates with ERPNext. | See below. |

**One signal worth reading twice.** Frappe's own documentation marks ERPNext's built-in CRM module
*deprecated and scheduled for complete removal in version 17*, and tells new users to evaluate the
standalone **Frappe CRM** instead. The other serious open-source ERP has concluded that a CRM bolted
inside an ERP loses to a focused one. That is not an argument against what we built — our integration
is deeper than theirs ever was, and it is the part they could not make pay. It *is* a warning: the
integration has to be the product, not a feature list we half-match.

---

## 4. The feature matrix

| | Us | Zoho | HubSpot | Pipedrive | Odoo |
| --- | --- | --- | --- | --- | --- |
| Pipeline board, configurable stages | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Pipeline moved by real documents** | ✅ **audited, undoable** | rules | rules | rules | partial |
| Deal probability / weighted value | ✅ | ✅ | ✅ | ✅ | ✅ |
| Named reports + dashboard | ✅ 7 | ✅ | ✅ | ✅ | ✅ |
| Custom report builder | ❌ | ✅ | ✅ | ✅ | ✅ |
| Aging on *current stage* | ✅ | partial | partial | ✅ rotting | ❌ |
| Lead → customer with ledger account | ✅ | ❌ | ❌ | ❌ | ✅ |
| Account / company record | ❌ string only | ✅ | ✅ | ✅ | ✅ |
| Contacts shared with ERP masters | ✅ **same id** | n/a | n/a | n/a | ✅ |
| Products / line items on a deal | ❌ | ✅ + price books + CPQ | ✅ | ✅ | ✅ |
| Quote raised from a deal | ❌ (ERP side only) | ✅ | ✅ | ✅ | ✅ |
| Custom fields | ❌ | ✅ + custom modules | ✅ | ✅ cheapest tier | ✅ |
| Multi-currency on a deal | ❌ | ✅ | ✅ | ✅ | ✅ |
| CSV import | ❌ | ✅ | ✅ | ✅ cheapest tier | ✅ |
| Duplicate detect / merge | ⚠️ warns only | ✅ merge | ✅ | ✅ cheapest tier | ✅ |
| Attachments on a lead/deal | ❌ | ✅ | ✅ | ✅ | ✅ |
| Email two-way sync | ❌ | ✅ | ✅ | ✅ | ✅ |
| Send email from the CRM | ❌ | ✅ | ✅ | ✅ | ✅ |
| Templates / open & click tracking | ❌ | ✅ | ✅ **free** | ✅ | ✅ |
| Sequences / cadences | ❌ | ✅ | ✅ | ✅ | partial |
| Web-to-lead form | ❌ | ✅ | ✅ | ✅ add-on | ✅ |
| WhatsApp | ⚠️ a source value only | ✅ | partner | partner | partner |
| Telephony / click-to-call | ❌ | ✅ | ✅ | ✅ | ✅ |
| Call transcription / summary | ❌ | ✅ | ✅ | ✅ | ❌ |
| Meeting scheduler link | ❌ | ✅ | ✅ **free** | ✅ | ✅ |
| Workflow rule builder | ⚠️ stage table | ✅ Blueprint | ✅ | ✅ | ✅ |
| Approval process | ❌ (ERP has one) | ✅ | ✅ | ❌ | ✅ |
| Forecast / quotas / territories | ❌ | ✅ | ✅ | ⚠️ forecast view | partial |
| AI scoring / drafting / next action | ❌ | ✅ Zia | ✅ Breeze | ✅ | partial |
| Service tickets | ❌ | ✅ Desk | ✅ | ❌ | ✅ |
| Campaigns / mass email | ❌ | ✅ | ✅ | add-on | ✅ |
| Native mobile app | ❌ PWA | ✅ | ✅ | ✅ | ✅ |
| Field-level security / sharing rules | ⚠️ module + role | ✅ | ✅ | ✅ | ✅ |
| GDPR consent / DSR / retention | ❌ | ✅ | ✅ | ✅ | partial |
| Data residency choice | ❌ one region | ✅ | ✅ | ✅ | ✅ |
| UI languages | ❌ 1 | ✅ many | ✅ many | ✅ many | ✅ many |
| Marketplace / prebuilt connectors | ❌ | ✅ | ✅ | ✅ 500+ | ✅ |

---

## 5. The gaps, and what each one costs us

### Blockers — a deal is lost in the demo

**No CSV import.** Every prospect has a spreadsheet of leads. Without an import there is no first day.
This is the cheapest item on the list and the most expensive to be without.

**No email, anywhere.** Not sync, not send, not a template, not a tracked open. A salesperson's day is
email; a CRM that cannot see it records half the relationship and asks them to type the other half in
twice. This is the single largest gap and the main reason a CRM gets abandoned after a month.

**No web form.** "Where do leads come from?" has one answer today: somebody types them in.
`LEAD_SOURCES` lists `website` but nothing on earth writes it.

**No custom fields.** Every business has one field that matters to it and to nobody else. Without
custom fields the answer to "can it track X" is no, forever, and the salesperson types X into Notes.

### Serious — we look thin beside the cheapest competitor

- **No products or line items on a deal.** `Opportunity.value` is one number. So no quote from a deal,
  no forecast by product, no "what do we actually sell".
- **No multi-currency on a deal.** Values are in the organisation's base currency. A Dubai company
  selling into India, Africa and Europe cannot state a deal in the customer's money. Freshsales
  advertises 150+.
- **No account/company record.** `Lead.company` is a string; a deal needs a real `Customer`. So a
  prospect organisation with three people you are talking to cannot be held as one thing until it is
  qualified into a customer.
- **No duplicate merge.** `/crm/leads/duplicates` finds them; nothing joins them.
- **No attachments.** The signed quotation, the site photo, the spec sheet live in somebody's email.
- **No WhatsApp**, in a product sold in the UAE and India where it is the main sales channel. It is a
  value in two enums and nothing else.
- **No telephony, no meeting link, no sequences.**

### Strategic — they decide which markets we can enter at all

- **No AI.** Table stakes in 2026, and the market has moved on to agents.
- **No GDPR machinery.** No consent record (source, date, scope), no lawful basis, no erasure that
  cascades through deals, activities and contacts while leaving an anonymised proof it happened, no
  retention rule, no subject-access export. Europe is closed.
- **One hosting region.** EU buyers increasingly require EU-hosted data.
- **No ISO 27001, no SOC 2, no penetration test.** These are asked in procurement questionnaires, and
  a pen-test question appears in most of them whether or not a certificate does.
- **One language, no RTL.** We localise *tax words* by country (`utils/countryRules.js`) but not the
  interface. Arabic is not supported in a UAE-first product.
- **No marketplace or prebuilt connectors.** 72% of buyers in one 2026 survey rate a prebuilt
  connector ecosystem very important or a must-have. We have an API and no listings.

### Deliberate, and worth defending

- **No drag-and-drop stage changes** — a deal moves because a document moved or because a person
  recorded a reason. Defend this; do not "fix" it.
- **No user-programmable rule builder** — the stage table *is* the configuration. Defensible for a
  long time. Revisit when a real client is genuinely blocked, not before.
- **No campaigns or mass email.** Marketing automation is a different product. Say no.

---

## 6. Where we are genuinely ahead

Worth stating plainly, because it is what the price is for.

1. **The pipeline moves itself from the books, and can prove it.** Every automatic move names the
   document that caused it; a move taken back stays on record, marked. No competitor's rules engine
   can make that claim, because their rules read CRM fields, not posted documents.
2. **Won at the invoice's own total**, not at somebody's estimate. The forecast and the accounts
   cannot disagree.
3. **One set of people.** A contact is the same record in the CRM and in the customer master, under
   one shared id. Everyone else syncs two systems and lives with the drift.
4. **Qualifying creates a real customer with a real ledger account** in one step.
5. **Aging measured on the current stage**, with a close date already past surfaced separately.
6. **The automation refuses to guess.** Two open deals for one customer and an invoice arrives: it
   moves nothing and tells a person. That restraint is rarer than it sounds.
7. **Reporting breadth at this age** — seven named reports, a board, a calendar and a dashboard.

---

## 7. The CRM-only problem

You want to sell the CRM alone to some clients. Today you cannot. Two reasons, one small and one
large.

### The small one: a single line of code

`controllers/crm/crmController.js:90`

```js
assertPermission(req, "sales.create", "qualifying a lead creates a real customer");
```

An organisation that did not buy the Sales module cannot qualify a lead — the one action the product
exists for. It fails with 403 `PERMISSION_DENIED`.

Alongside it: there is **no CRM-only plan** in `utils/plans.js` (trial, standard, premium, trading,
internal — `standard` and `trading` exclude CRM and none is CRM-alone), and a CRM-only organisation's
owner still lands on the ERP dashboard and is offered a switch into a near-empty ERP half.

All of that is about a week: a plan entry with its byte-for-byte mirror in
`zarvia-platform/packages/domain/src/plans.ts` (the parity suites deep-equal every export), the
permission change, and the landing rule in `src/config/navigation.js`. Note that the customer and its
ledger account will still be created underneath — module caps are applied to routes, not to services,
the same rule that keeps posting working — which is correct and invisible.

### The large one: what moves a CRM-only client's pipeline?

All three automation events are ERP documents. A CRM-only client raises no quotation and approves no
invoice, so the automation never fires. They get a board they move by hand — which is Pipedrive
without the email, the forms, the import or the mobile app.

**So CRM-only is not a discount on the same product. It is a weaker product, and it must be sold and
priced as one.** Two honest routes:

- **(a) Give the CRM its own lightweight quotation** so the automation still fires for a CRM-only
  client. Keeps the argument intact; risks a second quotation concept in a codebase that already has
  one, and needs line items on a deal first.
- **(b) Sell CRM-only as a hand-moved pipeline**, and make the automation the stated reason to add the
  ERP. No work now, weaker product, and a natural upgrade path that sells the thing we are better at.

**Recommended: (b) immediately, (a) in wave 4** — line items on a deal are needed for both, so they
arrive together.

---

## 8. Going global: what each market will actually ask for

You named all three. They are not the same amount of work and should not be attempted at once.

**Gulf, India, wider Asia and Africa — open now; feature-led.** Same SMB shape we already serve.
Priorities: WhatsApp, Arabic and RTL, multi-currency on deals, per-country tax packs (India's real GST
is already named as the next step in the country work). No certification needed to sell.

**Europe and the UK — closed until the compliance work is done.** Consent recorded with its source,
date and scope; pre-ticked boxes are not consent; withdrawal that takes effect everywhere at once;
erasure that cascades through every related record and leaves an anonymised audit row proving it
happened without keeping the data; a subject-access response inside 30 days; retention rules that flag
or remove stale data; and, in practice, EU-hosted data. ISO 27001 is the certificate European and
public-sector procurement asks for.

**The United States — the heaviest.** SOC 2 Type 2 is the default ask from North American buyers, and
the expected feature set is Salesforce-shaped: forecasting, territories, custom fields, a long
integration list. SOC 2 and ISO 27001 share perhaps 70-80% of their controls, so the second is much
cheaper than the first, but a questionnaire asking for SOC 2 Type 2 is not satisfied by an ISO
certificate or the reverse.

**Recommendation: sell where you already are while building the foundations that open Europe; treat
the United States as a 2027 decision.** "Anywhere that will buy" is a position, not a plan — the
compliance work is sequential and the feature work is not, so pick the order deliberately.

---

## 9. The roadmap

Sizes assume this codebase's standards: pure rules, a service, database tests, an HTTP test,
`check:mobile` steps, and the zarvia-platform parity mirror wherever `plans.js` or `permissions.js`
move.

### Wave 3 — make "CRM only" real (1-2 weeks)

Do this first. It is revenue already promised.

| Item | Note |
| --- | --- |
| A `crm` plan + parity mirror + console panel | `utils/plans.js`, `packages/domain/src/plans.ts` |
| Qualify without the Sales module | `crmController.js:90` → `crm.create` |
| CRM-only landing and workspace | `offeredWorkspaces` / `landsElsewhere` |
| **CSV import of leads and contacts** | the onboarding blocker |
| Attachments on a lead and a deal | reuse `services/core/attachmentService.js` |
| Decide (a) or (b) from section 7 | commercial, not technical |

**Wave 3 status (built 21 October 2026, branch `feature/crm-standalone`).**

| Item | Done |
| --- | --- |
| A `crm` plan + parity mirror + console | Yes: "CRM only", the CRM plus its own people and settings, nothing of the trade; 427/427 parity |
| Qualify without the Sales module | Yes: asks `sales.create` where Sales was bought, `crm.create` where it was not |
| CRM-only landing and workspace | Yes: no ERP half to switch into; `/dashboard` lands on the CRM dashboard |
| CSV / Excel import of leads and of people | Yes: previewed first, never written by accident, safe to run twice, audited without the rows |
| Attachments on a lead and a deal | Yes: the CRM's own door onto the existing storage; another module's file id is a 404 |
| Decide (a) or (b) from section 7 | (b), as recommended: a hand-moved pipeline now; (a) comes with line items in wave 4 |

**Two things the plan did not foresee, found by reading the code and then proved by test.** First, qualifying was not the only
blocker: the new-deal form chose its customer from the Sales customer master, so a CRM-only person could not open a deal either; it
now reads a narrow CRM-owned list (an id, a name, a code, nothing of the customer's money). Second, the owner of a CRM-only
organisation had no way to add colleagues, because People lives in the ERP rail they are not offered: Users and roles is now also a
Team tab under CRM Setup. Also: Settings no longer offers "Business rules" and "Invoice bank details" to an organisation that makes
no invoice.

**How it was checked.** Eight of the rules above were broken one at a time on a copy of the backend and each was caught by the test
that names it (qualify always asking Sales, the customer list leaking the whole customer, the file door opening any module's file, an
import writing without being asked, duplicates not noticed, deleting a lead leaving its files, an import creating a task per lead,
and the permission rule itself). The new screens were also driven in a real browser at phone, tablet and desktop width, which found
and fixed one layout fault: the deal page was wider than a phone because of a long file name. Not yet covered by any test, and said
plainly: a CRM-only organisation's day-to-day use over weeks, and a person choosing a real file on a real phone.

### Wave 4 — pass the ten-minute test (4-6 weeks)

| Item | Note |
| --- | --- |
| **Email: sync, send, templates, tracking** | reuse `services/messaging/providers.js` and the `DocumentSend` retry pipeline; do not build a second one |
| WhatsApp thread on a contact | reuse the handoff and `toWaNumber`; add a BSP provider beside `resend` / `smtp` |
| Web-to-lead capture + embeddable form | model on `shareRoutes.js`: own router, no auth, rate-limited, whitelisted fields |
| Custom fields on lead / deal / contact | with list columns and export |
| Multi-currency on a deal | stamp value, currency and rate as `fxVoucherService` already does |
| Duplicate merge | the detector already exists |
| Products / line items on a deal | unlocks quote-from-deal and route (a) |

### Wave 5 — open Europe (6-10 weeks, mostly not code)

GDPR pack (consent, lawful basis, cascading erasure with anonymised proof, retention, DSR export) ·
i18n framework and Arabic RTL · a second region/cell (`zarvia-platform/docs/scaling.md` anticipates
it) · ISO 27001 first, then SOC 2 Type 2, plus a penetration test.

### Wave 6 — differentiate (4-8 weeks)

AI on the Claude API — deal summary, next best action, email drafting, call notes, a real scoring
model — **with a per-action log**, because that is what 2026 buyers ask to inspect, and keeping the
explainable rule beside it · forecast and per-rep targets · service tickets · native mobile or a
genuinely offline PWA.

### Say no to, for now

Campaigns and mass email · a user-programmable rule builder · territories · drag-and-drop stage
changes · competitor tracking · AI that acts without a person.

---

## How far to trust the matrix in section 4

Read from the vendor's own page: **Zoho CRM** (complete feature list), **Pipedrive** (features by plan) and
**Frappe/ERPNext** (CRM documentation). Everything else is from review and comparison sites, several
written by vendors or their partners: the **HubSpot**, **Salesforce** and **Odoo** columns, the
**Freshsales** currency/language claim, the WhatsApp market picture and the AI buyer statistics.

Some cells are also my own judgement, not a sourced fact. Examples are "rules" for how competitors
automate a pipeline, "partial" in the Odoo column, and "partner" for WhatsApp. Treat those as directional.
Before putting any single cell in front of a customer or investor, check it against that vendor's page.
Our own column is different: it was read from our code and is accurate as of 21 October 2026.

---

## 10. Sources

Vendor documentation, used where it exists:
[Zoho CRM complete feature list](https://www.zoho.com/crm/crmplus/complete-feature-list.html) ·
[Pipedrive features by plan](https://support.pipedrive.com/en/article/what-features-do-the-pipedrive-plans-have) ·
[ERPNext CRM deprecation](https://docs.frappe.io/erpnext/CRM.md) ·
[Frappe CRM with ERPNext](https://docs.frappe.io/crm/erpnext.md) ·
[Freshsales multi-currency and multi-language](https://freshworks.com/crm/features/multi-currency-multi-language)

Analyst and survey material:
[G2 2026 AI Agents Insight Report](https://sell.g2.com/g2-2026-ai-agents-insight-report) ·
[Futurum on HubSpot's agentic AI bet](https://futurumgroup.com/insights/can-hubspots-agentic-ai-bet-disrupt-enterprise-crms-old-guard/) ·
[Bigin: CRM trends 2026-27](https://www.bigin.com/articles/seven-crm-trends-that-will-define-2026-and-2027.html)

Compliance (practical guidance, not legal authority — verify before relying on it):
[GDPR and CRM compliance 2026](https://www.vyrocrm.com/en/blog/gdpr-crm-compliance-guide-2026) ·
[CRM GDPR UK guide](https://bespoke-crms.com/blog/crm-gdpr-uk-business-compliance-guide-2026) ·
[SOC 2 vs ISO 27001](https://www.hicomply.com/blog/soc-2-vs-iso-27001) ·
[SOC 2 for B2B vendors](https://www.konfirmity.com/framework/soc-2)

Review and comparison material (secondary, treat as directional):
[Zoho CRM feature breakdown](https://pipeline.zoominfo.com/sales/zoho-crm-features) ·
[Pipedrive feature breakdown](https://pipeline.zoominfo.com/sales/pipedrive-features) ·
[HubSpot Sales Hub review](https://saleshive.com/vendors/hubspot-sales-hub) ·
[Salesforce / Zoho / HubSpot / Pipedrive compared](https://blog.salesflare.com/compare-salesforce-zoho-hubspot-pipedrive) ·
[Odoo CRM module guide](https://ecosire.com/guides/odoo/crm) ·
[WhatsApp CRM in the UAE](https://chatdaddy.tech/blog/whatsapp-crm-uae) ·
[WhatsApp CRM for Indian small business](https://meseji.app/blog/whatsapp-crm-for-small-business-setup-features-benefits-in-2026)

Pricing and tier details move constantly and several sources above are vendors or their partners.
Confirm anything you intend to put in front of a customer against the vendor's own pricing page.
