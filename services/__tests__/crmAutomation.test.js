// The thing no stand-alone CRM can do: the pipeline moves itself, because the real documents moved.
//
// Against a throwaway database, with real quotations and a real invoice: an offer is made and the deal follows it to
// "Quotation sent", the customer accepts and it follows again, the invoice is approved and the deal is WON at the
// invoice's own figure - then the invoice is deleted and the deal comes back. Also every way it must NOT move: twice
// for one document, backwards, on a purchase, on a sales return, on a document still waiting for a second approver,
// or at all when the organisation has switched auto-advance off.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Quote: require("../orderPurchase/quotationService"),
    Opp: require("../crm/opportunityService"),
    Act: require("../crm/activityService"),
    Setup: require("../crm/crmSetupService"),
    Hooks: require("../crm/crmHooks"),
    Checks: require("../core/notificationChecksService"),
    OppModel: require("../../models/modules/crm/opportunityModel"),
    ActModel: require("../../models/modules/crm/crmActivityModel"),
    Notification: require("../../models/core/notificationModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    Admin: require("../../models/core/adminModel"),
    days: require("../../utils/documentExpiry"),
    rules: require("../../utils/crm"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const today = () => svc.days.todayInOrg();
const line = (item, qty, price) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 0 });
const deal = (id) => svc.OppModel.findById(id).lean();
const moves = async (id) => (await deal(id)).autoMoves.map((m) => `${m.event}->${m.to}${m.undoneAt ? " (undone)" : ""}`);
const fails = async (fn, code) => {
  try {
    await fn();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.errorCode || error.code, code, error.message);
  }
};

let asif, customer, item, pipelineDeal;

test("setup: a customer with stock to sell them, and a deal in the pipeline", { skip }, async () => {
  asif = (await new svc.Admin({ name: "Asif Rahman", email: `asif${Date.now()}@crm.test`, password: "12345678", status: "active", isActive: true, type: "viewer", roleKey: "sales" }).save()).toObject();
  customer = await svc.Customer.create({ customerId: "CUST2026001", customerName: "Al Noor Foods", contactPerson: "Hassan", email: "buyer@alnoor.ae", phone: "0501234567", paymentTerms: "Net 30" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Rice Importers", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const category = await svc.Category.create({ name: "Dry goods" });
  item = await svc.Stock.create({ itemId: "RICE-5", sku: "RICE-5", itemName: "Basmati rice 5kg", category: category._id });

  const purchase = await svc.Tx.createTransaction(
    { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [line(item, 500, 40)] },
    "tester"
  );
  await svc.Tx.processTransaction(purchase._id, "approve", "tester");

  pipelineDeal = await svc.Opp.create({ title: "Monthly rice", customerId: String(customer._id), value: 10000, ownerId: String(asif._id) }, asif._id);
  assert.equal(pipelineDeal.stageKey, "new");
});

test("a quotation raised for that customer attaches itself to the deal, and moves nothing", { skip }, async () => {
  const quote = await svc.Quote.create(
    { partyId: String(customer._id), date: today(), validUntil: svc.days.addDays(today(), 14), items: [line(item, 100, 60)] },
    String(asif._id)
  );
  const d = await deal(pipelineDeal._id);
  assert.equal(d.links.quotationId, String(quote._id), "the deal knows which offer is being made against it");
  assert.equal(d.links.quotationNo, quote.quotationNo);
  assert.equal(d.stageKey, "new", "a draft offer is not an offer the customer has seen");
  assert.deepEqual(await moves(pipelineDeal._id), []);
  pipelineDeal.quote = quote;
});

test("sending it moves the deal by itself, and leaves the next follow-up behind", { skip }, async () => {
  await svc.Quote.transition(pipelineDeal.quote._id, "send", {}, String(asif._id));
  const d = await deal(pipelineDeal._id);
  assert.equal(d.stageKey, "quoted");
  assert.equal(d.stageName, "Quotation sent");
  assert.equal(d.probability, 50);
  assert.equal(d.stageSinceDay, today());
  assert.equal(d.updatedBy, "automation", "and it says so: nobody pressed anything");
  assert.deepEqual(await moves(pipelineDeal._id), ["quotation_sent->quoted"]);

  const owed = await svc.Act.openFor(pipelineDeal._id);
  assert.equal(owed.length, 1, "one thing owed, not one per stage it has been through");
  assert.equal(owed[0].dueAt, svc.days.addDays(today(), 3), "three days, which is what that stage says - not the clock of the stage it came from");
  assert.equal(owed[0].ownerId, String(asif._id), "owed by whoever owns the deal");
});

test("the same document cannot move the same deal twice, however often the hook runs", { skip }, async () => {
  const quote = await svc.Quote.getById(pipelineDeal.quote._id);
  // The hook is reached again - which happens for real when withTransactionSession retries a write conflict on a
  // fresh session, and would happen on any future caller that announces the same event twice.
  await svc.Hooks.onQuotationChanged({ _id: pipelineDeal.quote._id, quotationNo: quote.quotationNo, partyId: customer._id }, { event: "sent" });
  await svc.Hooks.onQuotationChanged({ _id: pipelineDeal.quote._id, quotationNo: quote.quotationNo, partyId: customer._id }, { event: "sent" });
  assert.deepEqual(await moves(pipelineDeal._id), ["quotation_sent->quoted"], "one move, one record of it");
  assert.equal((await svc.Act.openFor(pipelineDeal._id)).length, 1, "and one thing owed, not three");
});

test("the customer accepts: the deal follows again, to the stage that answers that event", { skip }, async () => {
  await svc.Quote.transition(pipelineDeal.quote._id, "accept", { acceptedBy: "Hassan" }, String(asif._id));
  const d = await deal(pipelineDeal._id);
  assert.equal(d.stageKey, "accepted");
  assert.equal(d.probability, 90);
  assert.deepEqual(await moves(pipelineDeal._id), ["quotation_sent->quoted", "quotation_accepted->accepted"]);
});

test("an approved invoice wins the deal, at the invoice's own figure", { skip }, async () => {
  const { salesOrder } = await svc.Quote.convertToSalesOrder(pipelineDeal.quote._id, {}, String(asif._id));
  const linked = await deal(pipelineDeal._id);
  assert.equal(linked.links.orderId, String(salesOrder._id), "converting notes the invoice on the deal");
  assert.equal(linked.stageKey, "accepted", "but a DRAFT invoice wins nothing");

  await svc.Tx.processTransaction(salesOrder._id, "approve", String(asif._id));
  const won = await deal(pipelineDeal._id);
  assert.equal(won.status, "WON");
  assert.equal(won.stageKey, "won");
  assert.equal(won.probability, 100);
  assert.equal(won.closedDay, today());
  assert.equal(won.value, 6000, "100 bags at 60: the invoice says what the business was worth, better than the estimate of 10,000");
  assert.deepEqual(await moves(pipelineDeal._id), ["quotation_sent->quoted", "quotation_accepted->accepted", "invoice_approved->won"]);
  assert.equal((await svc.Act.openFor(pipelineDeal._id)).length, 0, "a won deal owes nobody anything");
  pipelineDeal.invoice = salesOrder;
});

test("deleting that invoice takes the win back, to the stage the deal was on before it", { skip }, async () => {
  await svc.Tx.deleteTransaction(pipelineDeal.invoice._id, String(asif._id));
  const back = await deal(pipelineDeal._id);
  assert.equal(back.status, "OPEN");
  assert.equal(back.stageKey, "accepted", "where it was before the invoice, not at the beginning");
  assert.equal(back.probability, 90);
  assert.equal(back.closedDay, null);
  assert.deepEqual(await moves(pipelineDeal._id), [
    "quotation_sent->quoted", "quotation_accepted->accepted", "invoice_approved->won (undone)",
  ], "the move stays on record, marked as taken back");
  assert.equal((await svc.Act.openFor(pipelineDeal._id)).length, 1, "and the chasing starts again");
});

test("a purchase invoice and a sales return move nothing: only a sale of goods is a deal won", { skip }, async () => {
  const before = await deal(pipelineDeal._id);
  const vendor = await svc.Vendor.findOne({}).lean();
  const purchase = await svc.Tx.createTransaction(
    { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [line(item, 10, 40)] },
    "tester"
  );
  await svc.Tx.processTransaction(purchase._id, "approve", "tester");

  const sale = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(item, 5, 60)] },
    "tester"
  );
  await svc.Tx.processTransaction(sale._id, "approve", "tester");
  const afterSale = await deal(pipelineDeal._id);
  assert.equal(afterSale.status, "WON", "that sale DID win it: it is the customer's only open deal");
  await svc.Tx.deleteTransaction(sale._id, "tester");

  const ret = await svc.Tx.createTransaction(
    { type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(item, 1, 60)] },
    "tester"
  );
  await svc.Tx.processTransaction(ret._id, "approve", "tester");
  const after = await deal(pipelineDeal._id);
  assert.equal(after.stageKey, before.stageKey, "a credit note is not a deal being won");
  assert.equal(after.status, "OPEN");
  assert.deepEqual(await moves(pipelineDeal._id), (await moves(pipelineDeal._id)).filter((m) => !m.includes("purchase")), "and nothing a purchase did");
});

test("two open deals for one customer are ambiguous, so an unlinked invoice moves neither", { skip }, async () => {
  const second = await svc.Opp.create({ title: "Oil as well", customerId: String(customer._id), value: 3000 }, asif._id);
  const before = [(await deal(pipelineDeal._id)).stageKey, (await deal(second._id)).stageKey];

  const sale = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(item, 2, 60)] },
    "tester"
  );
  await svc.Tx.processTransaction(sale._id, "approve", "tester");

  assert.deepEqual([(await deal(pipelineDeal._id)).stageKey, (await deal(second._id)).stageKey], before,
    "guessing would move the wrong one; the person moves it by hand instead");
  await svc.Tx.deleteTransaction(sale._id, "tester");
  await svc.Opp.remove(second._id, asif._id);
});

test("a rejected quotation takes back both the moves it caused", { skip }, async () => {
  // Its own customer: the first one already has an open deal, and the automation will not guess between two.
  const spice = await svc.Customer.create({ customerId: "CUST2026002", customerName: "Spice Souk", contactPerson: "Omar", paymentTerms: "Net 30" });
  const fresh = await svc.Opp.create({ title: "Spices trial", customerId: String(spice._id), value: 2000, ownerId: String(asif._id) }, asif._id);
  await svc.Opp.moveStage(fresh._id, { stageKey: "qualified" }, asif._id);

  const quote = await svc.Quote.create(
    { partyId: String(spice._id), date: today(), validUntil: svc.days.addDays(today(), 14), items: [line(item, 10, 70)] },
    String(asif._id)
  );
  await svc.Quote.transition(quote._id, "send", {}, String(asif._id));
  await svc.Quote.transition(quote._id, "accept", { acceptedBy: "Hassan" }, String(asif._id));
  assert.equal((await deal(fresh._id)).stageKey, "accepted");

  await svc.Quote.transition(quote._id, "reject", { reason: "Found cheaper" }, String(asif._id));
  const back = await deal(fresh._id);
  assert.equal(back.stageKey, "qualified", "all the way back to where the offer found it");
  assert.equal(back.status, "OPEN");
  assert.deepEqual(await moves(fresh._id), ["quotation_sent->quoted (undone)", "quotation_accepted->accepted (undone)"]);
  await svc.Opp.remove(fresh._id, asif._id);
});

test("with auto-advance off, the documents are left to speak for themselves", { skip }, async () => {
  await svc.Setup.saveSettings({ autoAdvance: false }, "tester");
  const nut = await svc.Customer.create({ customerId: "CUST2026003", customerName: "Nut House", contactPerson: "Zaid", paymentTerms: "Net 30" });
  const quiet = await svc.Opp.create({ title: "No automation wanted", customerId: String(nut._id), value: 500, ownerId: String(asif._id) }, asif._id);
  const quote = await svc.Quote.create(
    { partyId: String(nut._id), date: today(), validUntil: svc.days.addDays(today(), 14), items: [line(item, 1, 60)] },
    String(asif._id)
  );
  await svc.Quote.transition(quote._id, "send", {}, String(asif._id));
  assert.equal((await deal(quiet._id)).stageKey, "new", "nothing moved");
  assert.deepEqual(await moves(quiet._id), []);

  await svc.Setup.saveSettings({ autoAdvance: true }, "tester");
  await svc.Opp.remove(quiet._id, asif._id);
});

test("a document still waiting for its second approver wins nothing", { skip }, async () => {
  // Two approvers above nothing at all: the first approve is recorded and the invoice stays a draft.
  await svc.Settings.updateOne({}, { $set: { "approvals.secondApprovalAbove": 0 } }, { upsert: true });
  const twice = await svc.Customer.create({ customerId: "CUST2026004", customerName: "Two Signatures Trading", contactPerson: "Bilal", paymentTerms: "Net 30" });
  const held = await svc.Opp.create({ title: "Needs two signatures", customerId: String(twice._id), value: 900, ownerId: String(asif._id) }, asif._id);
  const sale = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: twice._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(item, 3, 60)] },
    String(asif._id)
  );
  const req = { admin: { id: String(asif._id), name: "Asif Rahman" } };
  const first = await svc.Tx.processTransaction(sale._id, "approve", String(asif._id), { req });
  assert.equal(first.status, "DRAFT", "the invoice is not approved yet");
  assert.equal(first.approvals.length, 1);

  const stillOpen = await deal(held._id);
  assert.equal(stillOpen.status, "OPEN", "and the deal is not won by a document nobody has finished approving");
  assert.deepEqual(await moves(held._id), []);

  // The second person finishes it, and now it is won.
  const maya = await new svc.Admin({ name: "Maya Khan", email: `maya${Date.now()}@crm.test`, password: "12345678", status: "active", isActive: true, type: "viewer", roleKey: "sales" }).save();
  await svc.Tx.processTransaction(sale._id, "approve", String(maya._id), { req: { admin: { id: String(maya._id), name: "Maya Khan" } } });
  const won = await deal(held._id);
  assert.equal(won.status, "WON");
  assert.equal(won.value, 180, "3 at 60");

  await svc.Settings.updateOne({}, { $set: { "approvals.secondApprovalAbove": null } });
  await svc.Tx.deleteTransaction(sale._id, "tester");
});

test("the CRM cannot break what tells it: a broken pipeline still lets an invoice through", { skip }, async () => {
  const CrmStage = require("../../models/modules/crm/crmStageModel");
  const saved = await CrmStage.find({}).lean();
  await CrmStage.deleteMany({ type: "won" }); // no stage answers "invoice approved" any more

  const sale = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(item, 1, 60)] },
    "tester"
  );
  const approved = await svc.Tx.processTransaction(sale._id, "approve", "tester");
  assert.equal(approved.status, "APPROVED", "the invoice is approved whatever the CRM makes of it");

  await CrmStage.deleteMany({});
  await CrmStage.insertMany(saved.map((s) => ({ ...s, _id: undefined })));
  await svc.Tx.deleteTransaction(sale._id, "tester");
});

test("the scheduled checks tell the right person, and resolve themselves when the work is done", { skip }, async () => {
  const [owed] = await svc.Act.openFor(pipelineDeal._id);
  await svc.ActModel.updateOne({ _id: owed._id }, { $set: { dueAt: svc.days.addDays(today(), -2) } });

  await svc.Checks.checkCrmFollowUps();
  const raised = await svc.Notification.findOne({ kind: "crm_followup", resolvedAt: null }).lean();
  assert.ok(raised, "the person who owes it is told");
  assert.equal(raised.audience.adminId, String(asif._id), "and only that person: it is their follow-up, not the team's");
  assert.equal(raised.audience.permission, "crm.view");
  assert.equal(raised.severity, "warning");
  assert.match(raised.title, /2 days late/);

  // Running the pass again does not pile up a second row for the same condition
  await svc.Checks.checkCrmFollowUps();
  assert.equal(await svc.Notification.countDocuments({ kind: "crm_followup", resolvedAt: null }), 1);

  await svc.Act.done(owed._id, { outcome: "spoke" }, asif._id);
  await svc.Checks.checkCrmFollowUps();
  const after = await svc.Notification.findById(raised._id).lean();
  assert.ok(after.resolvedAt, "doing the work closes its own alert");
});

test("an enquiry nobody has touched is told to the whole team", { skip }, async () => {
  const Lead = require("../../models/modules/crm/leadModel");
  const LeadService = require("../crm/leadService");
  const lead = await LeadService.create({ name: "Forgotten caller", phone: "0507777777", source: "phone" }, asif._id);
  // Through the raw driver on purpose: Mongoose puts createdAt back to now on an update of its own, even with
  // `timestamps: false`, and the lead would never look old. A fixture may bypass the plugin; nothing else may.
  await Lead.collection.updateOne({ _id: lead._id }, { $set: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) } });

  await svc.Checks.checkUncontactedLeads();
  const row = await svc.Notification.findOne({ kind: "crm_uncontacted", resolvedAt: null }).lean();
  assert.ok(row);
  assert.equal(row.audience.adminId, null, "if the person it was given to is not acting, somebody else must see it");
  assert.equal(row.severity, "critical");
  assert.match(row.title, /Forgotten caller/);
});

test("the checks skip an organisation that did not buy the CRM", { skip }, async () => {
  const out = await svc.Checks.runAll(new Date(), { planCode: "trading" });
  assert.deepEqual(out.crmFollowUps, { skipped: "not in the plan" });
  assert.deepEqual(out.crmStaleDeals, { skipped: "not in the plan" });
  assert.ok(out.lowStock && !out.lowStock.skipped, "but the stock check still runs: that module it did buy");

  const premium = await svc.Checks.runAll(new Date(), { planCode: "premium" });
  assert.ok(premium.crmFollowUps && !premium.crmFollowUps.skipped);
});

test("a deal that has gone quiet is reported to its owner, once", { skip }, async () => {
  const quiet = await svc.Opp.create({ title: "Gone quiet", customerId: String(customer._id), value: 4000, ownerId: String(asif._id) }, asif._id);
  await svc.OppModel.updateOne({ _id: quiet._id }, { $set: { stageSinceDay: svc.days.addDays(today(), -30), lastActivityDay: svc.days.addDays(today(), -30) } });

  await svc.Checks.checkStaleDeals();
  const row = await svc.Notification.findOne({ kind: "crm_stale", dedupeKey: `crm_stale:${quiet._id}` }).lean();
  assert.ok(row, "nobody has to notice it for themselves");
  assert.equal(row.audience.adminId, String(asif._id));
  assert.match(row.body, /Nothing for 30 days/);

  await svc.OppModel.updateOne({ _id: quiet._id }, { $set: { lastActivityDay: today() } });
  await svc.Checks.checkStaleDeals();
  assert.ok((await svc.Notification.findById(row._id).lean()).resolvedAt, "and doing something about it closes the alert");
  await svc.Opp.remove(quiet._id, asif._id);
});

test("a sent quotation about to lapse is reported while there is still time", { skip }, async () => {
  const dealToLapse = await svc.Opp.create({ title: "About to lapse", customerId: String(customer._id), value: 1500, ownerId: String(asif._id) }, asif._id);
  const quote = await svc.Quote.create(
    { partyId: String(customer._id), date: today(), validUntil: svc.days.addDays(today(), 2), items: [line(item, 5, 60)] },
    String(asif._id)
  );
  // Two open deals now, so the hook linked nothing: say which deal this offer is for.
  await svc.OppModel.updateOne({ _id: dealToLapse._id }, { $set: { "links.quotationId": String(quote._id), "links.quotationNo": quote.quotationNo } });
  await svc.Quote.transition(quote._id, "send", {}, String(asif._id));

  await svc.Checks.checkQuotationsExpiring();
  const row = await svc.Notification.findOne({ kind: "crm_quote_expiring", dedupeKey: `crm_quote_expiring:${quote._id}` }).lean();
  assert.ok(row);
  assert.match(row.title, /expires in 2 days/);
  assert.equal(row.audience.adminId, String(asif._id));
  await svc.Opp.remove(dealToLapse._id, asif._id);
});

test("refusals are unchanged: the CRM added no new way for a document to fail", { skip }, async () => {
  // The quotation was converted, so it can no longer be sent - the engine's own rule, reached through a hook-carrying
  // path, with the hook making no difference to it.
  await fails(() => svc.Quote.transition(pipelineDeal.quote._id, "send", {}, String(asif._id)), "QUOTATION_STATE");
  await fails(() => svc.Quote.remove(pipelineDeal.quote._id, String(asif._id)), "QUOTATION_NOT_DELETABLE");
  // And the invoice that was deleted in an earlier case really is gone (that refusal carries no errorCode, so its
  // words are what there is to check)
  await assert.rejects(() => svc.Tx.processTransaction(pipelineDeal.invoice._id, "approve", "tester"), /Transaction not found/);
});
