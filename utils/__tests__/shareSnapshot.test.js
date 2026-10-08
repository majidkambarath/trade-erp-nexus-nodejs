const test = require("node:test");
const assert = require("node:assert/strict");
const { invoiceSnapshot, INVOICE_ALLOWED } = require("../shareSnapshot");

// A record as the database really holds it: every field a public page must NOT show is present and
// carries a value starting LEAK, so a leak is visible in the output wherever it lands.
const transaction = () => ({
  _id: "LEAK-id", transactionNo: "SO-2026-0042", invoiceNumber: "INV-2026-0042", status: "APPROVED",
  date: "2026-10-06", deliveryDate: "2026-10-07", dueDate: "2026-11-05", lpono: "LPO-7", docno: "D-1",
  discount: 5, totalAmount: 210,
  partyId: "LEAK-party", partyType: "LEAK-Customer", createdBy: "LEAK-admin", paidAmount: 100, outstandingAmount: 110,
  terms: "LEAK-terms", notes: "LEAK-internal-note", priority: "LEAK", quoteRef: "LEAK-QT", linkedRef: "LEAK-link",
  closedShort: { at: "2026-10-08", reason: "LEAK-reason", original: { items: [{ unitCost: "LEAK-cost" }] } },
  lastSend: { to: "LEAK-recipient" },
  attachments: [{ url: "LEAK-url" }],
  returnOf: { transactionNo: "LEAK-return" },
  items: [{
    _id: "LEAK-line", itemId: "LEAK-item", itemCode: "RICE5", description: "Basmati Rice 5kg", qty: 10, rate: 200,
    vatPercent: 5, vatAmount: 10, lineTotal: 210,
    price: 20, currentPurchasePrice: "LEAK-buy", purchasePrice: "LEAK-buy2", unitCost: "LEAK-cost", cogsAmount: "LEAK-cogs",
    batchNumber: "LEAK-batch", allocations: [{ batchId: "LEAK" }], taxCodeId: "LEAK-tax", brand: "LEAK-brand", grandTotal: 210,
    discountPercent: 0, grossAmount: 200, taxableAmount: 200,
  }],
  charges: [{ code: "FRT", description: "Freight", amount: 20, vatPercent: 5, vatAmount: 1, secretField: "LEAK-charge" }],
  pricing: { gross: 200, lineDiscount: 0, net: 200, lineVat: 10, chargesNet: 0, chargesVat: 0, headerDiscount: 0, roundOff: 0, grandTotal: 210, cogs: "LEAK-pricing" },
});
const customer = () => ({
  _id: "LEAK-cust", customerName: "Al Noor Trading", customerId: "C1", billingAddress: "Al Quoz", phone: "050 111 2222",
  email: "ali@alnoor.ae", trnNumber: "100123456700003", paymentTerms: "Net 30",
  vat: { trn: "100123456700003", registered: "LEAK-vat" },
  credit: { limit: "LEAK-credit" }, bankAccounts: [{ iban: "LEAK-iban" }], documents: [{ name: "LEAK-kyc" }],
  contacts: [{ name: "LEAK-contact" }], shippingAddress: "LEAK-ship", minShelfLifeDays: 45, eInvoice: { participantId: "LEAK-pid" },
});
const company = () => ({
  companyName: "Harbour Trading LLC", companyNameArabic: "x", addressLine1: "a", addressLine2: "b", phoneNumber: "1", email: "e@h.ae",
  website: "h.ae", vatNumber: "100123456700003", logo: "https://cdn.example/logo.png", bankName: "ENBD", accountNumber: "1",
  accountName: "H", ibanNumber: "AE07", swiftCode: "EBILAEAD", branch: "Dubai",
  password: "LEAK-password", companyLogo: { publicId: "LEAK-public-id" }, adminId: "LEAK-admin",
});

const keys = (o) => Object.keys(o).sort();
const allowed = (a) => [...a].sort();

test("the snapshot holds exactly the whitelisted fields, group by group", () => {
  const s = invoiceSnapshot({ transaction: transaction(), customer: customer(), company: company() });
  assert.deepEqual(keys(s), allowed(INVOICE_ALLOWED.top));
  assert.deepEqual(keys(s.document), allowed(INVOICE_ALLOWED.document));
  assert.deepEqual(keys(s.document.items[0]), allowed(INVOICE_ALLOWED.line));
  assert.deepEqual(keys(s.document.charges[0]), allowed(INVOICE_ALLOWED.charge));
  assert.deepEqual(keys(s.document.pricing), allowed(INVOICE_ALLOWED.pricing));
  assert.deepEqual(keys(s.party), allowed(INVOICE_ALLOWED.party));
  assert.deepEqual(keys(s.party.vat), ["trn"], "only the registration number of the VAT block");
  assert.deepEqual(keys(s.company), allowed(INVOICE_ALLOWED.company));
});

test("nothing internal reaches a public page: no cost, margin, batch, credit, KYC, note or earlier copy", () => {
  const out = JSON.stringify(invoiceSnapshot({ transaction: transaction(), customer: customer(), company: company() }));
  assert.equal(out.includes("LEAK"), false, `leaked: ${out.match(/LEAK[\w-]*/g)}`);
  for (const word of ["closedShort", "unitCost", "cogs", "allocations", "purchasePrice", "bankAccounts", "credit", "contacts", "partyId", "createdBy", "paidAmount", "outstandingAmount", "notes"]) {
    assert.equal(out.includes(`"${word}"`), false, `${word} is in the snapshot`);
  }
});

test("a field added to a record later does not appear until someone adds it on purpose", () => {
  const tx = transaction();
  tx.brandNewSecret = "LEAK-new";
  tx.items[0].brandNewCostField = "LEAK-new";
  const cu = customer();
  cu.brandNewField = "LEAK-new";
  const out = JSON.stringify(invoiceSnapshot({ transaction: tx, customer: cu, company: company() }));
  assert.equal(out.includes("LEAK"), false);
});

test("it reads Mongoose documents as well as plain objects", () => {
  const wrap = (o) => ({ toObject: () => o });
  const s = invoiceSnapshot({ transaction: wrap(transaction()), customer: wrap(customer()), company: wrap(company()) });
  assert.equal(s.document.transactionNo, "SO-2026-0042");
  assert.equal(s.party.customerName, "Al Noor Trading");
  assert.equal(s.company.companyName, "Harbour Trading LLC");
});

test("a sparse record gives a sparse snapshot instead of undefined fields", () => {
  const s = invoiceSnapshot({ transaction: { transactionNo: "SO-1", items: [{ description: "Oil", qty: 1 }] }, customer: { customerName: "X" }, company: {} });
  assert.deepEqual(keys(s.document).sort(), ["charges", "items", "pricing", "transactionNo"]);
  assert.equal("vat" in s.party, false);
  assert.deepEqual(s.company, {});
  assert.equal(s.currency, "AED");
});
