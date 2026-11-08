# Setting up a live client

Nothing here is part of the deployed product. These scripts take an **empty database** to an
organisation a client can sign into and work in. They go through the real services — the same path the
developer console uses — so every record is the one the app would have written itself.

Not to be confused with `scripts/demo/`, which fills an organisation with believable *documents* for a
demonstration. A paying client starts with empty books.

## `garageClient.js` — a UAE workshop

```bash
node scripts/setup/garageClient.js --env=.env.golden-arrow --code=golden-arrow --yes
```

Without `--yes` it prints what it would do and stops. **Safe to run twice**: the organisation is
reused and every account, unit, item, bay, service and role is skipped if it already exists, so a
half-finished run is fixed by running it again.

| Flag | |
| --- | --- |
| `--env=<file>` | env file to load, relative to the repo root. Default `.env` |
| `--code=<slug>` | the organisation code. **Stamped on every record and locked forever** |
| `--name=` / `--trade=` | legal and trade name (placeholders by default; corrected later in Settings) |
| `--admin=` / `--admin-name=` | the owner's sign-in |
| `--plan=<code>` | default `standard` |
| `--docs-limit=<n>` | cap documents a month. **This only ever LOWERS it** — `standard` already allows 2000 |
| `--features=a,b` | extra feature overrides, e.g. `reconciliation,ifrsStatements,multiBranch` |
| `--expect-host=<host>` | refuse to run unless `MONGO_URI` names this host |
| `--yes` | actually do it |

### What it creates

1. **Collections and indexes** (`runMigrations`) — on an empty cluster this is what creates the
   per-organisation unique indexes, the uniqueness that stops two documents sharing a number. So the
   cluster needs no server boot first.
2. **The organisation**, `country: "AE"`, `baseCurrency: "AED"`, `timezone: "Asia/Dubai"`, with
   `moduleOverrides: { garage: true }` — garage is an opt-in vertical that **no plan carries, not even
   `internal`**. Provisioning then gives the posting map, the AED currency, the fiscal year, the five
   **UAE** starter tax codes, the starter units and the 41-account default chart.
3. **13 chart accounts** a workshop needs and the default chart lacks — Labour Income, Sublet &
   Outside Work Income, Consumables & Shop Supplies Recovered, Recovery & Towing Income; Sublet &
   Subcontract Charges, Consumables & Shop Supplies, Paint & Body Materials, Workshop Wages -
   Technicians; Tools & Equipment Maintenance, Waste Oil & Waste Disposal, Workshop Insurance, Trade
   Licence & Government Fees; Workshop Tools & Equipment.
4. **Units** Hour and Job (the starter set is Each / Kilogram / Litre only, and the UOM category enum
   has no "Time", so an hour is filed under Quantity) and a **Workshop Services** category.
5. **7 labour and sublet items** as `itemType: "service"`, each naming its own `incomeAccountId`.
6. **5 bays** and a **7-entry service menu** with default tasks.
7. **3 custom roles** — Service advisor, Workshop manager, Technician.

### Why these accounts are client data, not a product change

`utils/defaultChart.js` is the chart **every** new organisation starts with; a food trader does not
want "Paint & Body Materials". It is also parity-mirrored in
`zarvia-platform/packages/domain/src/defaultChart.ts`. And no posting **key** is added: a labour line
reaches its account through the service item's own `incomeAccountId`, which
`utils/itemKinds.js routeServiceLegs` honours, so `utils/accountConfigSeed.js` and its mirror are
untouched as well.

If a second garage client arrives, lift the `ACCOUNTS` table out of this script into something shared
rather than copying the file.

### Three things the script prints, and means

- **Technician wages.** HRMS payroll posts to `Salaries & Wages` through the `salary-expense` key. To
  make them land in *Workshop Wages - Technicians* and show inside gross profit, remap
  `salary-expense` in Accounting setup → Posting accounts, or move it with a monthly journal. The
  script does not remap it: that decision affects all payroll, not only the workshop's.
- **`SHOP-SUP` is billed on a *labour* line.** A job-card line's `kind` is one of
  `part | labour | sublet | consumable`, and `jobCardService` checks it against the item master —
  `part` and `consumable` need a **goods** item, `labour` and `sublet` need a **service** item, else
  `400 LINE_KIND_MISMATCH`. A true `consumable` line needs a stocked item from the client's own parts.
- **A standard job fills in the labour and the tasks but no parts.** `defaultParts` is left empty
  because the parts catalogue is the client's own. Worth knowing: the Setup screen's dialog **cannot
  set `defaultParts`, `defaultTasks` or `appliesTo` at all** — only the API can, which is why the
  service menu is seeded here rather than clicked.

### Roles, and why they carry a Sales key

Only `super_admin` (Owner) and `admin` (Administrator) hold **any** `garage.*` permission; Manager,
Accountant, Operator, Sales, Purchase, Storekeeper and Viewer hold none. So a workshop's own people
need custom roles.

`garage.invoice` is not enough on its own: `controllers/garage/jobCardController.js:104` asserts
**`sales.create`** for "raise the invoice from a job card", and `:114` asserts **`purchase.create`**
for "raise a purchase order". Without them those two buttons answer 403. Hence:

| Role | Rank | Keys |
| --- | --- | --- |
| Service advisor | 40 | `garage.view/create/edit/approve/invoice`, `sales.create` |
| Workshop manager | 60 | all seven `garage.*`, `sales.create`, `purchase.create`, `inventory.view` |
| Technician | 20 | `garage.view` — task start and complete are gated on it, and `assertMayWorkTask` lets a technician always work the task they were given |

### Where the client's credentials live

**Not in `.env`.** `npm test` creates and drops throwaway databases on whatever cluster `MONGO_URI`
names, so a client's URI in `.env` means the next test run writes to their production cluster — and it
cuts your own access to the other clients' books.

One gitignored file per client, `.env.<client>`, loaded with `--env`. `.gitignore` carries `.env.*`
for exactly this; check it before you start:

```bash
git check-ignore -v .env.golden-arrow     # must print a .gitignore match
```

Keep the `mongodb+srv://` form — a legacy seed-list URI fails the TLS handshake on shared-tier Atlas
with what looks like a certificate error but is not.

### Before this script, once per cluster

```bash
node -r dotenv/config utils/platformSetup.js dotenv_config_path=.env.<client>
```

The developer-console account. There is no default one, and nothing can create an organisation
without it. 12+ characters, letters and digits. **Make a second console account too** — one account
plus one lost 2FA phone has shut the console for good before.

**Do not run `npm run seed`**: it creates a `super_admin` in the internal `default` organisation, not
the client's. The client's owner comes from this script's `firstAdmin`.

In production the server refuses to start without `MONGO_URI` and a `JWT_SECRET` of 32+ characters.
Two warnings worth treating as errors: **`SECRET_BOX_KEY` must be set before anyone enrols in
two-factor** (without it the 2FA secrets and recovery codes are keyed off `JWT_SECRET`, and setting it
later invalidates every recovery code), and `SYSTEM_MAIL_PROVIDER=console` means "forgot my password"
answers normally and sends nothing.

### After this script, by hand

1. Settings → Company: real legal name, trade name, address, logo.
2. Settings → Business rules → Tax identity: the **15-digit TRN** and the **emirate**. The VAT return
   reads `profile.emirate`; the Company tab's emirate is cosmetic, for the letterhead. Until the TRN is
   set, an approved sale prints **"Invoice"**, not **"Tax invoice"**.
3. First sign-in as the owner (`mustChangePassword` forces a new password), then two-factor.
4. People: the real users, on the three roles above.
5. Parts, customers, insurers (tick **Insurer**) and staff: the client's own.
6. Opening balances, if they are moving from existing books — the first entry fixes the go-live date.
7. Schedule `npm run backup` against this cluster and **rehearse one restore**.

An insurance claim lazily creates two service items, `INS-EXCESS` and `INS-DEPR`, which default to
`sales-revenue`. Point them at an account of your choice after the first claim if the client wants the
excess and the depreciation shown apart.

### Proving it worked

The checks that matter, in order:

1. **Run it twice.** The second run must create nothing, skip everything and exit 0.
2. **The cluster takes multi-document transactions** — every posting runs in a `startSession()`
   transaction. Against a **throwaway** database on that cluster, never the client's own:
   `node --require ./utils/testSetup.js --test services/__tests__/chartAndPricing.test.js`.
   If transactions are unsupported the tier is wrong and nothing else matters.
3. **The money lands where it should** — the one check that would have caught the demo's "Other
   Income" shortcut. Create one part with stock, raise a job card with one **part** line and one
   **labour** line, approve the estimate, complete the task, raise and approve the invoice. Then
   Reports → Profit and loss must show parts revenue under **Sales Revenue**, labour revenue under
   **Labour Income** and parts cost under **Cost of Goods Sold**, with no overlap; Inventory movements
   must show **one** movement for the part and **none** for the labour. Delete it afterwards.
4. `GET /api/v1/organisation/status` reports the plan, `modules.garage.on === true` and `branches: 1`.
