// Emailing a quotation, a delivery note and a customer's statement (the same pipeline as the tax invoice, console provider).
//   node --require ./utils/testSetup.js --test services/__tests__/sendMoreDocuments.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let svc, admin, customer, rice, so;

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Q: require("../orderPurchase/quotationService"),
    D: require("../orderPurchase/deliveryNoteService"),
    Msg: require("../messaging/messagingService"),
    Share: require("../messaging/shareService"),
    M: require("../../models/modules/messagingModels"),
    Quotation: require("../../models/modules/quotationModel"),
    DeliveryNote: require("../../models/modules/deliveryNoteModel"),
    Stock: require("../../models/modules/stockModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Admin: require("../../models/core/adminModel"),
    CompanySettings: require("../../models/modules/financial/companySettingsModel"),
    days: require("../../utils/documentExpiry"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  await svc.M.MessagingSettings.updateOne(
    { companyId: "default" },
    { $set: { enabled: true, provider: "console", fromEmail: "accounts@harbour.ae", fromName: "Harbour", retryMax: 3, dailyLimit: 200, attachPdf: true, shareEnabled: true } },
    { upsert: true }
  );
  admin = await new svc.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true, companyInfo: { companyName: "Harbour Trading LLC" } }).save();
  await svc.CompanySettings.updateOne({}, { $set: { "profile.trn": "100999888700003" } }, { upsert: true });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  customer = await svc.Customer.create({
    customerId: "C1", customerName: "Al Noor Trading", contactPerson: "Ali", email: "ali@alnoor.ae", phone: "050 111 2222", billingAddress: "Al Quoz",
    creditLimit: 99999, bankAccounts: [{ bankName: "SECRET BANK", accountNumber: "SECRETACCT" }],
  });
  rice = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Basmati Rice 5kg", category: new mongoose.Types.ObjectId(), purchasePrice: 7 });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [L(500, 10)] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
  const order = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(10, 20)] }, "t");
  so = await svc.Tx.processTransaction(order._id, "approve", "t");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const L = (qty, price) => ({ itemId: rice._id, description: rice.itemName, qty, price, rate: price, vatPercent: 5 });
const ymd = (n = 0) => svc.days.addDays(svc.days.todayInOrg(), n);
let n = 0;
const reqOf = () => ({
  admin: { id: String(admin._id), name: "Boss", email: "boss@test.uae" },
  headers: {},
  get: (h) => (String(h).toLowerCase() === "idempotency-key" ? `press-${Date.now()}-${(n += 1)}-abcdefgh` : undefined),
});
const pdf = () => ({ buffer: Buffer.from("%PDF-1.4\n%fake\n"), originalname: "x.pdf", size: 14 });
const send = (docType, sourceId, over = {}) => svc.Msg.send({ docType, sourceId, force: true, ...over }, pdf(), reqOf());
const quote = (over = {}) => svc.Q.create({ partyId: customer._id, validUntil: ymd(30), reference: "RFQ-1", terms: "30 days", notes: "INTERNAL ONLY", items: [L(10, 20)], ...over }, "t");
const snapshotOf = async (r) => JSON.parse(JSON.stringify((await svc.Share.resolve(r.share.url.split("/d/")[1])).snapshot));

test("a draft quotation is emailed and becomes Sent; its subject and last send are set", { skip }, async () => {
  const q = await quote();
  assert.equal(q.status, "DRAFT");
  const r = await send("quotation", q._id);
  assert.equal(r.send.status, "SENT");
  assert.match(r.send.subject, /^Quotation QT-\d{4}-\d{4} from .*valid until /);
  const after = await svc.Quotation.findById(q._id).lean();
  assert.equal(after.status, "SENT");
  assert.ok(after.sentAt);
  assert.equal(after.lastSend.status, "SENT");
  assert.equal(after.lastSend.to, "ali@alnoor.ae");
});

test("an offer already sent is emailed again with no change of state; a declined one is refused", { skip }, async () => {
  const q = await quote();
  await svc.Q.transition(q._id, "send", {}, "t");
  await send("quotation", q._id);
  assert.equal((await svc.Quotation.findById(q._id).lean()).status, "SENT");
  await svc.Q.transition(q._id, "reject", { reason: "too dear" }, "t");
  await assert.rejects(() => send("quotation", q._id), { code: "DOCUMENT_NOT_SENDABLE" });
});

test("a lapsed offer is refused", { skip }, async () => {
  const q = await quote();
  await svc.Q.transition(q._id, "send", {}, "t");
  await svc.Quotation.updateOne({ _id: q._id }, { $set: { validUntil: new Date(`${ymd(-3)}T00:00:00.000Z`) } });
  await assert.rejects(() => send("quotation", q._id), (e) => e.code === "DOCUMENT_NOT_SENDABLE" && /validity/i.test(e.message));
});

test("the customer's link to a quotation carries the offer and nothing internal", { skip }, async () => {
  const q = await quote();
  const snap = await snapshotOf(await send("quotation", q._id));
  assert.equal(snap.kind, "quotation");
  assert.equal(snap.document.quotationNo, q.quotationNo);
  assert.equal(snap.document.terms, "30 days");
  assert.equal(snap.document.items.length, 1);
  const text = JSON.stringify(snap);
  for (const secret of ["INTERNAL ONLY", "SECRETACCT", "SECRET BANK", "99999", "creditLimit", String(rice._id), String(customer._id)]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("a delivery note is emailed once dispatched; a draft is refused; its copy has quantities and no prices", { skip }, async () => {
  const note = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: so.items[0]._id, qty: 6 }] }, "t");
  await assert.rejects(() => send("delivery_note", note._id), (e) => e.code === "DOCUMENT_NOT_SENDABLE" && /dispatch/i.test(e.message));
  await svc.D.dispatch(note._id, { vehicleNo: "DXB A 1", driverName: "Raju" }, "t");
  const r = await send("delivery_note", note._id);
  assert.equal(r.send.status, "SENT");
  assert.match(r.send.subject, /^Delivery note DLN-/);
  assert.equal((await svc.DeliveryNote.findById(note._id).lean()).lastSend.status, "SENT");
  const snap = await snapshotOf(r);
  assert.equal(snap.kind, "delivery_note");
  assert.equal(snap.document.items[0].qty, 6);
  assert.equal(snap.document.vehicleNo, "DXB A 1");
  const text = JSON.stringify(snap);
  for (const k of ["price", "lineTotal", "totalAmount", "pricing", "vatAmount"]) assert.equal(text.includes(`"${k}"`), false, k);
});

test("a customer's statement is emailed for a period; the subject names it; the link shows the rows and no ids", { skip }, async () => {
  const from = ymd(-30);
  const to = ymd(0);
  const r = await send("statement", customer._id, { periodFrom: from, periodTo: to });
  assert.equal(r.send.docType, "statement");
  assert.match(r.send.subject, /^Statement of account - .* to .* from /);
  const snap = await snapshotOf(r);
  assert.equal(snap.kind, "statement");
  assert.equal(snap.statement.from, from);
  assert.ok(snap.statement.rows.length >= 1, "the invoice is on it");
  assert.equal(snap.statement.closing, 210);
  const text = JSON.stringify(snap);
  for (const secret of ["SECRETACCT", "99999", String(customer._id), "voucherId", "accountId"]) assert.equal(text.includes(secret), false, secret);
  await assert.rejects(() => send("statement", customer._id, { periodFrom: to, periodTo: from }), { code: "INVALID_RANGE" });
  await assert.rejects(() => send("statement", new mongoose.Types.ObjectId()), { code: "DOCUMENT_NOT_FOUND" });
  const dflt = await send("statement", customer._id);
  assert.match(dflt.send.subject, /^Statement of account - /, "no period given: this year to date");
});

test("WhatsApp hand-off of a draft quotation also marks it Sent", { skip }, async () => {
  const q = await quote();
  await svc.Msg.handoff({ docType: "quotation", sourceId: q._id, phone: "+971501112222" }, reqOf());
  assert.equal((await svc.Quotation.findById(q._id).lean()).status, "SENT");
});

// An invoice made in a foreign currency is a foreign document beside the base one (Transaction.fx). The customer is quoted, and the PDF
// and the link show, the foreign total; the email used to announce the base-currency equivalent ("for 210.00 AED" for a USD invoice).
test("a foreign-currency invoice is announced in its own currency, never the base-currency equivalent", { skip }, async () => {
  const DocumentSource = require("../messaging/documentSource");
  const { renderDocumentEmail } = require("../../utils/emailTemplates");
  const order = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(10, 20)] }, "t");
  await svc.Tx.processTransaction(order._id, "approve", "t");

  // as the books hold an ordinary invoice: the base total in the base currency (and a base invoice must read exactly as it always did)
  const base = await DocumentSource.load("tax_invoice", order._id, reqOf());
  assert.equal(base.currency, "AED");
  assert.equal(base.total, 210);
  assert.match(renderDocumentEmail({ ...base }).text, /for 210\.00 AED\./);

  // the same invoice as a USD document (what fxDocumentService stamps): 210.00 AED at 3.6725 is 57.18 USD
  await svc.Transaction.updateOne({ _id: order._id }, { $set: { fx: { currency: "USD", rate: 3.6725, decimals: 2, totalAmount: 57.18, outstandingAmount: 57.18 } } });
  const foreign = await DocumentSource.load("tax_invoice", order._id, reqOf());
  assert.equal(foreign.currency, "USD");
  assert.equal(foreign.total, 57.18);
  const text = renderDocumentEmail({ ...foreign }).text;
  assert.match(text, /for 57\.18 USD\./);
  assert.ok(!/210\.00 AED/.test(text), "the base-currency equivalent is not what the customer owes");
});
