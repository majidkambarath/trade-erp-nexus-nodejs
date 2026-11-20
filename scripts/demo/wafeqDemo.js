// A test organisation for e-invoicing through Wafeq, with a few of everything to try it on.
//
//   node scripts/demo/wafeqDemo.js            (from "trade ERP node"; reads .env)
//
// Creates organisation `wafeq-test` (UAE, AED, Asia/Dubai, plan premium), links it to the Wafeq SANDBOX taxpayer, switches e-invoicing on,
// and adds 6 customers, 1 vendor, 6 items, an opening purchase, 6 approved sales invoices, 2 credit notes and 1 draft, each chosen to show
// one case Wafeq treats differently. Nothing is SENT: the invoices wait in e-Invoicing > Outbound for a person to send. At the end every
// document is checked with Wafeq's own /validate (which delivers nothing) and the result printed.
//
// Idempotent: run it again and it reuses what exists. Goes through the product's own services, never the raw collections.
// The owner's sign-in is printed once and saved in the git-ignored .env.wafeq-test.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..", "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

const CODE = "wafeq-test";
const OWNER_EMAIL = "owner@wafeq-test.local";
const SANDBOX_TAXPAYER = "txpay_fB6iiw3eaTHmGLKHl2tA"; // "Sandbox taxpayer 5504", TIN 1716865504
const BY = "wafeq-demo-script";
const TAG = "WQ-DEMO"; // every demo document carries `lpono: WQ-DEMO-<n>`, which is how a second run finds it

const tally = [];
const note = (what, created, skipped) => tally.push({ what, created, skipped });

const CUSTOMERS = [
  { key: "dxb", customerName: "Al Noor Foodstuff Trading LLC", trn: "100234567800003", emirate: "Dubai", city: "Dubai", address: "Warehouse 12, Al Quoz Industrial 3", terms: "Net 30", legal: { type: "TL", id: "784512", authority: "Dubai Economy and Tourism" } },
  { key: "auh", customerName: "Capital Hypermarket LLC", trn: "100345678900003", emirate: "Abu Dhabi", city: "Abu Dhabi", address: "Mussafah M-14, Plot 7", terms: "Net 15" },
  { key: "shj", customerName: "Sharjah Bakery Supplies FZE", trn: "100456789000003", emirate: "Sharjah", city: "Sharjah", address: "SAIF Zone, Q3-112", terms: "Net 30" },
  { key: "ajm", customerName: "Ajman Fresh Mart LLC", trn: "100567890100003", emirate: "Ajman", city: "Ajman", address: "Al Jurf Industrial 2", terms: "Cash" },
  { key: "walkin", customerName: "Karama Corner Grocery", identifier: "TL-DED-552190", emirate: "Dubai", city: "Dubai", address: "Shop 4, Karama Market" },
  { key: "cafe", customerName: "Corniche Cafeteria", identifier: "TL-RAK-30418", emirate: "Ras Al Khaimah", city: "Ras Al Khaimah", address: "Al Qawasim Corniche, Shop 2" },
];

const ITEMS = [
  { sku: "WQ-RICE", itemName: "Basmati Rice 25 kg", type: "goods", price: 95, cost: 70 },
  { sku: "WQ-OIL", itemName: "Sunflower Oil 5 L", type: "goods", price: 38, cost: 27.5 },
  { sku: "WQ-SUGAR", itemName: "White Sugar 10 kg", type: "goods", price: 29.75, cost: 21 },
  { sku: "WQ-TEA", itemName: "Tea sachet (single)", type: "goods", price: 0.1, cost: 0.05 },
  { sku: "WQ-DELIV", itemName: "Delivery charge", type: "service", price: 45 },
  { sku: "WQ-LEASE", itemName: "Staff flat lease (monthly)", type: "service", price: 4200 },
];

const newPassword = () => `Wq${crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}7`;

async function ensureOrganisation() {
  const Organisation = require("../../models/core/organisationModel");
  const existing = await Organisation.findOne({ code: CODE }).lean();
  if (existing) {
    note("organisation", 0, 1);
    return { organisation: existing, password: null };
  }
  const password = newPassword();
  const Platform = require("../../services/platform/platformOrganisationService");
  const r = await Platform.create(
    {
      code: CODE, legalName: "Wafeq Test Trading LLC", tradeName: "Wafeq Test", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai",
      planCode: "premium", firstAdmin: { name: "Wafeq Test Owner", email: OWNER_EMAIL, password },
    },
    { by: { email: BY } }
  );
  if (r.firstAdminError) throw new Error(`the organisation was made but its owner was not: ${r.firstAdminError}`);
  if (!r.provisioning?.complete) {
    const again = await require("../../services/core/organisationService").provision(CODE);
    if (!again.complete) throw new Error(`provisioning is incomplete: ${JSON.stringify(again.steps)}`);
  }
  note("organisation", 1, 0);
  return { organisation: r.organisation, password };
}

async function ownerReady(password) {
  const Admin = require("../../models/core/adminModel");
  // the owner signs in straight away: this is a test organisation and the password is in the git-ignored .env.wafeq-test
  await Admin.updateOne({ email: OWNER_EMAIL }, { $set: { mustChangePassword: false } });
  if (password) {
    fs.writeFileSync(path.join(ROOT, ".env.wafeq-test"), `# Sign-in for the wafeq-test organisation (scripts/demo/wafeqDemo.js). Git-ignored.\nWAFEQ_TEST_EMAIL=${OWNER_EMAIL}\nWAFEQ_TEST_PASSWORD=${password}\n`);
  }
}

async function companyAndWafeq() {
  const Config = require("../../services/financial/accountConfigService");
  await Config.updateSettings({ profile: {
    legalName: "Sandbox taxpayer 5504", trn: "171686550400003", addressLine1: "Sandbox test address", city: "Umm Al Quwain",
    emirate: "Umm Al Quwain", vatRegistered: true,
  } });
  const { EInvoiceSettings } = require("../../models/modules/einvoiceModels");
  const s = await EInvoiceSettings.findOne({ companyId: CODE }).lean();
  if (s?.wafeq?.status === "active" && s.wafeq.taxpayerId === SANDBOX_TAXPAYER) {
    note("Wafeq link", 0, 1);
  } else {
    const Connect = require("../../services/einvoice/wafeq/connectService");
    const link = await Connect.linkDirect(CODE, { mode: "sandbox", taxpayerId: SANDBOX_TAXPAYER }, BY);
    console.log(`    linked to Wafeq: ${link.name} (${link.participantId})`);
    note("Wafeq link", 1, 0);
  }
  const EI = require("../../services/einvoice/einvoiceService");
  await EI.updateSettings({ enabled: true });
}

async function taxCodes() {
  const TaxCode = require("../../models/modules/financial/taxCodeModel");
  const TaxCodeService = require("../../services/financial/taxCodeService");
  const codes = await TaxCode.find({ isActive: true }).lean();
  const byKind = (k) => codes.find((c) => c.kind === k);
  const std = byKind("standard");
  const zero = byKind("zero_rated");
  const exempt = byKind("exempt");
  const oos = byKind("out_of_scope");
  if (!std || !zero || !exempt) throw new Error("the UAE starter tax codes are missing - provisioning must run first");
  let changed = 0;
  if (exempt.exemptionReasonCode !== "DL8.46.2") { await TaxCodeService.update(exempt._id, { exemptionReasonCode: "DL8.46.2" }); changed += 1; }
  if (oos && oos.exemptionReasonCode !== "VATEX-AE-OOS") { await TaxCodeService.update(oos._id, { exemptionReasonCode: "VATEX-AE-OOS" }); changed += 1; }
  note("tax code reasons", changed, 2 - changed);
  return { std, zero, exempt };
}

// The Wafeq sandbox taxpayer is SHARED by every test run, and Wafeq keeps invoice numbers unique per taxpayer: an SO-2026-0001 that some
// earlier test already sent is refused as a duplicate. This organisation's invoices and credit notes get their own prefix instead.
async function numbering() {
  const VoucherTypeService = require("../../services/core/voucherTypeService");
  await VoucherTypeService.ensureDefaults({});
  let changed = 0;
  for (const [key, prefix] of [["SO", "WQS"], ["SR", "WQR"]]) {
    const vt = await VoucherTypeService.get(key, {});
    if (vt?.prefix === prefix) continue;
    await VoucherTypeService.update(key, { prefix }, { admin: { id: null, email: BY } });
    changed += 1;
  }
  note("number prefixes", changed, 2 - changed);
}

async function masters() {
  const UOM = require("../../models/modules/uomModel");
  const UOMService = require("../../services/unit/uomService");
  const Category = require("../../models/modules/categoryModel");
  const Customer = require("../../models/modules/customerModel");
  const Vendor = require("../../models/modules/vendorModel");
  const Stock = require("../../models/modules/stockModel");
  const CustomerService = require("../../services/customer/customerService");
  const VendorService = require("../../services/vendor/vendorService");
  const StockService = require("../../services/stock/stockService");

  let unit = await UOM.findOne({ unitName: "Piece" }).lean();
  if (!unit) unit = await UOMService.createUOM({ unitName: "Piece", shortCode: "pc", category: "Quantity", type: "Base", status: "Active" });
  let category = await Category.findOne({ name: "Foodstuff" }).lean();
  if (!category) category = await Category.create({ name: "Foodstuff", status: "Active" });

  const customers = {};
  let c1 = 0, c2 = 0;
  for (const c of CUSTOMERS) {
    let row = await Customer.findOne({ customerName: c.customerName }).lean();
    if (row) { c2 += 1; customers[c.key] = row; continue; }
    const registered = Boolean(c.trn);
    row = await CustomerService.createCustomer({
      customerName: c.customerName, contactPerson: "Accounts", billingAddress: c.address, country: "AE", emirate: c.emirate, city: c.city,
      paymentTerms: c.terms || "Cash",
      ...(registered ? { trnNumber: c.trn, vat: { status: "registered", trn: c.trn } } : { vat: { status: "unregistered" } }),
      eInvoice: {
        countryCode: "AE", city: c.city,
        ...(registered ? { participantId: `0235:${c.trn.slice(0, 10)}` } : { buyerIdentifier: c.identifier }),
        ...(c.legal ? { legalRegistration: c.legal } : {}),
      },
    });
    customers[c.key] = row;
    c1 += 1;
  }
  note("customers", c1, c2);

  let vendor = await Vendor.findOne({ vendorName: "Gulf Grain Importers LLC" }).lean();
  if (!vendor) {
    vendor = await VendorService.createVendor({
      vendorName: "Gulf Grain Importers LLC", contactPerson: "Sales", address: "Jebel Ali Free Zone, Dubai", country: "AE", emirate: "Dubai",
      trnNO: "100678901200003", vat: { status: "registered", trn: "100678901200003" },
    });
    note("vendor", 1, 0);
  } else note("vendor", 0, 1);

  const items = {};
  let i1 = 0, i2 = 0;
  for (const it of ITEMS) {
    let row = await Stock.findOne({ sku: it.sku }).lean();
    if (row) { i2 += 1; items[it.sku] = row; continue; }
    row = await StockService.createStock({
      sku: it.sku, itemId: it.sku, itemName: it.itemName, categoryId: category._id, unitOfMeasure: unit._id, salesPrice: it.price,
      itemType: it.type, ...(it.type === "goods" ? { purchasePrice: it.cost, origin: "UAE", brand: "Demo" } : {}),
    }, BY);
    items[it.sku] = row;
    i1 += 1;
  }
  note("items", i1, i2);
  return { customers, vendor, items };
}

async function documents({ customers, vendor, items }, { std, zero, exempt }) {
  const Transaction = require("../../models/modules/transactionModel");
  const Tx = require("../../services/orderPurchase/transactionService");
  const line = (sku, qty, price, code = std) => ({ itemId: items[sku]._id, description: items[sku].itemName, qty, price, rate: price, taxCodeId: code._id, uom: "pc" });
  const made = {};
  let created = 0, skipped = 0;

  const ensure = async (n, body, { approve = true } = {}) => {
    const lpono = `${TAG}-${n}`;
    const found = await Transaction.findOne({ lpono }).lean();
    if (found) { made[n] = found; skipped += 1; return found; }
    const t = await Tx.createTransaction({ ...body, lpono, status: "DRAFT" }, BY);
    if (approve) await Tx.processTransaction(t._id, "approve", BY);
    made[n] = await Transaction.findById(t._id).lean();
    created += 1;
    return made[n];
  };
  const sale = (cust, lines, extra = {}) => ({ type: "sales_order", partyId: customers[cust]._id, partyType: "Customer", partyTypeRef: "Customer", items: lines, ...extra });

  // opening stock for the goods
  await ensure("P1", { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", vendorReference: "GGI-2026-1188",
    items: [line("WQ-RICE", 200, 70), line("WQ-OIL", 200, 27.5), line("WQ-SUGAR", 200, 21), line("WQ-TEA", 500, 0.05)] });

  await ensure("1", sale("dxb", [line("WQ-RICE", 10, 95), line("WQ-OIL", 12, 38), line("WQ-SUGAR", 8, 29.75)]));               // plain standard 5%
  await ensure("2", sale("auh", [line("WQ-RICE", 20, 95), line("WQ-DELIV", 1, 45)]));                                          // goods + a service line
  await ensure("3", sale("shj", [line("WQ-TEA", 1, 0.1), line("WQ-TEA", 1, 0.1), line("WQ-TEA", 1, 0.1)]));                    // VAT once per rate: 0.02
  await ensure("4", sale("ajm", [line("WQ-OIL", 5, 38), line("WQ-SUGAR", 4, 29.75, zero)]));                                   // zero-rated line beside a standard one
  await ensure("5", sale("dxb", [line("WQ-LEASE", 1, 4200, exempt)]));                                                          // exempt only: a commercial invoice (480)
  await ensure("6", sale("walkin", [line("WQ-RICE", 2, 95), line("WQ-TEA", 10, 0.1)]));                                        // no TRN: the tax authority only

  // credit notes against invoices 1 and 2: one line each
  for (const [n, of, sku, qty] of [["CN1", "1", "WQ-OIL", 2], ["CN2", "2", "WQ-RICE", 1]]) {
    const o = made[of];
    const orig = o.items.find((i) => String(i.itemId) === String(items[sku]._id));
    await ensure(n, {
      type: "sales_return", partyId: o.partyId, partyType: "Customer", partyTypeRef: "Customer",
      returnOf: { transactionId: o._id, transactionNo: o.transactionNo },
      items: [{ ...line(sku, qty, orig.price), returnOfLineId: orig._id }],
    });
  }
  // a draft: not offered for sending until it is approved
  await ensure("D1", sale("cafe", [line("WQ-SUGAR", 3, 29.75)]), { approve: false });
  note("documents", created, skipped);
  return made;
}

async function selfCheck(made) {
  const EI = require("../../services/einvoice/einvoiceService");
  console.log("\n  Checked with Wafeq (validate only: nothing is sent)");
  const order = ["1", "2", "3", "4", "5", "6", "CN1", "CN2"];
  for (const n of order) {
    const d = made[n];
    const pv = await EI.preview(d._id, {});
    const w = pv.wafeq || {};
    const ours = pv.issues.length ? `OUR ISSUES: ${pv.issues.map((i) => i.message).join("; ")}` : "";
    const theirs = w.checked ? `${w.valid ? "valid" : "NOT VALID"}, route ${w.route}${w.errors?.length ? ` - ${w.errors.map((e) => e.code).join(", ")}` : ""}` : w.note || "not checked";
    const vat = (pv.payload?.taxAmount ?? 0).toFixed(2);
    console.log(`    ${d.transactionNo.padEnd(16)} ${String(pv.payload?.wafeq?.body?.document_type_code || (d.type === "sales_return" ? "381" : "380")).padEnd(4)} VAT ${vat.padStart(8)}  ${ours || theirs}`);
  }
  const docs = await EI.documents({}, { limit: 50 });
  console.log(`\n  e-Invoicing > Outbound lists ${docs.length} documents, ${docs.filter((r) => r.status === "NOT_SENT").length} not sent yet.`);
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  if (!process.env.WAFEQ_API_KEY_TEST) throw new Error("WAFEQ_API_KEY_TEST is not set in .env");
  const mongoose = require("mongoose");
  await mongoose.connect(process.env.MONGO_URI);
  // every model registered up front, as the server does: services populate across models
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".js")) require(f); } };
  walk(path.join(ROOT, "models"));
  try {
    console.log(`  Database: ${mongoose.connection.name}`);
    console.log("  Organisation...");
    const { organisation, password } = await ensureOrganisation();
    require("../../utils/orgLocale").warm(organisation);
    const { runWithTenant } = require("../../utils/tenantContext");
    await runWithTenant({ companyId: CODE, branchId: "main" }, async () => {
      await ownerReady(password);
      console.log("  Company identity, Wafeq link, e-invoicing on...");
      await companyAndWafeq();
      console.log("  Tax codes...");
      const codes = await taxCodes();
      console.log("  Numbering...");
      await numbering();
      console.log("  Customers, vendor, items...");
      const m = await masters();
      console.log("  Documents...");
      const made = await documents(m, codes);
      await selfCheck(made);
    });
    console.log("\n  What was done");
    for (const r of tally) console.log(`    ${r.what.padEnd(18)} ${String(r.created).padStart(3)} created, ${String(r.skipped).padStart(3)} already there`);
    if (password) {
      console.log("\n  ----------------------------------------------------------------");
      console.log(`  Sign in at http://localhost:5173 as ${OWNER_EMAIL}`);
      console.log(`  Password ${password}   (also in trade ERP node/.env.wafeq-test)`);
      console.log("  ----------------------------------------------------------------");
    } else {
      console.log("\n  Sign-in: see trade ERP node/.env.wafeq-test");
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(`\n  FAILED: ${err.code ? `${err.code} ` : ""}${err.message}`);
  if (err.details) console.error(JSON.stringify(err.details).slice(0, 1500));
  process.exit(1);
});
