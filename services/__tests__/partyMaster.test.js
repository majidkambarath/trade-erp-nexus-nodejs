// Customer / vendor master data: group roles, VAT configuration, credit terms, contacts, bank
// accounts, KYC documents, the document-type master, expiry, and creating a party from the account
// form. Runs against a throwaway database (see partyAccounts.test.js).
//
//   npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// 15-digit TRNs, 23-character UAE IBAN, 8 / 11 character BICs
const TRN_A = "100123456700003";
const TRN_B = "100123456700011";
const TRN_C = "100123456700029";
const IBAN = "AE070331234567890123456";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");

let svc;
let server;
let base;
let tokens = {};
const createdFiles = [];

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Groups: require("../financial/accountGroupService"),
    Chart: require("../financial/chartOfAccountsService"),
    PartyAccount: require("../financial/partyAccountService"),
    PartyAccounts: require("../financial/partyAccounts"),
    Customers: require("../customer/customerService"),
    Vendors: require("../vendor/vendorService"),
    DocTypes: require("../masters/documentTypeService"),
    Expiry: require("../masters/documentExpiryService"),
    Attachments: require("../core/attachmentService"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    Admin: require("../../models/core/adminModel"),
    ...require("../../models/modules/financial/financialModels"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Attachment: require("../../models/modules/financial/attachmentModel"),
    DocumentType: require("../../models/modules/documentTypeModel"),
    BankMaster: require("../../models/modules/banking/bankingModels").BankMaster,
    Ageing: require("../financial/ageingService"),
    expiry: require("../../utils/documentExpiry"),
    partyMaster: require("../../utils/partyMaster"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault(); // an account must belong to an organisation that exists, as the server arranges at start-up
  await svc.seed({ log: () => {} });

  // the three new routers, mounted the way server.js will mount them
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/document-types", require("../../routes/masters/documentTypeRoutes"));
  app.use("/api/v1/document-expiry", require("../../routes/masters/documentExpiryRoutes"));
  app.use("/api/v1/accounting", require("../../routes/financial/partyAccountRoutes"));
  app.use(require("../../utils/errorHandler"));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const { generateTokens } = require("../core/adminService");
  for (const type of ["super_admin", "viewer"]) {
    const admin = await new svc.Admin({ name: type, email: `${type}@test.uae`, password: "12312312", type, status: "active", isActive: true }).save();
    tokens[type] = generateTokens({ id: admin._id, email: admin.email, type: admin.type, permissions: admin.permissions, name: admin.name }).accessToken;
  }
});

test.after(async () => {
  if (skip) return;
  await new Promise((resolve) => server?.close(resolve));
  for (const f of createdFiles) await fs.promises.rm(f, { force: true });
  if (mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => { assert.equal(err.code, code, err.message); return true; });
const accountOf = (name) => svc.LedgerAccount.findOne({ accountName: name });
const groupByName = (name) => svc.AccountGroup.findOne({ name });
const makeGroup = (name, prefix, category, parent) => svc.AccountGroup.create({ companyId: "default", name, prefix, category, parentGroup: parent?._id || null });
const customer = (name, extra = {}) => ({ customerName: name, contactPerson: "Sara Khan", billingAddress: "Deira, Dubai", ...extra });
const vendor = (name, extra = {}) => ({ vendorName: name, contactPerson: "Omar Ali", address: "Jebel Ali", ...extra });
const call = async (method, url, { body, token = tokens.super_admin } = {}) => {
  const res = await fetch(`${base}${url}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return { status: res.status, json, body: json.data };
};
async function upload(name = "licence.pdf") {
  const a = await svc.Attachments.save({ originalname: name, buffer: PDF, size: PDF.length }, { uploadedBy: "tester" });
  createdFiles.push(svc.Attachments.filePath(a));
  return a;
}

// ---------------------------------------------------------------------------------------------
// group roles
// ---------------------------------------------------------------------------------------------

test("every group gets a role from the posting map, and groups nested under a mapped one inherit it", { skip }, async () => {
  const ar = await groupByName("Accounts Receivable");
  const ap = await groupByName("Accounts Payable");
  const retail = await makeGroup("Retail Customers", "RTL", "ASSET", ar);
  const shops = await makeGroup("Corner Shops", "SHOP", "ASSET", retail); // two levels down
  const detached = await makeGroup("Prepaid Expenses", "PRE", "ASSET", await groupByName("Current Assets"));

  const list = await svc.Groups.list({});
  const role = (name) => list.find((g) => g.name === name).role;
  assert.equal(role("Cash"), "cash");
  assert.equal(role("Bank"), "bank");
  assert.equal(role("Accounts Receivable"), "receivable");
  assert.equal(role("Accounts Payable"), "payable");
  assert.equal(role("Credit Cards"), "creditCard");
  assert.equal(role("Retail Customers"), "receivable");
  assert.equal(role("Corner Shops"), "receivable", "a descendant of a descendant inherits too");
  assert.equal(role("Current Assets"), "other", "the parent of a mapped group is not itself that role");
  assert.equal(role("Prepaid Expenses"), "other");
  assert.equal(role("Sales Income"), "other");

  const chart = await svc.Chart.getChart({});
  const nodes = (n) => [n, ...n.children.flatMap(nodes)];
  const all = chart.categories.flatMap((c) => c.groups.flatMap(nodes));
  assert.equal(all.find((g) => String(g._id) === String(shops._id)).role, "receivable");
  assert.equal(all.find((g) => String(g._id) === String(ap._id)).role, "payable");
  assert.equal(all.find((g) => String(g._id) === String(detached._id)).role, "other");
  assert.ok(all.every((g) => g.role), "every chart node carries a role");

  assert.equal(await svc.Config.roleOfGroup(shops._id), "receivable");
  assert.equal(await svc.Config.roleOfGroup(null), "other");
});

test("the nearest mapped ancestor decides, and an unmapped key leaves the group as 'other'", () => {
  const groups = [{ _id: "a", parentGroup: null }, { _id: "b", parentGroup: "a" }, { _id: "c", parentGroup: "b" }, { _id: "d", parentGroup: null }];
  const roles = svcConfig().resolveGroupRoles(
    [
      { configKey: "bank-account-group", targetGroup: "a", isActive: true },
      { configKey: "cash-account-group", targetGroup: "b", isActive: true },
      { configKey: "account-payable-group", targetGroup: null, isActive: true },
    ],
    groups
  );
  assert.deepEqual([...roles.entries()], [["a", "bank"], ["b", "cash"], ["c", "cash"], ["d", "other"]]);
});
function svcConfig() { return require("../financial/accountConfigService"); }

// ---------------------------------------------------------------------------------------------
// VAT configuration
// ---------------------------------------------------------------------------------------------

test("a registered customer needs a 15-digit TRN, and a TRN belongs to one customer", { skip }, async () => {
  const c = await svc.Customers.createCustomer(customer("Al Noor Mart", { vat: { status: "registered", trn: TRN_A, tradeLicenseNo: "TL-77" } }));
  assert.equal(c.vat.status, "registered");
  assert.equal(c.vat.trn, TRN_A);
  assert.equal(c.trnNumber, TRN_A, "the legacy field follows");
  assert.equal(c.vat.tradeLicenseNo, "TL-77");

  await rejectsWith(svc.Customers.createCustomer(customer("Short TRN", { vat: { status: "registered", trn: "12345" } })), "INVALID_TRN");
  await rejectsWith(svc.Customers.createCustomer(customer("Letters TRN", { vat: { status: "registered", trn: "10012345670000A" } })), "INVALID_TRN");
  await rejectsWith(svc.Customers.createCustomer(customer("No TRN", { vat: { status: "registered" } })), "TRN_REQUIRED");
  await rejectsWith(svc.Customers.createCustomer(customer("Zone TRN", { vat: { status: "designated_zone", trn: "999" } })), "INVALID_TRN");
  await rejectsWith(svc.Customers.createCustomer(customer("Twin", { vat: { status: "registered", trn: TRN_A } })), "DUPLICATE_TRN");
  await rejectsWith(svc.Customers.createCustomer(customer("Twin 2", { trnNumber: ` ${TRN_A.slice(0, 5)} ${TRN_A.slice(5)} ` })), "DUPLICATE_TRN"); // legacy field, spaces ignored
  await rejectsWith(svc.Customers.createCustomer(customer("Bad Status", { vat: { status: "maybe" } })), "INVALID_VAT_STATUS");
  await rejectsWith(svc.Customers.createCustomer(customer("Unreg With TRN", { vat: { status: "unregistered", trn: TRN_B } })), "TRN_NOT_ALLOWED");
  assert.equal(await svc.Customer.countDocuments({ customerName: /^(Short TRN|Letters TRN|No TRN|Zone TRN|Twin|Bad Status|Unreg With TRN)/ }), 0, "a refused customer leaves nothing behind");

  const zone = await svc.Customers.createCustomer(customer("Jafza Trading", { vat: { status: "designated_zone", trn: TRN_B } }));
  assert.equal(zone.vat.status, "designated_zone");
  const exempt = await svc.Customers.createCustomer(customer("Charity Kitchen", { vat: { status: "exempt" } }));
  assert.equal(exempt.vat.status, "exempt");
  assert.equal(exempt.trnNumber, null);
});

test("status defaults from the TRN, the legacy field still works on its own, and an older record reads correctly", { skip }, async () => {
  const legacy = await svc.Customers.createCustomer(customer("Legacy Client Co", { trnNumber: TRN_C }));
  assert.equal(legacy.vat.status, "registered", "a TRN and no status means registered");
  const none = await svc.Customers.createCustomer(customer("No VAT Client"));
  assert.equal(none.vat.status, "unregistered");
  assert.equal(none.vat.trn ?? null, null);

  // clearing the TRN the old way turns a registered party into an unregistered one
  const cleared = await svc.Customers.updateCustomer(legacy._id, { trnNumber: "" });
  assert.equal(cleared.vat.status, "unregistered");
  assert.equal(cleared.trnNumber, null);
  // and the TRN can be given again, to the same record
  const again = await svc.Customers.updateCustomer(legacy._id, { trnNumber: TRN_C });
  assert.equal(again.vat.status, "registered");

  // a record saved before the block existed: no vat in the database, derived on the way out
  const rawId = new mongoose.Types.ObjectId();
  await svc.Customer.collection.insertOne({
    _id: rawId, customerId: "RAWC1", customerName: "Pre-Master Customer", contactPerson: "x", trnNumber: "ABC-OLD-TRN", paymentTerms: "Net 45",
    status: "Active", creditLimit: 0, createdAt: new Date(), updatedAt: new Date(),
  });
  const raw = await svc.Customer.findById(rawId);
  assert.equal(raw.vat.trn, undefined, "nothing is stored in the VAT block for it");
  const out = JSON.parse(JSON.stringify(raw));
  assert.equal(out.vat.status, "registered");
  assert.equal(out.vat.trn, "ABC-OLD-TRN");
  assert.equal(out.credit.days, 45);
  // editing an unrelated field on it does not trip over the loose TRN
  const edited = await svc.Customers.updateCustomer(raw._id, { phone: "+971501234567" });
  assert.equal(edited.phone, "+971501234567");
  // changing the TRN does
  await rejectsWith(svc.Customers.updateCustomer(raw._id, { trnNumber: "123" }), "INVALID_TRN");
});

test("a TRN saved through the older field alone (as the e-invoice readiness page does) reaches the VAT block, and the other way round", { skip }, async () => {
  const c = await svc.Customers.createCustomer(customer("Sync Co", { vat: { status: "registered", trn: "100999000000010" } }));
  const doc = await svc.Customer.findById(c._id);
  doc.trnNumber = "100999000000028";
  await doc.save();
  let stored = await svc.Customer.findById(c._id).lean();
  assert.equal(stored.vat.trn, "100999000000028");
  assert.equal(stored.vat.status, "registered");
  doc.trnNumber = null;
  await doc.save();
  stored = await svc.Customer.findById(c._id).lean();
  assert.equal(stored.vat.trn ?? null, null);
  assert.equal(stored.vat.status, "unregistered", "a cleared TRN means unregistered");

  const v = await svc.Vendors.createVendor(vendor("Sync Vendor"));
  const vdoc = await svc.Vendor.findById(v._id);
  vdoc.vat.trn = "100999000000036";
  await vdoc.save();
  assert.equal((await svc.Vendor.findById(v._id).lean()).trnNO, "100999000000036");
});

test("vendors follow the same VAT rules, and a TRN may be held by one customer and one vendor", { skip }, async () => {
  const v = await svc.Vendors.createVendor(vendor("Gulf Mills", { vat: { status: "registered", trn: TRN_A } }));
  assert.equal(v.vat.trn, TRN_A);
  assert.equal(v.trnNO, TRN_A);
  await rejectsWith(svc.Vendors.createVendor(vendor("Gulf Mills Twin", { trnNO: TRN_A })), "DUPLICATE_TRN");
  await rejectsWith(svc.Vendors.createVendor(vendor("Short Vendor", { vat: { status: "registered", trn: "1234" } })), "INVALID_TRN");
  const other = await svc.Vendors.createVendor(vendor("Dubai Dates", { trnNO: TRN_B }));
  const moved = svc.Vendors.updateVendor(other._id, { vat: { status: "registered", trn: TRN_A } });
  await rejectsWith(moved, "DUPLICATE_TRN");
  const ok = await svc.Vendors.updateVendor(other._id, { vat: { status: "exempt", trn: TRN_B, tradeLicenseNo: "DED-1" } });
  assert.equal(ok.vat.status, "exempt");
  assert.equal(ok.vat.tradeLicenseNo, "DED-1");
});

// ---------------------------------------------------------------------------------------------
// credit terms
// ---------------------------------------------------------------------------------------------

test("credit days and payment terms stay in step, and ageing reads the same number of days", { skip }, async () => {
  const dflt = await svc.Customers.createCustomer(customer("Terms Default"));
  assert.equal(dflt.paymentTerms, "Net 30");
  assert.equal(dflt.credit.days, 30);

  const fromTerms = await svc.Customers.createCustomer(customer("Terms Label", { paymentTerms: "Net 45" }));
  assert.equal(fromTerms.credit.days, 45);

  const fromDays = await svc.Customers.createCustomer(customer("Terms Days", { credit: { days: 90 } }));
  assert.equal(fromDays.paymentTerms, "Net 90");
  assert.equal(svc.Ageing.termDays(fromDays.paymentTerms), 90);

  const cod = await svc.Customers.createCustomer(customer("Terms COD", { paymentTerms: "Cash on Delivery", creditLimit: 5000 }));
  assert.equal(cod.credit.days, 0);
  assert.equal(cod.creditLimit, 5000, "the limit stays where it was");

  // changing only the days changes the label; changing only the label changes the days
  const a = await svc.Customers.updateCustomer(dflt._id, { credit: { days: 60 } });
  assert.deepEqual([a.paymentTerms, a.credit.days], ["Net 60", 60]);
  const b = await svc.Customers.updateCustomer(dflt._id, { paymentTerms: "Prepaid" });
  assert.deepEqual([b.paymentTerms, b.credit.days], ["Prepaid", 0]);
  const keep = await svc.Customers.updateCustomer(dflt._id, { credit: { days: 0 } });
  assert.equal(keep.paymentTerms, "Prepaid", "zero days keeps the label that already means zero");

  await rejectsWith(svc.Customers.createCustomer(customer("Terms Bad", { paymentTerms: "Whenever" })), "INVALID_PAYMENT_TERMS");
  await rejectsWith(svc.Customers.createCustomer(customer("Terms Neg", { credit: { days: -1 } })), "INVALID_CREDIT_DAYS");
  await rejectsWith(svc.Customers.createCustomer(customer("Terms Far", { credit: { days: 400 } })), "INVALID_CREDIT_DAYS");

  const vend = await svc.Vendors.createVendor(vendor("Vendor Days", { paymentTerms: "45 days", credit: { days: 45 } }));
  assert.deepEqual([vend.paymentTerms, vend.credit.days], ["45 days", 45], "a vendor keeps its own wording when it already means that many days");
  assert.equal((await svc.Vendors.createVendor(vendor("Vendor Days Only", { credit: { days: 45 } }))).paymentTerms, "Net 45");
  const vcod = await svc.Vendors.createVendor(vendor("Vendor COD", { paymentTerms: "COD" }));
  assert.equal(vcod.credit.days, 0);
  const v90 = await svc.Vendors.updateVendor(vend._id, { credit: { days: 90 } });
  assert.equal(v90.paymentTerms, "Net 90");
});

test("createCustomer keeps the e-invoice details and the shelf-life minimum it used to drop", { skip }, async () => {
  const c = await svc.Customers.createCustomer(customer("E-Invoice Buyer", {
    trnNumber: TRN_B.replace("11", "37"), eInvoice: { participantId: "0235:100123456700037", city: "Dubai", countryCode: "ae" }, minShelfLifeDays: 45,
  }));
  const stored = await svc.Customer.findById(c._id).lean();
  assert.equal(stored.eInvoice.participantId, "0235:100123456700037");
  assert.equal(stored.eInvoice.city, "Dubai");
  assert.equal(stored.eInvoice.countryCode, "AE");
  assert.equal(stored.minShelfLifeDays, 45);
  await rejectsWith(svc.Customers.createCustomer(customer("Bad Shelf", { minShelfLifeDays: -3 })), "INVALID_SHELF_LIFE");

  const v = await svc.Vendors.createVendor(vendor("Peppol Vendor", { participantId: "0235:100123456700045" }));
  assert.equal((await svc.Vendor.findById(v._id).lean()).participantId, "0235:100123456700045");
});

test("names keep their inner spaces (the contact person was being squeezed into one word)", { skip }, async () => {
  const c = await svc.Customers.createCustomer(customer("Spacing Co", { contactPerson: "  Sara   Al Khan ", salesPerson: "Omar  Ali" }));
  assert.equal(c.contactPerson, "Sara Al Khan");
  assert.equal(c.salesPerson, "Omar Ali");
});

test("a website is kept as typed, checked for shape, and can be cleared", { skip }, async () => {
  const c = await svc.Customers.createCustomer(customer("Web Co", { website: " www.webco.ae " }));
  assert.equal(c.website, "www.webco.ae");
  await rejectsWith(svc.Customers.createCustomer(customer("Bad Web Co", { website: "not a site" })), "INVALID_WEBSITE");
  assert.equal((await svc.Customers.updateCustomer(c._id, { website: "https://webco.ae/shop" })).website, "https://webco.ae/shop");
  assert.equal((await svc.Customers.updateCustomer(c._id, { website: "" })).website, "");
  const v = await svc.Vendors.createVendor(vendor("Web Vendor", { website: "webvendor.ae" }));
  assert.equal(v.website, "webvendor.ae");
});

// ---------------------------------------------------------------------------------------------
// contacts and bank accounts
// ---------------------------------------------------------------------------------------------

test("contacts: exactly one primary, the first when none is chosen; the flat contact fields follow it", { skip }, async () => {
  const c = await svc.Customers.createCustomer({
    customerName: "Contacts Co", billingAddress: "Deira",
    contacts: [{ name: "Huda Saeed", designation: "Buyer", email: "Huda@Contacts.AE", phone: "+971 50 111 2222" }, { name: "Majid Rashid", designation: "Accounts" }],
  });
  assert.deepEqual(c.contacts.map((x) => x.isPrimary), [true, false]);
  assert.equal(c.contacts[0].email, "huda@contacts.ae");
  assert.equal(c.contactPerson, "Huda Saeed", "contactPerson was left blank, so it takes the primary contact");
  assert.equal(c.email, "huda@contacts.ae");

  const swapped = await svc.Customers.updateCustomer(c._id, { contacts: [{ name: "Huda Saeed" }, { name: "Majid Rashid", isPrimary: true }] });
  assert.deepEqual(swapped.contacts.map((x) => x.isPrimary), [false, true]);

  await rejectsWith(svc.Customers.updateCustomer(c._id, { contacts: [{ name: "A", isPrimary: true }, { name: "B", isPrimary: true }] }), "MULTIPLE_PRIMARY_CONTACTS");
  await rejectsWith(svc.Customers.updateCustomer(c._id, { contacts: [{ name: "" }] }), "CONTACT_NAME_REQUIRED");
  await rejectsWith(svc.Customers.updateCustomer(c._id, { contacts: [{ name: "A", email: "not-an-email" }] }), "INVALID_EMAIL");
  assert.equal((await svc.Customers.getCustomerById(c._id)).contacts.length, 2, "a refused change leaves the saved contacts alone");
  const emptied = await svc.Customers.updateCustomer(c._id, { contacts: [] });
  assert.equal(emptied.contacts.length, 0);

  const v = await svc.Vendors.createVendor({ vendorName: "Vendor Contacts", address: "Sharjah", contacts: [{ name: "Fatima Noor", isPrimary: true }] });
  assert.equal(v.contactPerson, "Fatima Noor");
});

test("bank accounts: bank from the master, IBAN checksum, SWIFT of 8 or 11 characters, one primary", { skip }, async () => {
  const bank = await svc.BankMaster.create({ companyId: "default", branchId: "main", bankName: "Emirates NBD", bankCode: "ENBD", swiftCode: "EBILAEAD" });
  const c = await svc.Customers.createCustomer(customer("Banked Co", {
    bankAccounts: [
      { bankId: bank._id, accountNumber: "1012 3456 789", iban: "ae07 0331 2345 6789 0123 456", swiftCode: "ebilaead" },
      { bankName: "Mashreq Bank", accountNumber: "9988776655", swiftCode: "BOMLAEADXXX" },
    ],
  }));
  assert.equal(c.bankAccounts[0].bankName, "Emirates NBD", "the bank's name comes from the master");
  assert.equal(c.bankAccounts[0].iban, IBAN);
  assert.equal(c.bankAccounts[0].swiftCode, "EBILAEAD");
  assert.equal(c.bankAccounts[0].accountNumber, "10123456789");
  assert.deepEqual(c.bankAccounts.map((b) => b.isPrimary), [true, false]);

  const put = (rows) => svc.Customers.updateCustomer(c._id, { bankAccounts: rows });
  await rejectsWith(put([{ bankName: "X Bank", iban: "AE070331234567890123457" }]), "INVALID_IBAN"); // last digit off
  await rejectsWith(put([{ bankName: "X Bank", accountNumber: "123456", swiftCode: "EBILAEA" }]), "INVALID_SWIFT"); // 7
  await rejectsWith(put([{ bankName: "X Bank", accountNumber: "123456", swiftCode: "EBILAEADX" }]), "INVALID_SWIFT"); // 9
  await rejectsWith(put([{ bankName: "X Bank", accountNumber: "123456", swiftCode: "1234AEAD" }]), "INVALID_SWIFT"); // bank code is letters
  await rejectsWith(put([{ accountNumber: "123456" }]), "BANK_REQUIRED");
  await rejectsWith(put([{ bankName: "X Bank" }]), "ACCOUNT_REQUIRED");
  await rejectsWith(put([{ bankName: "X Bank", accountNumber: "12" }]), "INVALID_ACCOUNT_NUMBER");
  await rejectsWith(put([{ bankId: new mongoose.Types.ObjectId(), accountNumber: "123456" }]), "BANK_NOT_FOUND");
  await rejectsWith(put([{ bankName: "A", accountNumber: "111111", isPrimary: true }, { bankName: "B", accountNumber: "222222", isPrimary: true }]), "MULTIPLE_PRIMARY_BANK_ACCOUNTS");
  assert.equal((await svc.Customers.getCustomerById(c._id)).bankAccounts.length, 2);

  assert.equal(svc.partyMaster.isValidSwift("EBILAEAD"), true);
  assert.equal(svc.partyMaster.isValidSwift("ebil aead xxx"), true);
  assert.equal(svc.partyMaster.isValidSwift("EBILAEADXX"), false);
});

// ---------------------------------------------------------------------------------------------
// KYC documents and document types
// ---------------------------------------------------------------------------------------------

test("the document-type master starts with its defaults, once", { skip }, async () => {
  const list = await svc.DocTypes.list({});
  assert.deepEqual(list.map((t) => t.name).sort(), ["Bank letter", "Emirates ID", "Other", "Passport", "Trade licence", "VAT certificate"]);
  const tl = list.find((t) => t.name === "Trade licence");
  assert.equal(tl.requiresExpiry, true);
  assert.equal(list.find((t) => t.name === "VAT certificate").minLength, 15);
  assert.ok(list.every((t) => t.isSystem && t.isActive));
  assert.equal((await svc.DocTypes.list({})).length, 6, "reading again adds nothing");
  assert.equal(await svc.DocTypes.ensureDefaults({}), 0);

  // a change to a default survives the next read
  await svc.DocTypes.update(tl._id, { maxLength: 40 }, {});
  assert.equal((await svc.DocTypes.list({})).find((t) => t.name === "Trade licence").maxLength, 40);
});

test("document types: create, unique name (any case), limits, switch off, delete only when unused and not a default", { skip }, async () => {
  const t = await svc.DocTypes.create({ name: "Halal certificate", requiresExpiry: true, minLength: 4, maxLength: 20 }, {});
  assert.equal(t.code, "HALAL_CERTIF", "no code given: made from the name, 12 characters at most");
  await rejectsWith(svc.DocTypes.create({ name: "HALAL CERTIFICATE" }, {}), "DUPLICATE_DOCUMENT_TYPE");
  await rejectsWith(svc.DocTypes.create({ name: "Food licence", minLength: 10, maxLength: 5 }, {}), "INVALID_LENGTH");
  await rejectsWith(svc.DocTypes.create({ name: "" }, {}), "NAME_REQUIRED");
  assert.equal((await svc.DocTypes.update(t._id, { minLength: 0 }, {})).minLength, null, "zero means no limit");

  const defaults = await svc.DocTypes.list({});
  const passport = defaults.find((x) => x.name === "Passport");
  await rejectsWith(svc.DocTypes.remove(passport._id, {}), "DOCUMENT_TYPE_IS_DEFAULT");
  await rejectsWith(svc.DocTypes.update(passport._id, { code: "PP" }, {}), "CODE_LOCKED");
  assert.equal((await svc.DocTypes.update(passport._id, { isActive: false }, {})).isActive, false);
  assert.ok(!(await svc.DocTypes.list({}, { active: "true" })).some((x) => x.name === "Passport"), "a switched-off type is not offered");
  await svc.DocTypes.update(passport._id, { isActive: true }, {});

  const c = await svc.Customers.createCustomer(customer("Halal Buyer", { documents: [{ documentTypeId: t._id, number: "HC-1001", expiryDate: "2030-01-01" }] }));
  assert.equal(c.documents[0].typeName, "Halal certificate");
  await rejectsWith(svc.DocTypes.remove(t._id, {}), "DOCUMENT_TYPE_IN_USE");
  await svc.DocTypes.update(t._id, { isActive: false }, {});
  await rejectsWith(svc.Customers.createCustomer(customer("Late Halal", { documents: [{ documentTypeId: t._id, number: "HC-1002", expiryDate: "2030-01-01" }] })), "DOCUMENT_TYPE_INACTIVE");
  // a record that already holds the (now switched-off) type can still be saved
  const kept = await svc.Customers.updateCustomer(c._id, { documents: [{ documentTypeId: t._id, number: "HC-1001", expiryDate: "2031-01-01" }] });
  assert.equal(kept.documents.length, 1);
  await svc.Customers.deleteCustomer(c._id);
  await svc.DocTypes.remove(t._id, {});
  await rejectsWith(svc.DocTypes.get(t._id, {}), "DOCUMENT_TYPE_NOT_FOUND");
});

test("documents: dates (expiry after issue), number length and expiry from the type, type name filled in", { skip }, async () => {
  const types = await svc.DocTypes.list({});
  const id = (name) => types.find((t) => t.name === name)._id;
  const make = (documents) => svc.Customers.createCustomer(customer(`Doc Co ${Math.random().toString(36).slice(2, 7)}`, { documents }));

  const c = await make([
    { documentTypeId: id("Trade licence"), number: "CN-1234567", issueDate: "2025-01-10", expiryDate: "2026-01-09" },
    { documentTypeId: id("Bank letter"), number: "", issueDate: "2025-06-01" },
  ]);
  assert.equal(c.documents[0].typeName, "Trade licence");
  assert.equal(c.documents[0].expiryDate.toISOString(), "2026-01-09T00:00:00.000Z");
  assert.equal(c.documents[1].expiryDate, null, "a type that does not expire needs no expiry");

  await rejectsWith(make([{ documentTypeId: id("Trade licence"), number: "CN-1", issueDate: "2025-01-10", expiryDate: "2025-01-10" }]), "EXPIRY_BEFORE_ISSUE"); // same day
  await rejectsWith(make([{ documentTypeId: id("Trade licence"), number: "CN-1", issueDate: "2025-01-10", expiryDate: "2024-12-31" }]), "EXPIRY_BEFORE_ISSUE");
  await rejectsWith(make([{ documentTypeId: id("Trade licence"), number: "CN-1" }]), "EXPIRY_REQUIRED");
  await rejectsWith(make([{ documentTypeId: id("Trade licence"), number: "AB", expiryDate: "2030-01-01" }]), "DOCUMENT_NUMBER_TOO_SHORT");
  await rejectsWith(make([{ documentTypeId: id("Trade licence"), number: "X".repeat(41), expiryDate: "2030-01-01" }]), "DOCUMENT_NUMBER_TOO_LONG");
  await rejectsWith(make([{ documentTypeId: id("VAT certificate"), number: "123" }]), "DOCUMENT_NUMBER_TOO_SHORT");
  await rejectsWith(make([{ documentTypeId: id("Passport"), number: "P1234567", expiryDate: "2030-02-30" }]), "INVALID_DATE");
  await rejectsWith(make([{ documentTypeId: id("Passport"), number: "P1234567", expiryDate: "next year" }]), "INVALID_DATE");
  await rejectsWith(make([{ documentTypeId: new mongoose.Types.ObjectId(), number: "1" }]), "DOCUMENT_TYPE_NOT_FOUND");
  await rejectsWith(make([{ number: "1" }]), "DOCUMENT_TYPE_REQUIRED");
  const free = await make([{ typeName: "Municipality permit", number: "M-9" }]);
  assert.equal(free.documents[0].typeName, "Municipality permit", "a document may carry a plain name instead of a master type");
});

test("files on a party: claimed when the party is saved, released when no row names them, and linkable by hand", { skip }, async () => {
  const types = await svc.DocTypes.list({});
  const tl = types.find((t) => t.name === "Trade licence")._id;
  const file = await upload("trade-licence.pdf");
  assert.equal(file.ownerId, null);

  const c = await svc.Customers.createCustomer(customer("Filed Co", {
    documents: [{ documentTypeId: tl, number: "CN-777", expiryDate: "2031-05-05", attachmentId: file._id, fileName: "trade-licence.pdf" }],
  }));
  let stored = await svc.Attachment.findById(file._id);
  assert.equal(stored.ownerType, "customer");
  assert.equal(String(stored.ownerId), String(c._id));
  assert.equal((await svc.Attachments.listFor("customer", c._id, {})).length, 1);

  // another party cannot take the same file; an unknown id is refused
  await rejectsWith(svc.Vendors.createVendor(vendor("Thief Vendor", { documents: [{ typeName: "Licence", attachmentId: file._id }] })), "ATTACHMENT_IN_USE");
  await rejectsWith(svc.Customers.createCustomer(customer("Ghost File", { documents: [{ typeName: "Licence", attachmentId: new mongoose.Types.ObjectId() }] })), "ATTACHMENT_NOT_FOUND");

  // removing the file through the attachment API keeps the row (number and dates) and drops the file
  await svc.Attachments.remove(file._id, {});
  const after = await svc.Customers.getCustomerById(c._id);
  assert.equal(after.documents.length, 1);
  assert.equal(after.documents[0].attachmentId, null);
  assert.equal(after.documents[0].number, "CN-777");
  assert.equal(await svc.Attachment.findById(file._id), null);

  // a second file: saved with the party, then dropped by saving the party without its row
  const second = await upload("second.pdf");
  const withFile = await svc.Customers.updateCustomer(c._id, { documents: [{ typeName: "Letter", attachmentId: second._id }] });
  assert.equal(String((await svc.Attachment.findById(second._id)).ownerId), String(withFile._id));
  await svc.Customers.updateCustomer(c._id, { documents: [] });
  assert.equal(await svc.Attachment.findById(second._id), null, "a file no row names any more is deleted");
  assert.equal(fs.existsSync(svc.Attachments.filePath(second)), false);

  // the generic link endpoint works for vendors too, adding a row for the file
  const v = await svc.Vendors.createVendor(vendor("Linked Vendor"));
  const third = await upload("third.pdf");
  await svc.Attachments.link(third._id, { ownerType: "vendor", ownerId: v._id, label: "Bank letter" }, {});
  const linked = await svc.Vendors.getVendorById(v._id);
  assert.equal(linked.documents.length, 1);
  assert.equal(linked.documents[0].typeName, "Bank letter");
  assert.equal(String(linked.documents[0].attachmentId), String(third._id));
  // saving the vendor with that row in place does not duplicate it or lose the file
  const resaved = await svc.Vendors.updateVendor(v._id, { documents: [{ typeName: "Bank letter", attachmentId: third._id }] });
  assert.equal(resaved.documents.length, 1);
  assert.ok(await svc.Attachment.findById(third._id));

  // deleting the party removes its files
  await svc.Vendors.deleteVendor(v._id);
  assert.equal(await svc.Attachment.findById(third._id), null);
});

// ---------------------------------------------------------------------------------------------
// expiry
// ---------------------------------------------------------------------------------------------

test("expiry classification: today, +30 and -1 are the edges; Dubai's day, not the server's, decides", () => {
  const { classify, STATUS } = require("../../utils/documentExpiry");
  const today = "2026-10-05";
  const at = (expiry, opts = {}) => classify(expiry, { today, ...opts });
  assert.deepEqual(at("2026-10-04"), { status: STATUS.EXPIRED, expiryDay: "2026-10-04", daysLeft: -1 });
  assert.deepEqual(at("2026-10-05"), { status: STATUS.EXPIRING_SOON, expiryDay: "2026-10-05", daysLeft: 0 }, "expires today: still usable, but soon");
  assert.equal(at("2026-11-04").status, STATUS.EXPIRING_SOON, "today + 30 days");
  assert.equal(at("2026-11-04").daysLeft, 30);
  assert.equal(at("2026-11-05").status, STATUS.VALID, "today + 31 days");
  assert.equal(at("2026-10-12", { warningDays: 7 }).status, STATUS.EXPIRING_SOON);
  assert.equal(at("2026-10-13", { warningDays: 7 }).status, STATUS.VALID);
  assert.equal(at("2026-10-05", { warningDays: 0 }).status, STATUS.EXPIRING_SOON);
  assert.equal(at("2026-10-06", { warningDays: 0 }).status, STATUS.VALID);
  assert.equal(at("2026-10-06", { warningDays: "soon" }).status, STATUS.EXPIRING_SOON, "a bad warning period falls back to 30 days");
  assert.equal(at(null).status, STATUS.NO_EXPIRY);
  assert.equal(at("").status, STATUS.NO_EXPIRY);
  assert.equal(at(undefined).status, STATUS.NO_EXPIRY);
  for (const bad of ["abc", "2026-02-30", "2026-13-01", "05/10/2026", new Date("nope"), {}]) assert.equal(at(bad).status, STATUS.INVALID_DATE, String(bad));

  // a stored date is UTC midnight of its day; a Dubai-midnight instant is the evening before in UTC
  assert.equal(at(new Date("2026-10-04T00:00:00Z")).status, STATUS.EXPIRED);
  assert.equal(at(new Date("2026-10-04T20:00:00Z")).expiryDay, "2026-10-05", "Dubai midnight is 20:00 UTC the evening before");
  assert.equal(at("2026-10-04T21:30:00.000Z").expiryDay, "2026-10-05");

  // 00:30 on the 5th in Dubai is still the 4th in UTC: a document that expired on the 4th is expired
  const justAfterMidnight = new Date("2026-10-04T20:30:00Z");
  assert.equal(classify("2026-10-04", { today: justAfterMidnight }).status, STATUS.EXPIRED);
  assert.equal(classify("2026-10-05", { today: justAfterMidnight }).status, STATUS.EXPIRING_SOON);
  assert.equal(classify("2026-10-05", { today: new Date("2026-10-05T19:59:00Z") }).daysLeft, 0, "23:59 in Dubai is still the 5th");
  assert.equal(classify("2026-10-05", { today: new Date("2026-10-05T20:00:00Z") }).status, STATUS.EXPIRED, "and at midnight it is the 6th");
  assert.equal(require("../../utils/documentExpiry").daysLeftLabel(-3), "Expired 3 days ago");
  assert.equal(require("../../utils/documentExpiry").daysLeftLabel(0), "Expires today");
});

test("the expiry list holds expired and soon-to-expire documents of customers and vendors, soonest first", { skip }, async () => {
  const now = new Date();
  const today = svc.expiry.todayInDubai(now);
  const day = (n) => svc.expiry.addDays(today, n);
  const doc = (n, number) => ({ typeName: "Trade licence", number, expiryDate: day(n) });
  const c = await svc.Customers.createCustomer(customer("Expiry Customer", { documents: [doc(-1, "E-1"), doc(0, "E0"), doc(30, "E30"), doc(31, "E31"), { typeName: "Bank letter", number: "NOEXP" }] }));
  const v = await svc.Vendors.createVendor(vendor("Expiry Vendor", { documents: [doc(-20, "V-20"), doc(5, "V5")] }));
  const inactive = await svc.Customers.createCustomer(customer("Expiry Inactive", { status: "Inactive", documents: [doc(-2, "I-2")] }));

  const res = await svc.Expiry.list({ withinDays: 30, now });
  assert.equal(res.asOf, today);
  assert.equal(res.withinDays, 30);
  const mine = res.rows.filter((r) => ["Expiry Customer", "Expiry Vendor"].includes(r.partyName));
  assert.deepEqual(mine.map((r) => r.number), ["V-20", "E-1", "E0", "V5", "E30"]);
  assert.deepEqual(mine.map((r) => r.daysLeft), [-20, -1, 0, 5, 30]);
  assert.deepEqual(mine.map((r) => r.status), ["EXPIRED", "EXPIRED", "EXPIRING_SOON", "EXPIRING_SOON", "EXPIRING_SOON"]);
  assert.equal(mine[0].partyType, "Vendor");
  assert.equal(mine[0].partyId.toString(), v._id.toString());
  assert.equal(mine[1].documentType, "Trade licence");
  assert.equal(mine[1].expiryDate, day(-1));
  assert.ok(!res.rows.some((r) => r.number === "I-2"), "an inactive customer's documents are left out...");
  assert.ok((await svc.Expiry.list({ withinDays: 30, includeInactive: true, now })).rows.some((r) => r.number === "I-2"), "...unless asked for");
  assert.equal(res.summary.total, res.rows.length);
  assert.equal(res.summary.expired + res.summary.expiringSoon, res.summary.total);

  assert.ok(!(await svc.Expiry.list({ withinDays: 5, now })).rows.some((r) => r.number === "E30"), "a shorter window drops the later ones");
  assert.ok((await svc.Expiry.list({ withinDays: 5, now })).rows.some((r) => r.number === "V5"));
  assert.ok((await svc.Expiry.list({ withinDays: 0, now })).rows.some((r) => r.number === "E0"));
  const onlyVendors = await svc.Expiry.list({ withinDays: 30, partyType: "vendor", now });
  assert.ok(onlyVendors.rows.length && onlyVendors.rows.every((r) => r.partyType === "Vendor"));
  await rejectsWith(svc.Expiry.list({ partyType: "staff" }), "INVALID_PARTY_TYPE");
  await rejectsWith(svc.Expiry.list({ withinDays: -1 }), "INVALID_WITHIN_DAYS");
  await rejectsWith(svc.Expiry.list({ withinDays: "soon" }), "INVALID_WITHIN_DAYS");
  assert.equal((await svc.Expiry.list({})).withinDays, 30, "30 days unless told otherwise");
  assert.ok(c && inactive);
});

// ---------------------------------------------------------------------------------------------
// creating a party from the account form
// ---------------------------------------------------------------------------------------------

test("ensurePartyAccount files a new account in the chosen group, and refuses a group of the wrong kind", { skip }, async () => {
  const group = await makeGroup("Wholesale Customers", "WHS", "ASSET", await groupByName("Accounts Receivable"));
  const c = await svc.Customer.create({ customerId: "ENS1", customerName: "Ensured Customer", contactPerson: "x" });
  const acc = await svc.PartyAccounts.ensurePartyAccount("customer", c._id, c.customerName, { groupId: group._id });
  assert.equal(String(acc.groupId), String(group._id));
  assert.match(acc.accountCode, /^WHS\d{4}$/);
  const again = await svc.PartyAccounts.ensurePartyAccount("customer", c._id, c.customerName, { groupId: (await groupByName("Accounts Receivable"))._id });
  assert.equal(String(again._id), String(acc._id), "an account that exists is found by name and left where it is");

  const v = await svc.Vendor.create({ vendorId: "ENS2", vendorName: "Ensured Vendor", contactPerson: "x", address: "y" });
  await rejectsWith(svc.PartyAccounts.ensurePartyAccount("vendor", v._id, v.vendorName, { groupId: group._id }), "GROUP_CATEGORY_MISMATCH");
  const plain = await svc.PartyAccounts.ensurePartyAccount("vendor", v._id, v.vendorName);
  assert.equal((await svc.AccountGroup.findById(plain.groupId)).name, "Accounts Payable", "no group given: the posting-map group, as before");
});

test("a customer made from the account form lands in the chosen sub-group with a code from it", { skip }, async () => {
  const ar = await groupByName("Accounts Receivable");
  const retail = (await groupByName("Retail Customers")) || (await makeGroup("Retail Customers", "RTL", "ASSET", ar));
  const { account, party } = await svc.PartyAccount.create({
    groupId: retail._id, description: "Dubai Marina branch",
    party: customer("Marina Minimart", { vat: { status: "registered", trn: "100777000000001" }, creditLimit: 25000, credit: { days: 45 }, contacts: [{ name: "Reem", isPrimary: true }] }),
  }, {}, undefined);

  assert.equal(account.accountName, "Customer - Marina Minimart");
  assert.equal(String(account.groupId), String(retail._id));
  assert.match(account.accountCode, /^RTL\d{4}$/);
  assert.equal(account.accountType, "asset");
  assert.equal(account.description, "Dubai Marina branch");
  assert.equal(party.customerName, "Marina Minimart");
  assert.equal(party.vat.trn, "100777000000001");
  assert.equal(party.creditLimit, 25000);
  assert.equal(party.credit.days, 45);
  assert.equal(party.paymentTerms, "Net 45");
  assert.equal(await svc.LedgerAccount.countDocuments({ accountName: "Customer - Marina Minimart" }), 1, "one account, not one per group");

  // the next one in the same group continues the group's own numbering
  const second = await svc.PartyAccount.create({ groupId: retail._id, party: customer("Marina Minimart Two") }, {}, undefined);
  assert.equal(Number(second.account.accountCode.slice(3)), Number(account.accountCode.slice(3)) + 1);

  // the account is found from the group and the party from the account
  const found = await svc.PartyAccount.get(account._id, {});
  assert.equal(found.kind, "customer");
  assert.equal(String(found.party._id), String(party._id));
});

test("a vendor made from the account form lands in a Payables sub-group", { skip }, async () => {
  const ap = await groupByName("Accounts Payable");
  const sup = await makeGroup("Food Suppliers", "FSUP", "LIABILITY", ap);
  const { account, party } = await svc.PartyAccount.create({
    groupId: sup._id,
    party: vendor("Al Ain Farms", { vat: { status: "designated_zone", trn: "100888000000002" }, paymentTerms: "Net 60", bankAccounts: [{ bankName: "ADCB", iban: IBAN }], contacts: [{ name: "Khalid", isPrimary: true }] }),
  }, {}, undefined);
  assert.equal(account.accountName, "Vendor - Al Ain Farms");
  assert.equal(String(account.groupId), String(sup._id));
  assert.match(account.accountCode, /^FSUP\d{4}$/);
  assert.equal(account.accountType, "liability");
  assert.equal(party.vendorName, "Al Ain Farms");
  assert.equal(party.credit.days, 60);
  assert.equal(party.bankAccounts[0].isPrimary, true);
});

test("the party form needs a Receivable or Payable group, a name, and a free account name; nothing is left behind on a refusal", { skip }, async () => {
  const bank = await groupByName("Bank");
  const ar = await groupByName("Accounts Receivable");
  const before = { customers: await svc.Customer.countDocuments(), accounts: await svc.LedgerAccount.countDocuments() };
  await rejectsWith(svc.PartyAccount.create({ groupId: bank._id, party: customer("Wrong Group Co") }, {}), "PARTY_GROUP_REQUIRED");
  await rejectsWith(svc.PartyAccount.create({ party: customer("No Group Co") }, {}), "GROUP_REQUIRED");
  await rejectsWith(svc.PartyAccount.create({ groupId: new mongoose.Types.ObjectId(), party: customer("Ghost Group Co") }, {}), "GROUP_REQUIRED");
  await rejectsWith(svc.PartyAccount.create({ groupId: ar._id, party: customer("   ") }, {}), "NAME_REQUIRED");
  await rejectsWith(svc.PartyAccount.create({ groupId: ar._id, party: customer("Bad TRN Co", { vat: { status: "registered", trn: "1" } }) }, {}), "INVALID_TRN");
  await assert.rejects(svc.PartyAccount.create({ groupId: ar._id, party: customer("Neg Opening Co"), openingBalance: -5 }, {}), /cannot be negative/);
  await rejectsWith(svc.PartyAccount.create({ groupId: ar._id, party: customer("No Side Co"), openingBalance: 100 }, {}), "OPENING_SIDE_REQUIRED");
  assert.deepEqual({ customers: await svc.Customer.countDocuments(), accounts: await svc.LedgerAccount.countDocuments() }, before);

  const first = await svc.PartyAccount.create({ groupId: ar._id, party: customer("Same Name Co") }, {});
  await rejectsWith(svc.PartyAccount.create({ groupId: ar._id, party: customer("same name co") }, {}), "DUPLICATE_ACCOUNT");
  assert.equal(await svc.Customer.countDocuments({ customerName: /^same name co$/i }), 1);
  assert.ok(first.account);
});

test("an opening balance on the party form posts exactly as it does for any account", { skip }, async () => {
  const ar = await groupByName("Accounts Receivable");
  const { account } = await svc.PartyAccount.create({ groupId: ar._id, party: customer("Opening Co"), openingBalance: 1250.5, openingSide: "debit", openingDate: new Date().toISOString().slice(0, 10) }, {});
  assert.equal(account.openingBalance, 1250.5);
  assert.equal(account.openingSide, "debit");
  const entries = await svc.LedgerEntry.find({ voucherNo: `OB-${account.accountCode}` }).lean();
  assert.equal(entries.length, 2, "the account and Opening Balance Equity");
  const mine = entries.find((e) => String(e.accountId) === String(account._id));
  assert.equal(mine.debitAmount, 1250.5);
  assert.equal(entries.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0), 0, "the entry balances");

  // a date outside every fiscal year is refused before the customer exists
  const customers = await svc.Customer.countDocuments();
  await rejectsWith(svc.PartyAccount.create({ groupId: ar._id, party: customer("Ancient Opening Co"), openingBalance: 10, openingSide: "debit", openingDate: "2001-01-01" }, {}), "NO_FISCAL_YEAR");
  assert.equal(await svc.Customer.countDocuments(), customers);
  assert.equal(await accountOf("Customer - Ancient Opening Co"), null);
});

test("editing a party account changes the party too; a rename keeps every link", { skip }, async () => {
  const ar = await groupByName("Accounts Receivable");
  const retail = await groupByName("Retail Customers");
  const { account, party } = await svc.PartyAccount.create({ groupId: ar._id, party: customer("Rename Me Co", { vat: { status: "registered", trn: "100999000000003" } }) }, {});

  const out = await svc.PartyAccount.update(account._id, {
    party: { customerName: "Renamed Co", creditLimit: 9000, vat: { status: "exempt" }, phone: "+971501112222" },
    description: "now exempt",
  }, {});
  assert.equal(out.party.customerName, "Renamed Co");
  assert.equal(out.party.creditLimit, 9000);
  assert.equal(out.party.vat.status, "exempt");
  assert.equal(out.party.vat.trn, "100999000000003", "an exempt party may keep its TRN");
  assert.equal(out.account.accountName, "Customer - Renamed Co");
  assert.equal(String(out.account._id), String(account._id), "the same account, renamed");
  assert.equal(out.account.accountCode, account.accountCode, "its code does not change");
  assert.equal(out.account.description, "now exempt");
  assert.equal(await accountOf("Customer - Rename Me Co"), null);
  assert.equal((await svc.PartyAccount.get(account._id, {})).party._id.toString(), party._id.toString(), "still found from the account after the rename");

  // moving it to another receivable group is fine; to a payable one is not
  const moved = await svc.PartyAccount.update(account._id, { groupId: retail._id }, {});
  assert.equal(String(moved.account.groupId), String(retail._id));
  await rejectsWith(svc.PartyAccount.update(account._id, { groupId: (await groupByName("Accounts Payable"))._id }, {}), "PARTY_GROUP_MISMATCH");
  // a name another account already has is refused, and nothing changes
  await svc.PartyAccount.create({ groupId: ar._id, party: customer("Taken Name Co") }, {});
  await rejectsWith(svc.PartyAccount.update(account._id, { party: { customerName: "Taken Name Co" } }, {}), "DUPLICATE_ACCOUNT");
  assert.equal((await svc.Customer.findById(party._id)).customerName, "Renamed Co");

  // an account with no customer behind it (made by hand) has no party record
  const manual = await svc.Chart.createAccount({ groupId: ar._id, accountName: "Staff Advances" }, {}, undefined);
  assert.equal((await svc.PartyAccount.get(manual._id, {})).party, null);
  await rejectsWith(svc.PartyAccount.update(manual._id, { party: { phone: "1" } }, {}), "PARTY_NOT_FOUND");
  // and a cash account has no kind at all
  const cash = await accountOf("Cash in Hand");
  assert.deepEqual(await svc.PartyAccount.get(cash._id, {}), { kind: null, party: null });
});

// ---------------------------------------------------------------------------------------------
// the routes
// ---------------------------------------------------------------------------------------------

test("routes: document types and expiry answer a signed-in user; changes need an admin; the party-account routes work end to end", { skip }, async () => {
  assert.equal((await call("GET", "/document-types", { token: null })).status, 401);
  const list = await call("GET", "/document-types", { token: tokens.viewer });
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 6);
  assert.equal((await call("POST", "/document-types", { token: tokens.viewer, body: { name: "Viewer made" } })).status, 403);
  const made = await call("POST", "/document-types", { body: { name: "Import permit", requiresExpiry: true } });
  assert.equal(made.status, 201);
  assert.equal(made.body.requiresExpiry, true);
  assert.equal((await call("POST", "/document-types", { body: { name: "import permit" } })).status, 409);
  assert.equal((await call("PUT", `/document-types/${made.body._id}`, { body: { maxLength: 25 } })).body.maxLength, 25);
  assert.equal((await call("GET", `/document-types/${made.body._id}`)).body.name, "Import permit");
  assert.equal((await call("GET", "/document-types?active=true")).body.every((t) => t.isActive), true);
  const sys = list.body.find((t) => t.isSystem);
  assert.equal((await call("DELETE", `/document-types/${sys._id}`)).status, 409);
  assert.equal((await call("DELETE", `/document-types/${made.body._id}`)).status, 200);

  const exp = await call("GET", "/document-expiry?withinDays=30&partyType=customer", { token: tokens.viewer });
  assert.equal(exp.status, 200);
  assert.equal(exp.body.withinDays, 30);
  assert.ok(Array.isArray(exp.body.rows) && exp.body.rows.every((r) => r.partyType === "Customer"));
  assert.equal((await call("GET", "/document-expiry?withinDays=abc")).status, 400);
  assert.equal((await call("GET", "/document-expiry", { token: null })).status, 401);

  const ar = await groupByName("Accounts Receivable");
  const body = { groupId: String(ar._id), party: customer("Route Customer Co", { vat: { status: "registered", trn: "100555000000004" } }) };
  assert.equal((await call("POST", "/accounting/accounts/party", { token: tokens.viewer, body })).status, 403);
  const created = await call("POST", "/accounting/accounts/party", { body });
  assert.equal(created.status, 201);
  assert.equal(created.body.account.accountName, "Customer - Route Customer Co");
  assert.equal(created.body.party.vat.trn, "100555000000004", "the response carries the party as the customer API does");
  const got = await call("GET", `/accounting/accounts/${created.body.account._id}/party`, { token: tokens.viewer });
  assert.equal(got.body.kind, "customer");
  assert.equal(got.body.party.customerName, "Route Customer Co");
  const saved = await call("PUT", `/accounting/accounts/${created.body.account._id}/party`, { body: { party: { phone: "+971502223333" } } });
  assert.equal(saved.body.party.phone, "+971502223333");
  assert.equal((await call("POST", "/accounting/accounts/party", { body: { groupId: String((await groupByName("Bank"))._id), party: customer("Nope") } })).json.errorCode, "PARTY_GROUP_REQUIRED");
});
