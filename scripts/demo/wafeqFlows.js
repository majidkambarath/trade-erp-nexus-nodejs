// Every e-invoicing flow in the wafeq-test organisation, so each screen and dashboard tile has something behind it.
//
//   node scripts/demo/wafeqFlows.js            (from "trade ERP node"; run scripts/demo/wafeqDemo.js first)
//
// What can be real IS real: invoices are sent through the Wafeq SANDBOX, a credit note is sent, an invoice sent to ourselves comes back as a
// received one. The sandbox never reports to the tax authority and its buyers never reject, so those states are DEMO EVENTS, applied through
// the product's own status path (EInvoiceService.applyStatus, the one webhooks and polling use) and marked "Demo:" in the invoice's history.
// Two sends are made to fail on purpose (a Wafeq outage, a refusal) by wrapping the one function that reaches the network.
// Supplier invoices are entered through InboundService.ingest (source "manual"). Idempotent: run it again and nothing is duplicated.
const path = require("path");
const fs = require("fs");
const ROOT = path.resolve(__dirname, "..", "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

const CODE = "wafeq-test";
const BY = "wafeq-flows-script";
const TAG = "WQ-FLOW";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = []; // the report: what, how, real or demo

async function realFetch(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: json, text };
}

// Make the next send fail the way Wafeq would: `fail` is { status, body } or null (pass through).
const net = { fail: null };
function installNetwork() {
  const { WafeqClient } = require("../../services/einvoice/wafeq/client");
  WafeqClient.useHttp(async (url, opts) => {
    if (net.fail && opts?.method === "POST" && /\/(invoices|credit-notes)$/.test(url)) {
      const f = net.fail; net.fail = null;
      return { status: f.status, headers: {}, body: f.body, text: JSON.stringify(f.body) };
    }
    return realFetch(url, opts);
  });
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  const mongoose = require("mongoose");
  await mongoose.connect(process.env.MONGO_URI);
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".js")) require(f); } };
  walk(path.join(ROOT, "models"));
  try {
    const Organisation = require("../../models/core/organisationModel");
    const org = await Organisation.findOne({ code: CODE }).lean();
    if (!org) throw new Error("the wafeq-test organisation is missing: run scripts/demo/wafeqDemo.js first");
    require("../../utils/orgLocale").warm(org);
    installNetwork();
    const { runWithTenant } = require("../../utils/tenantContext");
    await runWithTenant({ companyId: CODE, branchId: "main" }, run);
  } finally {
    await mongoose.disconnect();
  }
}

async function run() {
  const Transaction = require("../../models/modules/transactionModel");
  const Customer = require("../../models/modules/customerModel");
  const Vendor = require("../../models/modules/vendorModel");
  const Stock = require("../../models/modules/stockModel");
  const TaxCode = require("../../models/modules/financial/taxCodeModel");
  const { EInvoiceSubmission, InboundInvoice } = require("../../models/modules/einvoiceModels");
  const Tx = require("../../services/orderPurchase/transactionService");
  const VendorService = require("../../services/vendor/vendorService");
  const EI = require("../../services/einvoice/einvoiceService");
  const Inbound = require("../../services/einvoice/inboundService");
  const Pull = require("../../services/einvoice/wafeq/inboundPull");
  const req = {};

  console.log("  Settings and suppliers...");
  await EI.updateSettings({ startDate: "2026-10-01" });
  const std = await TaxCode.findOne({ kind: "standard", isActive: true }).lean();
  if (!std) throw new Error("no standard tax code");
  const cust = async (name) => { const c = await Customer.findOne({ customerName: name }).lean(); if (!c) throw new Error(`customer missing: ${name}`); return c; };
  const item = async (sku) => { const s = await Stock.findOne({ sku }).lean(); if (!s) throw new Error(`item missing: ${sku} (run wafeqDemo.js first)`); return s; };
  const buyers = {
    dxb: await cust("Al Noor Foodstuff Trading LLC"), auh: await cust("Capital Hypermarket LLC"), shj: await cust("Sharjah Bakery Supplies FZE"),
    ajm: await cust("Ajman Fresh Mart LLC"), cafe: await cust("Corniche Cafeteria"), walkin: await cust("Karama Corner Grocery"),
  };
  const items = { rice: await item("WQ-RICE"), oil: await item("WQ-OIL"), sugar: await item("WQ-SUGAR"), deliv: await item("WQ-DELIV") };

  const vendor = async (vendorName, extra) => {
    let v = await Vendor.findOne({ vendorName }).lean();
    if (!v) v = await VendorService.createVendor({ vendorName, contactPerson: "Sales", country: "AE", vat: { status: "registered", trn: extra.trn }, trnNO: extra.trn, ...extra.data });
    return v;
  };
  const pack = await vendor("Emirates Packaging Industries LLC", { trn: "100777666500003", data: { address: "Industrial Area 11, Sharjah", emirate: "Sharjah" } });
  const dairy = await vendor("Al Ain Dairy Farms LLC", { trn: "100888999100003", data: { address: "Al Ain Industrial Area", emirate: "Abu Dhabi" } });
  const grain = await Vendor.findOne({ vendorName: "Gulf Grain Importers LLC" }).lean();

  const line = (it, qty, price) => ({ itemId: it._id, description: it.itemName, qty, price, rate: price, taxCodeId: std._id, uom: "pc" });
  const ensure = async (n, body, { approve = true } = {}) => {
    const lpono = `${TAG}-${n}`;
    const found = await Transaction.findOne({ lpono }).lean();
    if (found) return found;
    const t = await Tx.createTransaction({ ...body, lpono, status: "DRAFT" }, BY);
    if (approve) await Tx.processTransaction(t._id, "approve", BY);
    return Transaction.findById(t._id).lean();
  };
  const sale = (who, lines, date) => ({ type: "sales_order", partyId: buyers[who]._id, partyType: "Customer", partyTypeRef: "Customer", date: new Date(`${date}T00:00:00Z`), items: lines });
  const subOf = (d) => EInvoiceSubmission.findOne({ sourceType: "Transaction", sourceId: d._id });
  const send = async (d) => { const s = await subOf(d); if (s) return s; return (await EI.submit(d._id, req)).submission; };
  // a Wafeq event that the sandbox cannot produce, put through the same step the webhook uses
  const demo = async (d, event) => {
    let s = await subOf(d);
    if (["REJECTED", "REPORTED"].includes(s.status)) return s;
    return EI.applyStatus(s, { ...event, note: `Demo: ${event.note}` });
  };
  const record = (key, doc, how, real) => rows.push({ key, doc: doc.transactionNo, how, real });

  console.log("  Purchase orders for the suppliers to bill...");
  const po = await ensure("PO1", { type: "purchase_order", partyId: pack._id, partyType: "Vendor", partyTypeRef: "Vendor", vendorReference: "EPI-PO-0230",
    date: new Date("2026-10-20T00:00:00Z"), items: [line(items.rice, 40, 70)] });

  console.log("  Outbound invoices...");
  const F1 = await ensure("F1", sale("dxb", [line(items.rice, 6, 95)], "2026-10-28"));
  record("F1", F1, "Not sent, overdue to send", "-");
  const F2 = await ensure("F2", sale("auh", [line(items.oil, 20, 38), line(items.sugar, 10, 29.75)], "2026-10-05"));
  let s2 = await send(F2);
  for (let i = 0; i < 6 && s2.status === "SUBMITTED"; i += 1) { await sleep(2500); s2 = await EI.refreshOne(await subOf(F2)); }
  record("F2", F2, `Delivered (${s2.status})`, "Real");

  const spec = [
    ["F3", "shj", "2026-09-18", { status: "REPORTED", taxStatus: "reported", note: "reported to the tax authority", extra: { deliveryStatus: "delivered" } }, "Reported to the FTA", "Demo"],
    ["F4", "ajm", "2026-10-12", { status: "REJECTED", note: "Rejected by the buyer: buyer details are wrong", extra: { deliveryStatus: "rejected", reasonCode: "BV", reasonText: "Buyer name does not match the registered name", rejectedBy: "buyer" } }, "Rejected by buyer, BV (can be corrected)", "Demo"],
    ["F5", "cafe", "2026-10-15", { status: "REJECTED", note: "Rejected by the buyer: seller details are wrong", extra: { deliveryStatus: "rejected", reasonCode: "SV", reasonText: "Seller address differs from the registered address", rejectedBy: "buyer" } }, "Rejected by buyer, SV (can be corrected)", "Demo"],
    ["F6", "walkin", "2026-10-22", { status: "REJECTED", note: "Rejected by the buyer: goods disputed", extra: { deliveryStatus: "rejected", reasonCode: "FD", reasonText: "Goods were never ordered", rejectedBy: "buyer" } }, "Rejected by buyer, FD (credit note and new invoice)", "Demo"],
    ["F7", "dxb", "2026-11-03", { status: "REJECTED", taxStatus: "not_compliant", note: "Not compliant with the FTA", extra: { rejectedBy: "fta" } }, "Rejected by the FTA", "Demo"],
  ];
  const made = { F2 };
  for (const [key, who, date, event, how, real] of spec) {
    const d = await ensure(key, sale(who, [line(items.rice, 4 + spec.findIndex((x) => x[0] === key), 95), line(items.oil, 3, 38)], date));
    await send(d);
    await demo(d, event);
    record(key, d, how, `${real} event on a real send`);
    made[key] = d;
  }

  const F8 = await ensure("F8", sale("auh", [line(items.sugar, 12, 29.75)], "2026-11-10"));
  if (!(await subOf(F8))) { net.fail = { status: 503, body: { error: "service_unavailable", message: "Wafeq is temporarily unavailable" } }; await EI.submit(F8._id, req); }
  record("F8", F8, "Failed: Wafeq unreachable. The automatic retry sends it within minutes", "Real send, simulated outage");
  const F9 = await ensure("F9", sale("shj", [line(items.oil, 9, 38)], "2026-11-12"));
  if (!(await subOf(F9))) { net.fail = { status: 422, body: { validation_errors: [{ code: "PINT-AE-R042", message: "The buyer reference is not accepted (demo refusal)" }] } }; await EI.submit(F9._id, req); }
  record("F9", F9, "Failed: refused by Wafeq. Stays until Retry is pressed", "Real send, simulated refusal");

  console.log("  Credit notes...");
  const orig = F2.items[0];
  const CN = await ensure("CN3", { type: "sales_return", partyId: F2.partyId, partyType: "Customer", partyTypeRef: "Customer", date: new Date("2026-11-08T00:00:00Z"),
    returnOf: { transactionId: F2._id, transactionNo: F2.transactionNo }, items: [{ ...line(items.oil, 2, orig.price), returnOfLineId: orig._id }] });
  await send(CN);
  record("F10", CN, "Credit note sent", "Real");
  const reported = made.F3;
  if (!(await Transaction.findOne({ "returnOf.transactionId": reported._id }))) await EI.creditInFull(reported._id, { admin: { id: BY } });
  record("F11", reported, "Credit in full drafted: see Sales > Returns", "Real");

  console.log("  Invoice to ourselves, and what comes back...");
  const self = await Transaction.findOne({ lpono: "WQ-DEMO-7" }).lean();
  if (self) { const s = await send(self); record("F12", self, `Sent to ourselves (${s.status})`, "Real"); }
  await sleep(4000);
  const pulled = await Pull.pull(CODE, { force: true }).catch((e) => ({ error: e.message }));
  console.log(`    Wafeq pull: ${JSON.stringify(pulled)}`);

  console.log("  Supplier invoices...");
  const L = (name, qty, net, rate = 5) => ({ itemName: name, quantity: qty, lineNetAmount: net, lineTaxAmount: Math.round(net * rate) / 100, taxCategory: "S", taxRatePercent: rate });
  const inv = async (id, who, documentId, date, lines, { ref, kind, trn, name } = {}) => {
    const net = lines.reduce((t, l) => t + l.lineNetAmount, 0), tax = lines.reduce((t, l) => t + l.lineTaxAmount, 0);
    const r = await Inbound.ingest({ providerId: `demo-${id}`, documentId, issueDate: date, sellerName: name || who.vendorName, sellerVatTrn: trn || who.trnNO,
      invoiceRef: ref, lineExtensionTotal: net, taxAmount: tax, payableAmount: net + tax, lines }, { source: "manual", req, extra: kind ? { kind } : {} });
    return r.invoice;
  };
  const poGrain = await Transaction.findOne({ lpono: "WQ-DEMO-P1" }).lean();
  const todo = async (i) => (await InboundInvoice.findById(i._id)).status === "RECEIVED";
  const I1 = await inv("I1", grain, "GGI-2026-1301", "2026-11-14", [L("Basmati Rice 25 kg", 20, 1400)], { ref: poGrain?.transactionNo });
  const I2 = await inv("I2", grain, "GGI-2026-1288", "2026-10-30", [L("Sunflower Oil 5 L", 40, 1100)]);
  if (await todo(I2)) await Inbound.recordAsPurchase(I2._id, { lines: [{ itemId: String(items.oil._id) }] }, { admin: { id: BY } });
  const I3 = await inv("I3", pack, "EPI-2026-0415", "2026-11-05", [L("Packaging cartons", 500, 750)], { ref: po.transactionNo });
  if (await todo(I3)) await Inbound.decide(I3._id, "ACCEPTED", {}, req);
  const I4 = await inv("I4", pack, "EPI-2026-0416", "2026-11-06", [L("Packaging film rolls", 30, 2200)]);
  if (await todo(I4)) await Inbound.decide(I4._id, "REJECTED", { reason: `Prices do not match purchase order ${po.transactionNo}` }, req);
  const I5 = await inv("I5", dairy, "AAD-2026-0412", "2026-11-09", [L("Fresh milk 1 L (crate)", 60, 900)]);
  if (await todo(I5)) await Inbound.decide(I5._id, "REJECTED", { reason: "Duplicate of invoice AAD-2026-0411 already received" }, req);
  await inv("I6", null, "DLS-2026-0087", "2026-11-17", [L("Office stationery", 1, 640)], { trn: "100999888700003", name: "Desert Lights Stationery LLC" });
  await inv("I7", grain, "GGI-CN-2026-0031", "2026-11-18", [L("Basmati Rice 25 kg (damaged on arrival)", -2, -140)], { kind: "credit_note", ref: "GGI-2026-1301" });

  console.log("\n  Outbound");
  const docs = await EI.documents(req, { limit: 100 });
  for (const r of rows) {
    const d = docs.find((x) => x.transactionNo === r.doc);
    console.log(`    ${r.key.padEnd(4)} ${r.doc.padEnd(14)} ${String(d?.status || "?").padEnd(13)} ${String(d?.deliveryStatus || "-").padEnd(10)} ${String(d?.taxStatus || "-").padEnd(13)} ${String(d?.deliveryReasonCode || "").padEnd(3)} ${r.how} [${r.real}]`);
  }
  console.log("\n  Inbound");
  const list = await Inbound.list(req, { limit: 50 });
  for (const i of list.rows || list) console.log(`    ${String(i.documentId).padEnd(18)} ${String(i.status).padEnd(9)} ${String(i.kind || "invoice").padEnd(12)} ${i.sellerName} ${i.matchedVendorId ? "" : "(supplier not matched)"} ${i.decision?.reason || ""}`);
  const dash = await EI.dashboard(req, { from: "2026-11-01", to: "2026-11-30" });
  console.log(`\n  Dashboard to-do: ${dash.todo.filter((t) => t.count).map((t) => `${t.key}=${t.count}`).join(", ") || "all clear"}`);
}

main().catch((err) => {
  console.error(`\n  FAILED: ${err.code ? `${err.code} ` : ""}${err.message}`);
  if (err.details) console.error(JSON.stringify(err.details).slice(0, 1500));
  process.exit(1);
});
