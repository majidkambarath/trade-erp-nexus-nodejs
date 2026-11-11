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
  serialNo: "GRG-2026-114",
  // The garage link. The customer's copy may name the car; it may never carry the job card's database id.
  jobCardRef: { jobCardId: "LEAK-jobcard-id", jobNo: "JC-2026-0017", plateNumber: "A 11111", chassisNo: "JTEBU29J100123456" },
  items: [{
    _id: "LEAK-line", itemId: "LEAK-item", itemCode: "RICE5", description: "Basmati Rice 5kg", qty: 10, rate: 200,
    vatPercent: 5, vatAmount: 10, taxKind: "standard", lineTotal: 210,
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
  vat: { trn: "100123456700003", status: "registered", registered: "LEAK-vat", tradeLicenseNo: "LEAK-licence" },
  credit: { limit: "LEAK-credit" }, bankAccounts: [{ iban: "LEAK-iban" }], documents: [{ name: "LEAK-kyc" }],
  contacts: [{ name: "LEAK-contact" }], shippingAddress: "LEAK-ship", minShelfLifeDays: 45,
  // City and country are printed under the customer's name; the participant id is a Peppol routing
  // address and must never reach a page a customer can open.
  eInvoice: { participantId: "LEAK-pid", city: "Dubai", countryCode: "AE" },
});
const company = () => ({
  companyName: "Harbour Trading LLC", companyNameArabic: "x", addressLine1: "a", addressLine2: "b",
  city: "Dubai", state: "Dubai", country: "United Arab Emirates", phoneNumber: "1", email: "e@h.ae",
  website: "h.ae", vatNumber: "100123456700003", vatRegistered: true, logo: "https://cdn.example/logo.png", bankName: "ENBD", accountNumber: "1",
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
  assert.deepEqual(keys(s.party.vat), ["status", "trn"], "only the registration number and status of the VAT block");
  assert.equal(s.party.vat.status, "registered");
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

// ---- the job card's estimate ---------------------------------------------------------------------
// The same discipline as the invoice, with one deliberate difference: a line's own _id DOES travel,
// because the customer's decision has to name the lines it approves. Everything else stays behind.
const { estimateSnapshot, ESTIMATE_ALLOWED } = require("../shareSnapshot");

const card = () => ({
  _id: "LEAK-card-id", jobNo: "JC-2026-0001", status: "AWAITING_APPROVAL",
  receivedAt: "2026-11-01", promisedAt: "2026-11-03", odometerIn: 84500,
  companyId: "LEAK-company", branchId: "LEAK-branch", createdBy: "LEAK-admin", updatedBy: "LEAK-admin2",
  vehicleId: "LEAK-vehicle-id", customerId: "LEAK-customer-id", claimId: "LEAK-claim-id",
  comebackOf: "LEAK-comeback", notes: "LEAK-internal-note", invoiceStatus: "NONE",
  vehicle: {
    plateNumber: "12345", plateCode: "A", plateEmirate: "Dubai", make: "Toyota", model: "Land Cruiser",
    year: 2019, colour: "White", chassisNo: "JTEBU29J100123456", secretValuation: "LEAK-value",
  },
  customer: { name: "LEAK-snapshot-name", phone: "LEAK-snapshot-phone" },
  estimate: {
    version: 2, total: 1500, sentAt: "2026-11-01", decidedAt: null, method: "portal",
    sentBy: "LEAK-advisor", decidedBy: "LEAK-decider", reference: "LEAK-reference", note: "LEAK-estimate-note",
    online: { ip: "LEAK-ip", linkId: "LEAK-link" },
  },
  complaints: [{ _id: "LEAK-complaint-id", seq: 1, concern: "Noise when braking", cause: "Front pads worn", correction: "LEAK-correction", status: "LEAK-status" }],
  inspection: [{ _id: "insp1", item: "Front brake pads", condition: "urgent", note: "2mm left", photos: ["a1b2c3"], inspectedBy: "LEAK-tech" }],
  lines: [{
    _id: "line1", kind: "part", description: "Front brake pads", qty: 1, price: 420,
    discountPercent: 0, discountAmount: 0, vatPercent: 5, vatAmount: 21, lineTotal: 441,
    approved: undefined, complaintId: "c1", addedInVersion: 1,
    itemId: "LEAK-item-id", itemCode: "LEAK-sku", taxCodeId: "LEAK-tax", issuedQty: "LEAK-issued",
    invoiced: "LEAK-invoiced", itemType: "LEAK-type", grossAmount: "LEAK-gross", taxableAmount: "LEAK-taxable",
    rcmVat: "LEAK-rcm", taxKind: "LEAK-kind",
    // Who we send sublet work to is the workshop's own business, never the customer's.
    vendorId: "LEAK-vendor-id", vendorName: "LEAK-vendor-name",
  }],
  // None of these are listed in the snapshot at all, so they cannot appear by accident.
  tasks: [{ name: "LEAK-task", staffName: "LEAK-technician", actualHours: "LEAK-hours", bayName: "LEAK-bay" }],
  purchaseOrders: [{ no: "LEAK-po", vendorName: "LEAK-po-vendor" }],
  invoices: [{ no: "LEAK-invoice" }],
  estimateHistory: [{ total: "LEAK-old-total" }],
  checkIn: { damagePoints: [{ panel: "LEAK-panel" }], photos: ["LEAK-checkin-photo"], notes: "LEAK-checkin" },
});
const totals = () => ({ part: 420, labour: 600, sublet: 0, consumable: 0, net: 1020, vat: 51, total: 1071, cogs: "LEAK-cogs" });

test("the estimate snapshot holds exactly the whitelisted fields, group by group", () => {
  const s = estimateSnapshot({ card: card(), customer: customer(), company: company(), totals: totals() });
  assert.deepEqual(keys(s), allowed(ESTIMATE_ALLOWED.top));
  assert.deepEqual(keys(s.job), allowed(ESTIMATE_ALLOWED.job));
  assert.deepEqual(keys(s.job.vehicle), allowed(ESTIMATE_ALLOWED.vehicle));
  assert.deepEqual(keys(s.job.complaints[0]), allowed(ESTIMATE_ALLOWED.complaint));
  assert.deepEqual(keys(s.job.inspection[0]), allowed(ESTIMATE_ALLOWED.inspection));
  assert.deepEqual(keys(s.job.lines[0]), allowed(ESTIMATE_ALLOWED.line.filter((k) => k !== "approved")), "an undecided line carries no `approved` at all");
  assert.deepEqual(keys(s.totals), allowed(ESTIMATE_ALLOWED.totals));
  assert.deepEqual(keys(s.party), allowed(ESTIMATE_ALLOWED.party));
  assert.deepEqual(keys(s.company), allowed(ESTIMATE_ALLOWED.company));
});

test("the estimate leaks nothing: no cost, no sublet vendor, no technician, no internal note", () => {
  const out = JSON.stringify(estimateSnapshot({ card: card(), customer: customer(), company: company(), totals: totals() }));
  assert.equal(out.includes("LEAK"), false, `leaked: ${out.match(/LEAK[\w-]*/g)}`);
  for (const word of ["vendorId", "vendorName", "itemId", "taxCodeId", "issuedQty", "invoiced", "tasks", "purchaseOrders", "estimateHistory", "checkIn", "claimId", "notes", "customerId", "vehicleId", "companyId"]) {
    assert.equal(out.includes(`"${word}"`), false, `${word} is in the estimate snapshot`);
  }
});

test("a line's own id travels, because the customer's decision has to name the lines it approves", () => {
  const s = estimateSnapshot({ card: card(), customer: customer(), company: company(), totals: totals() });
  assert.equal(s.job.lines[0]._id, "line1");
  // ...and it is the ONLY id: the card's, the vehicle's, the customer's and the item's all stay behind.
  assert.equal("_id" in s.job, false);
  assert.equal("_id" in s.job.vehicle, false);
  assert.equal("itemId" in s.job.lines[0], false);
});

test("a field added to a job card later does not appear until someone adds it on purpose", () => {
  const c = card();
  c.brandNewSecret = "LEAK-new";
  c.lines[0].brandNewCostField = "LEAK-new";
  c.vehicle.brandNewField = "LEAK-new";
  c.inspection[0].brandNewField = "LEAK-new";
  const out = JSON.stringify(estimateSnapshot({ card: c, customer: customer(), company: company(), totals: totals() }));
  assert.equal(out.includes("LEAK"), false);
});

test("a declined line says so, and the totals are the ones worked out on the server", () => {
  const c = card();
  c.lines[0].approved = false;
  const s = estimateSnapshot({ card: c, customer: customer(), company: company(), totals: totals() });
  assert.equal(s.job.lines[0].approved, false);
  assert.deepEqual(s.totals, { part: 420, labour: 600, sublet: 0, consumable: 0, net: 1020, vat: 51, total: 1071 });
  assert.equal(s.kind, "job_estimate");
});

// The heading on the customer's own copy is built from the number AND the registration, so both have to
// travel. `false` is the whole point and is exactly what a careless whitelist would drop: `pick` keeps
// anything that is not undefined or null, and this is what says so out loud.
test("the seller's registration travels with its number, false included", () => {
  const off = invoiceSnapshot({ transaction: transaction(), customer: customer(), company: { ...company(), vatRegistered: false } });
  assert.equal(off.company.vatRegistered, false);
  assert.equal(off.company.vatNumber, "100123456700003");

  const on = invoiceSnapshot({ transaction: transaction(), customer: customer(), company: company() });
  assert.equal(on.company.vatRegistered, true);

  // absent stays absent rather than becoming false: the page reads it as registered, as every copy
  // taken before the flag was carried must go on doing
  const older = { ...company() };
  delete older.vatRegistered;
  assert.equal("vatRegistered" in invoiceSnapshot({ transaction: transaction(), customer: customer(), company: older }).company, false);
});
