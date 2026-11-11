# ABC TRADE demo generator: the parity oracle

These scripts build a realistic UAE trading company's books **through the product's own HTTP API**, never the
database: masters, chart of accounts, a go-live position, then day-by-day trading with every flow the product has
(sales and purchases with returns, receipts and payments, cheques both ways, card sales and settlements, bank
reconciliation, expenses, journals, quotations and delivery notes).

They exist for two reasons:

1. **A realistic dataset** for demos, screenshots and the mobile and end-to-end sweeps.
2. **The acceptance oracle for the PostgreSQL migration** (Phase 2 plan, "Verification"). Run the same story
   against the MongoDB system and the PostgreSQL system, then compare trial balance, profit and loss, VAT 201,
   stock valuation and ageing **to the fils**. Costing, pricing and VAT are shared pure code, so any difference in a
   figure is a data-layer difference and has nowhere else to hide.

All names, phone numbers, TRNs and IBANs are fictional (IBANs carry a valid checksum). Any resemblance to a real
business is coincidental.

## Safety

- It **writes** to whatever `BASE` points at, as the account in `E` / `P`. Point it at a development or
  throw-away backend only, never at a client's organisation or at production data.
- It does not create the organisation or its administrator. Create the organisation first (developer console)
  with an active administrator who has **two-factor off**; sign-in is refused otherwise.
- Nothing here is part of the deployed product, and `npm test` does not load it.

## Run

From this folder. Environment: `E` (administrator email), `P` (password), `BASE`
(default `http://localhost:3000/api/v1`). Node 18+ (it uses the built-in `fetch`); no packages to install.

| Step | Command | Notes |
| --- | --- | --- |
| 1. Masters, chart, go-live position (1 Jan 2025) | `node abc-setup.cjs` | Idempotent: looks first, creates only what is missing |
| 2. Company letterhead | `node abc-profile.cjs` | Optional |
| 3. Trading, day by day | `UNTIL=2026-10-09 node abc-trade.cjs` | Resumable, see below |
| 4. Bank and card reconciliation | `KEY=enbd ASOF=2025-12-31 node abc-recon.cjs`, and `KEY=rak ASOF=... CARD=1 node abc-recon.cjs` | `DRY=1` plans without posting |
| 5. Treasury for 2026 | `DRY=1 node abc-treasury.cjs`, then again without `DRY` | Fixed window 2026-01-01 to 2026-10-09 |
| Check (read-only) | `ASOF=2026-10-09 node abc-check.cjs` | Is the trial balance balanced? Does stock agree with the ledger? |

**Not scripted: closing a fiscal year.** No script here closes one. In the reference run FY2025 was closed separately,
through the product's year-end close (`POST /accounting/fiscal-years/:id/close`). The parity harness needs
that step scripted, because the closing-entry rule is the most intricate rule in the reports.

### Stopping and resuming

`abc-trade.cjs` keeps the day, the random-number state and everything open (invoices, cheques, stock) in
`abc-state.json`, and continues from there. Create a file named `abc-stop` next to the scripts to stop cleanly at the
end of the current day, which is how you stop at a year end to reconcile and close, then carry on with a later
`UNTIL`. The state file holds ids of records in the organisation that was built: delete it only together with that
organisation's data. `abc-state.json`, `abc-build.log` and `abc-stop` are git-ignored.

## Determinism

- Random choices come from a seeded generator (`rng` in `abc-lib.cjs`): the same seed tells the same story.
- The one wall-clock input is quotation validity. `TODAY=YYYY-MM-DD` pins it; otherwise it is the real date.
- The engine **reacts to what the server answers** (stock on hand, open invoices, a refusal). A run is therefore
  deterministic *given the same server behaviour*, and a difference in behaviour between two systems shows up as a
  different story. That is the point of using it as an oracle.
- Server-generated ids and timestamps differ from run to run. Compare figures and document numbers, not ids.

## The existing `abc` organisation is not a clean baseline

The build notes of 10 Oct 2026 record 81 refused documents in that run: 77 from a receipt-rounding bug that has
since been fixed, and 3 from a development-server restart. A fresh run on the frozen 1.1.0.3 produces slightly
different totals. **Use a fresh run on both systems as the baseline, not the books already in that organisation.**

For orientation only, the same notes record the 1 Jan 2025 to 9 Oct 2026 run as 254 sales, 168 purchases, 259
receipts, 162 payments, 180 expenses and 78 journals.

## Files

| File | Role |
| --- | --- |
| `abc-lib.cjs` | API client (signs in again when the token ages out, retries network faults, server errors and write conflicts but never a business refusal), seeded random source, state file, IBAN builder |
| `abc-data.cjs` | Who the company deals with and what it sells |
| `abc-setup.cjs` | Phase 1: masters, chart, go-live position |
| `abc-trade.cjs` | Phase 2: the trading engine |
| `abc-recon.cjs` | Bank reconciliation to a date, and card settlement for the collection account |
| `abc-treasury.cjs` | 2026 cash moves between the company's own accounts and an owner's capital injection |
| `abc-check.cjs` | Read-only trial balance and stock-against-ledger check |
| `abc-profile.cjs` | Sets the company letterhead |

---

# A workshop's month, into an organisation that already exists

`workshopDemo.js` and `wipeOrgData.js` are a pair, and newer than the `abc-*` engine above. They exist
because that engine cannot do this job: it drives the HTTP API and hardcodes 2025–2026 dates in
fourteen places across five files, and it builds a *trading* company. `garageDemo.js` is the right
domain but makes its own organisation, writes **no vouchers at all**, buys once, and lands everything
at wall-clock now.

These two call the real services in process, as `garageDemo.js` does, with every document placed on a
day you choose.

```bash
node scripts/demo/wipeOrgData.js  --env=.env.<client> --org=<code>                               # shows the plan
node scripts/demo/wipeOrgData.js  --env=.env.<client> --org=<code> --yes                         # does it
node scripts/demo/workshopDemo.js --env=.env.<client> --org=<code> --from=2026-11-01 --to=2026-11-11 --yes
```

Both refuse without `--yes`, refuse an implied organisation, refuse `NODE_ENV=test`, and take
`--expect-host=` so a mistyped env file cannot reach the wrong cluster.

## What the seed writes

Masters (16 parts, 4 vendors, 12 customers + 2 insurers, 12 vehicles, 4 staff), then a capital
introduction journal, 12 purchase invoices, 18 job cards across **all six** statuses, 10 insurance
claims each billed to the insurer *and* the customer, **10+ of every voucher type** (receipt, payment,
journal, contra, expense, credit note, debit note), 6 sales returns, 6 purchase returns and 10
quotations. Roughly 250 records.

Sequential on purpose: the number-series counter is one row per series, the party ledger balance one
row per party and the `Stock` cost pool one row per part, so parallel approvals contend on all three
and burn the eight retries of `utils/withTransactionSession.js`.

Idempotent — a second run writes nothing. There is no `--undo`: a job card past DRAFT cannot be
deleted and a statutory number is never recycled. That is what `wipeOrgData.js` is for.

## Four rules this seeder had to learn, each from a failed run

- **`Voucher.createdBy` is an ObjectId**, while `Transaction.createdBy` and `JobCard.createdBy` are
  strings. Vouchers are attributed to a real administrator.
- **Nothing may credit Inventory Stock by journal.** It writes stock down with no movement behind it,
  and `StockReportsService.ledgerCheck` then reports the gap as *"posted to the ledger by hand; no
  stock movement stands behind them"*. Stock leaves through a document or a stock adjustment.
- **Buy every part before anything sells it**, or an item ends the month on hand below zero.
- **Cash cannot go negative.** Paying 18,000 rent out of the till is how that happens: small things go
  to petty cash, rent and the licence go by bank, and the petty top-ups must exceed the petty spend.

## What the wipe means by "wiped"

*Back to exactly what `scripts/setup/garageClient.js` produces* — so it is checkable, and the script
prints the counts against the expected figures rather than claiming success.

It deletes every document, voucher, ledger entry, movement, job card, claim, party and — the part
people forget — the **number counters** (`numberseries`, `issuednumbers`, `sequences`), so the next
document issued is 0001 of its series rather than 0047. It also removes the `Customer - …` / `Vendor
- …` **party ledger accounts**, which `services/financial/partyAccounts.js` creates on demand and
which otherwise outlive the parties and sit in the chart for ever.

It keeps the chart, the labour service items, bays, the service menu, roles, tax codes, units,
voucher types, settings and the fiscal year. It is an **allowlist**, not a delete-list: a collection
nobody thought of defaults to being removed rather than quietly surviving into the client's books.

A `scripts/backup/export.js` dump is taken first unless `--no-backup`.

**This is the right tool for demo data and the wrong one for real books.** It does not reverse
anything in accounting terms; it deletes.
