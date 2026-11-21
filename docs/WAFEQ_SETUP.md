# E-invoicing through Wafeq: setting it up

Wafeq (Wafeq FZ LLC) is the Ministry-accredited service provider that turns our invoice into PINT-AE XML, delivers it over Peppol and
reports it to the Federal Tax Authority. We are the **partner**: Zarvia holds ONE Wafeq account and its keys on the server, and each client
business only appoints Wafeq in EmaraTax and approves Zarvia once.

Wafeq's own documentation: https://docs.wafeq.com/uae-einvoicing/getting-started

## 1. What you do once, in the Wafeq portal (https://einvoicing.wafeq.com)

1. Choose **Sandbox** mode (free; nothing reaches the FTA or Peppol).
2. **Developer -> API keys**: create a key. A test key starts `pk_test_`, a live one `pk_live_`. It is shown once.
3. **Developer -> Settings**: copy the **OAuth client id and secret** (shown once). Add this callback URL (HTTPS; `http://localhost` is allowed in
   sandbox only): `<PUBLIC_APP_URL>/settings/einvoicing/wafeq/callback`, for example `https://zarvia.onrender.com/settings/einvoicing/wafeq/callback`.
4. **Developer -> Webhooks**: add an HTTPS endpoint pointing at the **backend directly** (not through the frontend rewrite, which would also
   work but adds a hop): `https://<backend>/api/v1/einvoice/wafeq/webhook/test` for sandbox and `.../webhook/live` for live. Choose the events
   `document.sent`, `document.status`, `document.reported`, `taxpayer.updated`, `taxpayer.deleted`. Copy its **signing secret** (`whsec_...`).
5. For live: buy a subscription and repeat 2 to 4 in Live mode. Live and sandbox have separate keys, clients, endpoints and taxpayers.
6. An app that is not verified may have at most **25 live businesses**. Ask Wafeq support to verify the app well before that.

## 2. What goes on the server (Render environment variables, or the git-ignored `.env` locally)

| Variable | What |
| --- | --- |
| `WAFEQ_API_KEY_TEST` / `WAFEQ_API_KEY_LIVE` | the API key. A mode exists on this server only when its key is set |
| `WAFEQ_CLIENT_ID_TEST` / `WAFEQ_CLIENT_SECRET_TEST` (and `_LIVE`) | the OAuth client, for "Connect with Wafeq" |
| `WAFEQ_WEBHOOK_SECRET_TEST` / `WAFEQ_WEBHOOK_SECRET_LIVE` | the webhook signing secret (`whsec_...`) |
| `PUBLIC_APP_URL` | the base of the OAuth callback. Locally `http://localhost:5173` |
| `WAFEQ_API_BASE`, `WAFEQ_PORTAL_BASE` | optional; tests point them at a fake server |

Never put a key in chat, in the repository or in a screenshot. If one was pasted somewhere, rotate it in the portal.

## 3. What each client business does

1. In **EmaraTax -> e-Invoicing**, appoint **Wafeq FZ LLC** as its service provider (once for all apps).
2. In Zarvia: **e-Invoicing -> Settings -> Connect with Wafeq**, approve on Wafeq's page, and it returns to Zarvia connected.
3. Fill in what an e-invoice needs: the company TRN and emirate (Settings -> Business rules), each customer's emirate and, for a customer with
   no TRN, an **identifier** such as a trade licence number (e-Invoicing -> Readiness), and a **reason** on each exempt or out-of-scope tax
   code (Accounting setup -> Tax codes). The preview names anything still missing.
4. **Switch e-invoicing on**, then send invoices from **e-Invoicing -> Outbound**.

A developer can also link a business by hand from the developer console (**Organisation -> E-invoicing**) by typing its Wafeq taxpayer id
(`txpay_...`): this is how the sandbox taxpayer is tested, and how support helps a business that cannot do the approval itself.

## 4. How it behaves (measured against the Wafeq sandbox, 20 Nov 2026)

- Zarvia sends a JSON invoice; **Wafeq builds the XML**. The seller is never sent: Wafeq reads it from the business's registered profile.
- **VAT is worked out once per tax category and rate**, the way the e-invoice standard does it. For a UAE organisation that sends through
  Wafeq, our own pricing does the same (`utils/vatRounding.js`), so the books, the printed invoice and the e-invoice agree to the fils and no
  round-off amount is needed. Documents priced earlier keep their stored figures.
- The preview calls Wafeq's own `/validate` (the official PINT-AE rules). A refusal is shown in Wafeq's words and nothing is sent.
- **In sandbox the FTA leg never reports** (`tdd_status: not_reported`): a sent invoice stops at "Delivered", and the screen says so.
- A credit note references the invoice by its Wafeq id when it was sent through Wafeq, else by number and date.
- A buyer with no TRN and no Peppol id is reported to the **tax authority only**, identified by the identifier on the customer.
- Wafeq's limits are shared by every client of ours: 60 sends, 120 checks and 120 reads a minute. Statuses arrive by webhook; polling is the
  backstop and runs at most every 10 minutes per invoice.

## 5. Received invoices, fix and resend, credit in full

- **Received invoices.** Supplier e-invoices that arrive at Wafeq for the business are pulled in automatically (a webhook, and a check every
  ten minutes) or on demand with **e-Invoicing -> Inbound -> Check for new**. Each is read from its UBL XML (kept as received), matched to a
  vendor by TRN or Peppol id, and listed. **Record as purchase invoice** makes a DRAFT purchase invoice: you choose our item for each line, the
  tax comes from the supplier's own category and rate, and any difference from the supplier's total is shown. Wafeq has no API to accept or
  reject a received invoice, so Accept and Reject stay decisions recorded here. A supplier's credit note can only be accepted or rejected.
  In live, each received document uses a Wafeq document credit; with none, the screen says so.
- **Fix and resend.** When the **buyer** rejects an invoice for a reason Wafeq codes BV or SV (wrong buyer details), fix the customer, then press
  **Resend correction** on the rejected row. The invoice is rebuilt from what is saved now and sent with the SAME number, pointing at the rejected
  document. A rejection by the tax authority, or an FD one, cannot be corrected: issue a credit note and a new invoice. **Wafeq allows corrections
  in live mode only** (its sandbox answers `sandbox_reporting_disabled`), so this is proved against a fake Wafeq, not in the sandbox.
- **Credit in full.** Cancelling an e-invoiced invoice is a credit note, never an edit and never Wafeq's own void. **Credit in full** on a sent
  invoice drafts a sales return for everything not yet credited, at the original prices and tax codes; approve it on Sales -> Returns, then send it
  from Outbound. A header discount given on the original is not reproduced on the draft: check its total before approving.

- **Tracking.** e-Invoicing has its own menu item. Its **Dashboard** opens on "Needs you now" (unsent, failed, rejected, supplier invoices
  to review: each tile opens the filtered list), then the period's figures, delivery to the buyer and the report to the tax authority as
  two separate journeys, a six-month trend, and a **Connection** card. **Check connection** compares Wafeq's record (TRN, legal name)
  with the company profile; **Compare with Wafeq** puts Wafeq's own count beside ours. In test mode the tax authority is never
  reached, and the screen says so. Settings has "Applies to invoices dated from": older approved invoices are never counted as unsent.

## 6. Not built yet

Foreign-currency e-invoices (sent in AED only), self-billing (389 / 261), Wafeq's own void, the XML download button, a "reachable on Peppol" check
per customer, sending automatically on approval, the Wafeq summary report, and recording a supplier's credit note against a purchase.

## 7. Dates to know

PINT-AE **1.0.5 goes live at Wafeq on 3 December 2026**: UAE buyer addresses are then checked for emirate codes (we already send them), exempt
document discounts and charges need a reason code, and a buyer on `0235:9900000098` or `...99` may omit the legal-registration type.
