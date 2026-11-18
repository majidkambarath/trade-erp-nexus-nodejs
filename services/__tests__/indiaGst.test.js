// India GST against a throwaway database: an Indian organisation is given GST tax codes and its CGST / SGST / IGST accounts, a document is
// priced with its tax by component from the place of supply, and posts to the component accounts; a return follows its invoice; an
// organisation without the company's own state (or a UAE one) is untouched.
//
//   node --require ./utils/testSetup.js --test services/__tests__/indiaGst.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_gst_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const GSTIN_MH = "27AAPFU0939F1ZV"; // Maharashtra
const GSTIN_KA = "29AAPFU0939F1ZV"; // Karnataka
const GSTIN_KA2 = "29AAPFU0939F2ZV"; // another Karnataka registration

let svc, local, far, farVendor, item, std18;
const IN = "ingst";
const inOrg = (code, fn) => svc.ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const run = (fn) => inOrg(IN, fn);

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    Org: require("../core/organisationService"),
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Customers: require("../customer/customerService"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Category: require("../../models/modules/categoryModel"),
    Stock: require("../../models/modules/stockModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    LedgerAccount: fin.LedgerAccount,
    LedgerEntry: fin.LedgerEntry,
    Transaction: require("../../models/modules/transactionModel"),
    ctx: require("../../utils/tenantContext"),
  };
  await mongoose.connection.syncIndexes();
  await svc.Org.create({ legalName: "Brivox Test", code: IN, country: "IN", baseCurrency: "INR", timezone: "Asia/Kolkata", planCode: "premium" }, { by: "dev" });
  await run(async () => {
    await svc.Settings.updateOne({}, { $set: { "profile.stateCode": "27", "profile.trn": GSTIN_MH } });
    await svc.Config.setPostingEnabled(true);
    local = await svc.Customer.create({ customerId: "C1", customerName: "Local Co", paymentTerms: "Cash", stateCode: "27" });
    far = await svc.Customer.create({ customerId: "C2", customerName: "Far Co", paymentTerms: "Cash", stateCode: "29" });
    farVendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Far Supplier", address: "Bengaluru", paymentTerms: "Cash", stateCode: "29" });
    const category = await svc.Category.create({ name: "General" });
    item = await svc.Stock.create({ itemId: "BOLT", sku: "BO0001", itemName: "Bolt", category: category._id, hsnCode: "7318" });
    std18 = await svc.TaxCode.findOne({ kind: "standard", ratePercent: 18 }).lean();
  });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const line = (qty, price, extra = {}) => ({ itemId: item._id, description: "Bolt", qty, price, rate: price, taxCodeId: std18._id, ...extra });
const sell = (party, items, extra) => svc.Tx.createTransaction({ type: "sales_order", partyId: party._id, partyType: "Customer", partyTypeRef: "Customer", items, ...extra }, "tester");
const buy = (items, extra) => svc.Tx.createTransaction({ type: "purchase_order", partyId: farVendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items, ...extra }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
async function posted(t) {
  const rows = await svc.LedgerEntry.find({ voucherId: t._id, isReversed: { $ne: true } }).lean();
  const out = {};
  for (const e of rows) out[e.accountName] = r2((out[e.accountName] || 0) + e.debitAmount - e.creditAmount);
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return { byAccount: out, balanced: r2(rows.reduce((s, e) => s + e.debitAmount - e.creditAmount, 0)) === 0 };
}

test("an Indian organisation gets GST tax codes and its six component accounts; a UAE one gets neither", { skip }, async () => {
  const codes = await run(() => svc.TaxCode.find({}).lean());
  assert.deepEqual(codes.map((c) => c.name).sort(), ["Exempt", "GST 18%", "GST 40%", "GST 5%", "Nil rated", "Non-GST supply", "Reverse charge 18%", "Zero-rated (export / SEZ)"]);
  assert.equal(codes.find((c) => c.isDefault).name, "GST 18%");
  const accounts = await run(() => svc.LedgerAccount.find({ accountName: /CGST|SGST|IGST/ }).select("accountName").lean());
  assert.deepEqual(accounts.map((a) => a.accountName).sort(), ["Input CGST", "Input IGST", "Input SGST / UTGST", "Output CGST", "Output IGST", "Output SGST / UTGST"]);
  for (const key of ["gst-cgst-output", "gst-sgst-output", "gst-igst-output", "gst-cgst-input", "gst-sgst-input", "gst-igst-input"]) {
    assert.ok(await run(() => svc.Config.resolveAccount(key)), `${key} is mapped`);
  }
  await svc.Org.create({ legalName: "Harbour Test", code: "aegst", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" }, { by: "dev" });
  assert.equal((await inOrg("aegst", () => svc.LedgerAccount.find({ accountName: /CGST|SGST|IGST/ }).lean())).length, 0);
  assert.ok((await inOrg("aegst", () => svc.TaxCode.find({ name: "Standard 5%" }).lean())).length === 1);
});

test("a sale inside the company's state splits its tax into CGST and SGST, and posts that way", { skip }, async () => {
  await run(async () => {
    const t = await sell(local, [line(10, 100)]);
    assert.equal(t.gstType, "intra");
    assert.equal(t.placeOfSupply, "27");
    assert.equal(t.supplierState, "27");
    assert.equal(r2(t.pricing.lineVat), 180);
    assert.deepEqual({ ...t.pricing.gst.toObject?.() ?? t.pricing.gst }, { cgst: 90, sgst: 90, igst: 0 });
    assert.deepEqual(t.items[0].gst.toObject?.() ?? t.items[0].gst, { cgst: 90, sgst: 90, igst: 0 });
    assert.equal(t.items[0].hsnCode, "7318", "the item's HSN code is stamped on the line");
    assert.equal(r2(t.totalAmount), 1180, "the total is what it always was");
    await approve(t);
    const p = await posted(t);
    assert.equal(p.byAccount["Output CGST"], -90);
    assert.equal(p.byAccount["Output SGST / UTGST"], -90);
    assert.ok(!p.byAccount["Output GST"] && !p.byAccount["Output IGST"], JSON.stringify(p.byAccount));
    assert.ok(p.balanced, "and the entry balances");
  });
});

test("a sale to another state is all IGST", { skip }, async () => {
  await run(async () => {
    const t = await sell(far, [line(10, 100)]);
    assert.equal(t.gstType, "inter");
    assert.equal(t.placeOfSupply, "29");
    assert.deepEqual(t.pricing.gst.toObject?.() ?? t.pricing.gst, { cgst: 0, sgst: 0, igst: 180 });
    await approve(t);
    const p = await posted(t);
    assert.equal(p.byAccount["Output IGST"], -180);
    assert.ok(!p.byAccount["Output CGST"]);
    assert.ok(p.balanced);
  });
});

test("an odd fil goes to CGST, a charge's tax is split too, and the components add back to the document's tax", { skip }, async () => {
  await run(async () => {
    const t = await sell(local, [line(1, 0.25), line(1, 0.25)], { charges: [{ description: "Courier", amount: 1, vatPercent: 18 }] });
    const sum = (g) => r2(g.cgst + g.sgst + g.igst);
    const g = t.pricing.gst.toObject?.() ?? t.pricing.gst;
    assert.equal(sum(g), r2(t.pricing.lineVat + t.pricing.chargesVat));
    assert.ok(g.cgst >= g.sgst && g.cgst - g.sgst <= 0.02);
    await approve(t);
    const p = await posted(t);
    assert.equal(r2(-(p.byAccount["Output CGST"] + p.byAccount["Output SGST / UTGST"])), r2(t.pricing.lineVat + t.pricing.chargesVat));
    assert.ok(p.balanced);
  });
});

test("a purchase from another state claims IGST as input tax", { skip }, async () => {
  await run(async () => {
    const t = await buy([line(10, 100)]);
    assert.equal(t.gstType, "inter");
    assert.equal(t.placeOfSupply, "27", "the company is the recipient");
    assert.equal(t.supplierState, "29");
    await approve(t);
    const p = await posted(t);
    assert.equal(p.byAccount["Input IGST"], 180);
    assert.ok(!p.byAccount["Input GST"] && !p.byAccount["Input CGST"]);
    assert.ok(p.balanced);
  });
});

test("a return follows the invoice it returns, even if the customer's state was changed after", { skip }, async () => {
  await run(async () => {
    const inv = await sell(local, [line(10, 100)]);
    await approve(inv);
    await svc.Customer.updateOne({ _id: local._id }, { $set: { stateCode: "29" } }); // the customer moved
    const ret = await svc.Tx.createTransaction({
      type: "sales_return", partyId: local._id, partyType: "Customer", partyTypeRef: "Customer",
      items: [line(2, 100, { returnOfLineId: inv.items[0]._id })], returnOf: { transactionId: inv._id },
    }, "tester");
    assert.equal(ret.gstType, "intra", "the credit note undoes what the invoice charged");
    assert.deepEqual(ret.pricing.gst.toObject?.() ?? ret.pricing.gst, { cgst: 18, sgst: 18, igst: 0 });
    await approve(ret);
    const p = await posted(ret);
    assert.equal(p.byAccount["Output CGST"], 18, "debited back");
    assert.equal(p.byAccount["Output SGST / UTGST"], 18);
    assert.ok(p.balanced);
    await svc.Customer.updateOne({ _id: local._id }, { $set: { stateCode: "27" } });
  });
});

test("a party with only a GSTIN is placed by its first two digits", { skip }, async () => {
  await run(async () => {
    const byGstin = await svc.Customer.create({ customerId: "C3", customerName: "Gstin Only Co", paymentTerms: "Cash", trnNumber: GSTIN_KA });
    const t = await sell(byGstin, [line(1, 100)]);
    assert.equal(t.gstType, "inter");
    assert.equal(t.placeOfSupply, "29");
    await approve(t);
  });
});

test("a customer saved with a GSTIN takes its state from it, and a bad state is refused", { skip }, async () => {
  await run(async () => {
    const made = await svc.Customers.createCustomer({ customerName: "Via Form Co", contactPerson: "A B", billingAddress: "Pune", country: "IN", vat: { status: "registered", trn: GSTIN_KA2 } });
    assert.equal(made.stateCode, "29");
    const typed = await svc.Customers.createCustomer({ customerName: "Typed State Co", contactPerson: "A B", billingAddress: "Pune", country: "IN", stateCode: "maharashtra" });
    assert.equal(typed.stateCode, "27");
    await assert.rejects(svc.Customers.createCustomer({ customerName: "Bad State Co", contactPerson: "A B", billingAddress: "Pune", country: "IN", stateCode: "Atlantis" }), { code: "INVALID_STATE" });
  });
});

test("with no state on file for the company nothing is split: the document is priced and posted exactly as before", { skip }, async () => {
  await run(async () => {
    await svc.Settings.updateOne({}, { $unset: { "profile.stateCode": "", "profile.trn": "" } });
    try {
      const t = await sell(local, [line(10, 100)]);
      assert.ok(!t.gstType && t.pricing.gst.cgst === undefined && t.items[0].gst.cgst === undefined, "no split recorded");
      assert.equal(r2(t.pricing.lineVat), 180);
      await approve(t);
      const p = await posted(t);
      assert.equal(p.byAccount["Output GST"], -180);
      assert.ok(!p.byAccount["Output CGST"]);
    } finally {
      await svc.Settings.updateOne({}, { $set: { "profile.stateCode": "27", "profile.trn": GSTIN_MH } });
    }
  });
});

test("a body cannot choose the split", { skip }, async () => {
  await run(async () => {
    const t = await sell(local, [line(10, 100, { gst: { cgst: 0, sgst: 0, igst: 180 } })], { gstType: "inter", placeOfSupply: "29" });
    assert.equal(t.gstType, "intra");
    assert.deepEqual(t.items[0].gst.toObject?.() ?? t.items[0].gst, { cgst: 90, sgst: 90, igst: 0 });
    const edited = await svc.Tx.updateTransaction(t._id, { gstType: "inter", placeOfSupply: "29", discount: 0 }, "tester");
    assert.equal(edited.gstType, "intra");
  });
});

test("the HSN code is the item master's: a request's own value is overwritten, and a bad one is refused on the item", { skip }, async () => {
  await run(async () => {
    const t = await sell(local, [line(1, 100, { hsnCode: "9999" })]);
    assert.equal(t.items[0].hsnCode, "7318");
    const StockService = require("../stock/stockService");
    const fresh = await svc.Stock.create({ itemId: "NUT", sku: "NU0001", itemName: "Nut", category: item.category }); // the bolt has been sold into negative stock above
    await assert.rejects(StockService.updateStock(fresh._id, { hsnCode: "12" }, "tester"), (e) => e.code === "INVALID_HSN");
    const updated = await StockService.updateStock(fresh._id, { hsnCode: "7318 10" }, "tester");
    assert.equal(updated.hsnCode, "731810");
    const cleared = await StockService.updateStock(fresh._id, { hsnCode: "" }, "tester");
    assert.ok(!cleared.hsnCode);
  });
});

test("GSTR-1 and GSTR-3B are built from the approved documents and reconcile to the six ledger accounts", { skip }, async () => {
  await run(async () => {
    const Gst = require("../reports/gstReturnService");
    const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
    const q = { from: day(-1), to: day(1) };

    const r1 = await Gst.gstr1(q);
    assert.ok(r1.b2cs.length >= 1, "unregistered buyers are summed by state and rate");
    assert.ok(r1.b2cs.some((x) => x.placeOfSupply === "27" && x.rate === 18));
    assert.equal(r1.b2cl.length, 0, "nothing is over a lakh");
    assert.ok(r1.b2b.some((x) => x.gstin === GSTIN_KA && x.docNo), "the buyer with only a GSTIN is registered, so it is listed invoice by invoice");
    assert.ok(r1.hsn.some((x) => x.hsnCode === "7318" && x.rate === 18));
    assert.equal(r1.totals.igst, 198, "180 from the far customer's sale, 18 from the GSTIN-only one");
    assert.ok(r1.documentsIssued.invoices.count >= 4 && r1.documentsIssued.creditNotes.count === 1);
    assert.equal(r1.notReported.withoutGstDetail.documents, 1, "the sale made while the company's state was unknown is listed apart, not guessed into a table");

    const r3 = await Gst.gstr3b(q);
    assert.ok(r3.reconciliation.rows.length === 6);
    for (const row of r3.reconciliation.rows) assert.ok(row.agrees, `${row.label}: documents ${row.documents} vs ledger ${row.ledger}`);
    assert.equal(r3.itc.total.igst, 180, "the purchase from the Karnataka supplier");
    assert.equal(r3.outward.taxable.igst, 198);
    // IGST credit of 180 pays 180 of the 198 IGST liability; the rest, and all of CGST / SGST, is cash
    assert.equal(r3.payableInCash.igst, 18);
    assert.equal(r3.creditCarriedForward.igst, 0);
    // the sale with no component detail posted 180 to the single Output GST account: shown, not lost
    assert.equal(r3.reconciliation.unsplit.output, 180);
  });
});

test("the GST routes answer an Indian organisation and refuse a UAE one, after the permission check", { skip }, async () => {
  const { hasGstReturn } = require("../../utils/countryRules");
  const plans = require("../../utils/plans");
  assert.equal(hasGstReturn({ country: "IN", planCode: "premium" }), true);
  assert.equal(hasGstReturn({ country: "AE", planCode: "premium" }), false);
  assert.equal(hasGstReturn({ country: "IN", planCode: "premium", featureOverrides: { vatReturn: false } }), false, "switched off for the organisation");
  assert.ok(plans.PLANS.premium);
});

test("a reverse-charge purchase: the assessed tax is split, claimed as input tax and owed on the reverse-charge account", { skip }, async () => {
  await run(async () => {
    const rc = await svc.TaxCode.findOne({ kind: "reverse_charge" }).lean();
    assert.equal(rc.name, "Reverse charge 18%");
    const localVendor = await svc.Vendor.create({ vendorId: "V2", vendorName: "Local Supplier", address: "Pune", paymentTerms: "Cash", stateCode: "27" });
    const t = await svc.Tx.createTransaction({
      type: "purchase_order", partyId: localVendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
      items: [line(10, 100, { taxCodeId: rc._id })],
    }, "tester");
    assert.equal(r2(t.pricing.lineVat), 0, "the supplier charged none");
    assert.equal(r2(t.pricing.rcmVat), 180);
    assert.deepEqual(t.pricing.rcmGst.toObject?.() ?? t.pricing.rcmGst, { cgst: 90, sgst: 90, igst: 0 });
    assert.equal(r2(t.totalAmount), 1000, "the vendor is owed only the net");
    await approve(t);
    const p = await posted(t);
    assert.equal(p.byAccount["Input CGST"], 90);
    assert.equal(p.byAccount["Input SGST / UTGST"], 90);
    assert.equal(p.byAccount["Reverse-charge GST"], -180);
    assert.ok(p.balanced);
    const Gst = require("../reports/gstReturnService");
    const day = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
    const r3 = await Gst.gstr3b({ from: day(-1), to: day(1) });
    assert.equal(r3.outward.reverseCharge.tax, 180);
    assert.ok(r3.reconciliation.rows.every((x) => x.agrees), JSON.stringify(r3.reconciliation.rows.filter((x) => !x.agrees)));
  });
});
