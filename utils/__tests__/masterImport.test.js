// Reading a spreadsheet of customers, vendors and items (utils/masterImport.js): every awkward cell, as a test. Pure.
//   node --test utils/__tests__/masterImport.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../masterImport");

const codes = (row) => row.errors.map((e) => e.code);
const warns = (row) => row.warnings.map((w) => w.code);
const plan = (rows, options) => m.planCustomerImport(rows, { country: "AE", ...options });

// ---- the words people write ----------------------------------------------------------------------------------------------------

test("a country cell: a name, an alias or a two-letter code; blank means nothing was said; a stranger is refused", () => {
  assert.deepEqual(m.countryFrom("UAE"), { ok: true, code: "AE" });
  assert.deepEqual(m.countryFrom("United Arab Emirates"), { ok: true, code: "AE" });
  assert.deepEqual(m.countryFrom(" india "), { ok: true, code: "IN" });
  assert.deepEqual(m.countryFrom("in"), { ok: true, code: "IN" });
  assert.equal(m.countryFrom("UK").code, "GB", "an alias read BEFORE two letters are taken as a code: UK is how everybody writes it, GB is its ISO code");
  assert.equal(m.countryFrom("GB").code, "GB");
  assert.equal(m.countryFrom("XX").ok, false, "two letters are only a code when they are a real region");
  assert.equal(m.countryFrom("ZZ").ok, false);
  assert.equal(m.countryFrom("KSA").code, "SA");
  assert.equal(m.countryFrom("Ivory Coast").code, "CI");
  assert.equal(m.countryFrom("Hong Kong").code, "HK");
  assert.equal(m.countryFrom("Congo").ok, false, "it names two countries: the person writes the code");
  assert.equal(m.countryFrom("UN").ok, false, "a reserved code is not a country");
  assert.deepEqual(m.countryFrom(""), { ok: true, code: undefined });
  assert.deepEqual(m.countryFrom(undefined), { ok: true, code: undefined });
  assert.equal(m.countryFrom("Atlantis").ok, false);
  assert.equal(m.countryFrom({ $ne: "x" }).code, undefined, "an object is nothing");
});

test("an emirate cell: written out in any case, an abbreviation, or left as typed for the address rule to refuse", () => {
  assert.equal(m.emirateFrom("dxb"), "Dubai");
  assert.equal(m.emirateFrom("ras al khaimah"), "Ras Al Khaimah");
  assert.equal(m.emirateFrom("RAK"), "Ras Al Khaimah");
  assert.equal(m.emirateFrom("Dubai Marina"), "Dubai Marina", "not an emirate: handed on as typed, to be refused in the rule's own words");
  assert.equal(m.emirateFrom(""), undefined);
});

test("payment terms are spelt the way the books spell them", () => {
  assert.equal(m.termsFrom("customer", "net 30"), "Net 30");
  assert.equal(m.termsFrom("customer", "30"), "Net 30");
  assert.equal(m.termsFrom("customer", "30 days"), "Net 30");
  assert.equal(m.termsFrom("customer", "Net45"), "Net 45");
  assert.equal(m.termsFrom("customer", "cash"), "Cash");
  assert.equal(m.termsFrom("customer", "COD"), "Cash on Delivery");
  assert.equal(m.termsFrom("vendor", "cod"), "COD");
  assert.equal(m.termsFrom("vendor", "30 days"), "30 days", "a vendor's own standard term is kept as it is");
  assert.equal(m.termsFrom("vendor", "30"), "Net 30");
  assert.equal(m.termsFrom("customer", "prepaid"), "Prepaid");
  assert.equal(m.termsFrom("customer", "whenever"), "whenever", "handed on as typed, for resolveTerms to refuse");
  assert.equal(m.termsFrom("customer", ""), undefined);
});

test("VAT status, status and item type words", () => {
  assert.deepEqual(m.vatStatusFrom("Yes"), { given: true, value: "registered" });
  assert.deepEqual(m.vatStatusFrom("not registered"), { given: true, value: "unregistered" });
  assert.deepEqual(m.vatStatusFrom("Free zone"), { given: true, value: "designated_zone" });
  assert.deepEqual(m.vatStatusFrom("maybe"), { given: true, value: null });
  assert.deepEqual(m.vatStatusFrom(""), { given: false, value: undefined });
  assert.equal(m.statusFrom("customer", "Inactive").value, "Inactive");
  assert.equal(m.statusFrom("vendor", "non-compliant").value, "Non-compliant");
  assert.equal(m.statusFrom("vendor", "active").value, "Compliant", "a vendor's 'active' is Compliant");
  assert.equal(m.statusFrom("customer", "sleeping").value, null);
  assert.equal(m.itemTypeFrom(""), "goods");
  assert.equal(m.itemTypeFrom("Services"), "service");
  assert.equal(m.itemTypeFrom("widget"), null);
});

// ---- customers -------------------------------------------------------------------------------------------------------------------

test("a customer row becomes exactly what the form's save takes", () => {
  const { rows, summary } = plan([{
    name: " Al Noor Trading ", contactPerson: "Ali", email: "ALI@AlNoor.ae", phone: "050 123 4567", trn: "100-1234-5670-0003", paymentTerms: "net 30",
    creditLimit: "AED 12,500", billingAddress: "Deira", country: "UAE", emirate: "dxb", city: "Dubai", salesPerson: "Sami", website: "www.alnoor.ae", status: "active",
  }]);
  assert.deepEqual(summary, { total: 1, create: 1, invalid: 0, duplicate: 0, skipped: 0 });
  assert.deepEqual(rows[0].fields, {
    customerName: "Al Noor Trading", contactPerson: "Ali", email: "ali@alnoor.ae", phone: "050 123 4567", billingAddress: "Deira", creditLimit: 12500, salesPerson: "Sami", status: "Active",
    vat: { status: "registered", trn: "100123456700003", tradeLicenseNo: "" }, paymentTerms: "Net 30", credit: { days: 30 }, website: "www.alnoor.ae", city: "Dubai", country: "AE", emirate: "Dubai",
  });
  assert.equal(rows[0].line, 2, "the first record is line 2 of the person's own sheet");
});

test("a name is all a customer needs; a vendor needs an address as well", () => {
  assert.equal(plan([{ name: "Just A Name" }]).rows[0].status, "create");
  assert.deepEqual(codes(plan([{ phone: "0501234567" }]).rows[0]), ["NAME_REQUIRED"]);
  const vendor = (row) => m.planVendorImport([row], { country: "AE" }).rows[0];
  assert.deepEqual(codes(vendor({ name: "Gulf Mills" })), ["ADDRESS_REQUIRED"]);
  assert.equal(vendor({ name: "Gulf Mills", address: "Jebel Ali" }).status, "create");
  assert.equal(vendor({ name: "Gulf Mills", address: "Jebel Ali" }).fields.vendorName, "Gulf Mills");
  assert.equal(vendor({ name: "Gulf Mills", address: "Jebel Ali" }).fields.address, "Jebel Ali");
  assert.equal(vendor({ name: "Gulf Mills", billingAddress: "Jebel Ali" }).fields.address, "Jebel Ali", "a vendor's address may sit in a column called billing address");
});

test("email and phone are checked", () => {
  assert.deepEqual(codes(plan([{ name: "A", email: "not an email" }]).rows[0]), ["INVALID_EMAIL"]);
  assert.deepEqual(codes(plan([{ name: "A", phone: "123" }]).rows[0]), ["INVALID_PHONE"]);
  assert.equal(plan([{ name: "A", phone: "+971 4 123 4567" }]).rows[0].status, "create");
});

test("the tax number is judged by the ORGANISATION's country, with the save's own words", () => {
  const trn = (value, country, extra = {}) => plan([{ name: "A", trn: value, ...extra }], { country }).rows[0];
  assert.equal(trn("100123456700003", "AE").status, "create");
  assert.deepEqual(codes(trn("12345", "AE")), ["INVALID_TRN"]);
  assert.equal(trn("12345", "AE").errors[0].message, "A UAE TRN is exactly 15 digits");
  assert.equal(trn("27ABCDE1234F1Z5", "IN").status, "create");
  assert.equal(trn("27ABCDE1234F1Z5", "IN").fields.stateCode, undefined, "the service takes the state from the GSTIN");
  assert.match(trn("100123456700003", "IN").errors[0].message, /GSTIN/);
  assert.deepEqual(codes(plan([{ name: "A", vatStatus: "registered" }]).rows[0]), ["TRN_REQUIRED"]);
  assert.deepEqual(codes(plan([{ name: "A", vatStatus: "unregistered", trn: "100123456700003" }]).rows[0]), ["TRN_NOT_ALLOWED"]);
  assert.deepEqual(codes(plan([{ name: "A", vatStatus: "maybe" }]).rows[0]), ["INVALID_VAT_STATUS"]);
  assert.equal(plan([{ name: "A" }]).rows[0].fields.vat, undefined, "no tax cells, no VAT block: the service's default applies");
  assert.deepEqual(plan([{ name: "A", tradeLicense: "TL-99" }]).rows[0].fields.vat, { status: "unregistered", trn: null, tradeLicenseNo: "TL-99" });
});

test("terms, credit days, credit limit and website are checked by the save's own rules", () => {
  assert.equal(plan([{ name: "A", paymentTerms: "whenever" }]).rows[0].errors[0].code, "INVALID_PAYMENT_TERMS");
  assert.equal(plan([{ name: "A", creditDays: "abc" }]).rows[0].errors[0].code, "INVALID_CREDIT_DAYS");
  assert.equal(plan([{ name: "A", creditDays: "400" }]).rows[0].errors[0].code, "INVALID_CREDIT_DAYS");
  const days = plan([{ name: "A", creditDays: "45" }]).rows[0].fields;
  assert.equal(days.paymentTerms, "Net 45");
  assert.deepEqual(days.credit, { days: 45 });
  assert.equal(plan([{ name: "A", creditLimit: "1,20,000" }]).rows[0].fields.creditLimit, 120000, "lakh grouping");
  assert.deepEqual(codes(plan([{ name: "A", creditLimit: "lots" }]).rows[0]), ["INVALID_AMOUNT"]);
  assert.deepEqual(codes(plan([{ name: "A", creditLimit: "-5" }]).rows[0]), ["NEGATIVE_AMOUNT"]);
  assert.equal(plan([{ name: "A", website: "not a site" }]).rows[0].errors[0].code, "INVALID_WEBSITE");
  assert.equal(plan([{ name: "A", creditLimit: "5000" }], {}).rows[0].fields.creditLimit, 5000);
  const vendor = m.planVendorImport([{ name: "V", address: "x", creditLimit: "5000" }], { country: "AE" }).rows[0];
  assert.equal(vendor.fields.creditLimit, undefined, "a vendor has no credit limit");
});

test("UAE addresses: an emirate, a city that is an emirate, and no emirate at all", () => {
  const at = (row) => plan([{ name: "A", ...row }]).rows[0];
  assert.deepEqual([at({ country: "UAE", emirate: "dxb" }).fields.country, at({ country: "UAE", emirate: "dxb" }).fields.emirate], ["AE", "Dubai"]);
  assert.equal(at({ city: "Sharjah" }).fields.emirate, "Sharjah", "a city that names an emirate fills a missing one");
  assert.equal(at({ city: "Sharjah" }).fields.country, "AE");
  const none = at({ country: "United Arab Emirates" });
  assert.equal(none.status, "create", "the file is not failed over a cell nobody filled");
  assert.deepEqual(warns(none), ["EMIRATE_MISSING"]);
  assert.equal(none.fields.country, undefined);
  const wrong = at({ country: "UAE", emirate: "Dubai Marina" });
  assert.equal(wrong.status, "invalid");
  assert.equal(wrong.errors[0].field, "emirate", "the person fixes the emirate cell");
  assert.match(wrong.errors[0].message, /not an emirate of the UAE/);
  assert.equal(at({ country: "Atlantis" }).errors[0].code, "INVALID_COUNTRY");
  assert.equal(at({}).fields.country, undefined, "no address cells: nothing is stamped");
});

test("Indian addresses: the GST state is checked, and a customer with none is told", () => {
  const at = (row, country = "IN") => plan([{ name: "A", ...row }], { country }).rows[0];
  assert.equal(at({ country: "India", state: "Karnataka" }).fields.stateCode, "29");
  assert.equal(at({ state: "29" }).fields.stateCode, "29");
  assert.equal(at({ state: "Atlantis" }).errors[0].field, "state");
  assert.deepEqual(warns(at({ country: "India" })), ["STATE_MISSING"], "treated as local until a state is entered");
  assert.deepEqual(warns(at({ trn: "27ABCDE1234F1Z5" })), [], "a GSTIN names the state");
  assert.deepEqual(warns(at({ state: "Kerala" })), []);
});

test("duplicates: by name (case and spacing ignored) or tax number, against earlier rows and against what is held", () => {
  const rows = [
    { name: "Al Noor Trading", trn: "100123456700003" },
    { name: "  AL   NOOR trading " },
    { name: "Other Co", trn: "100123456700003" },
    { name: "Held Co" },
    { name: "Fresh Co", trn: "100999999900001" },
    { name: "Fresh Co 2", trn: "100999999900001" },
  ];
  const { rows: out, summary } = plan(rows, { existing: { names: new Set(["held co"]), trns: new Set(["100999999900001"]) } });
  assert.deepEqual(out.map((r) => r.status), ["create", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);
  assert.deepEqual(out[1].duplicateOf, { kind: "file", line: 2, by: "name" });
  assert.deepEqual(out[2].duplicateOf, { kind: "file", line: 2, by: "trn" });
  assert.deepEqual(out[3].duplicateOf, { kind: "customer", by: "name" });
  assert.deepEqual(out[4].duplicateOf, { kind: "customer", by: "trn" });
  assert.equal(summary.create, 1);
  assert.equal(summary.duplicate, 5);
});

test("a refused row does not claim its name: a later row with the same name is made", () => {
  const { rows } = plan([{ name: "Twin Co", email: "bad" }, { name: "Twin Co" }]);
  assert.deepEqual(rows.map((r) => r.status), ["invalid", "create"]);
});

test("a repeated email or phone is told, never refused: outlets of one group share a mailbox", () => {
  const { rows } = plan([
    { name: "Outlet 1", email: "accounts@group.ae", phone: "0501234567" },
    { name: "Outlet 2", email: "accounts@group.ae", phone: "050 123 4567" },
    { name: "Outlet 3", email: "held@elsewhere.ae" },
  ], { existing: { emails: new Set(["held@elsewhere.ae"]) } });
  assert.deepEqual(rows.map((r) => r.status), ["create", "create", "create"]);
  assert.deepEqual(warns(rows[1]), ["EMAIL_SHARED", "PHONE_SHARED"]);
  assert.match(rows[1].warnings[0].message, /line 2/);
  assert.deepEqual(warns(rows[2]), ["EMAIL_SHARED"]);
});

test("the caps, and a request body that is not to be trusted", () => {
  assert.equal(plan([]).error.code, "IMPORT_ROWS_REQUIRED");
  assert.equal(plan(undefined).error.code, "IMPORT_ROWS_REQUIRED");
  assert.equal(plan(Array.from({ length: 201 }, (_, i) => ({ name: `C${i}` }))).error.code, "IMPORT_TOO_MANY");
  assert.equal(plan(Array.from({ length: 200 }, (_, i) => ({ name: `C${i}` }))).summary.create, 200);
  const hostile = plan([{ name: { $ne: "x" }, email: ["a@b.c"], phone: { $gt: "" }, creditLimit: { $ne: 0 } }, null, "text"]).rows;
  assert.deepEqual(hostile.map((r) => r.status), ["invalid", "invalid", "invalid"]);
  assert.ok(hostile.every((r) => codes(r).includes("NAME_REQUIRED")), "an object, an array or a string where a row belongs reads as empty");
  assert.equal(plan([{ name: "A", line: 7 }]).rows[0].line, 7, "a line the screen numbered is honoured");
});

// ---- items -----------------------------------------------------------------------------------------------------------------------

const CATS = [{ id: "c1", name: "Rice" }, { id: "c2", name: "Oils & Fats" }];
const UNITS = [{ id: "u1", unitName: "Kilogram", shortCode: "Kg" }, { id: "u2", unitName: "Hour", shortCode: "Hr" }];
const VENDORS = [{ id: "v1", name: "Gulf Mills" }];
const items = (rows, options) => m.planItemImport(rows, { categories: CATS, units: UNITS, vendors: VENDORS, ...options });

test("an item row becomes what the item service takes: category and unit by name, an automatic SKU when none is given", () => {
  const { rows } = items([{ name: "Basmati Rice 5kg", category: "rice", unit: "kg", salesPrice: "AED 24.50", purchasePrice: "18", reorderLevel: "10", origin: "India", brand: "Royal", supplier: "gulf mills", hsn: "1006" }]);
  assert.equal(rows[0].status, "create", JSON.stringify(rows[0].errors));
  assert.deepEqual(rows[0].fields, {
    itemName: "Basmati Rice 5kg", itemType: "goods", categoryId: "c1", unitOfMeasure: "u1", autoSku: true, salesPrice: 24.5, purchasePrice: 18, reorderLevel: 10,
    hsnCode: "1006", origin: "India", brand: "Royal", vendorId: "v1",
  });
  assert.equal(items([{ name: "X", category: "Rice", unit: "Kilogram", sku: "RI0042" }]).rows[0].fields.sku, "RI0042");
  assert.equal(items([{ name: "X", category: "Rice", unit: "Kilogram", sku: "RI0042" }]).rows[0].fields.autoSku, undefined, "a typed SKU is kept, not numbered over");
  assert.equal(items([{ name: "X", category: "Rice", unit: "Hr" }]).rows[0].fields.unitOfMeasure, "u2", "a unit by its short code");
});

test("a category the file names but we do not hold is made once; a unit is NEVER made", () => {
  const { rows, newCategories, missing } = items([
    { name: "A", category: "Spices", unit: "Kg" },
    { name: "B", category: "spices", unit: "Kg" },
    { name: "C", category: "Pulses", unit: "Bunch" },
    { name: "D", category: "Rice", unit: "bunch" },
  ]);
  assert.deepEqual(newCategories, ["Spices"], "listed once whatever the spelling, and only for a row that will be made");
  assert.equal(rows[0].fields.categoryName, "Spices");
  assert.deepEqual(rows.map((r) => r.status), ["create", "create", "invalid", "invalid"]);
  assert.deepEqual(codes(rows[2]), ["UNIT_NOT_FOUND"]);
  assert.match(rows[2].errors[0].message, /Add it under Inventory > Units first/);
  assert.deepEqual(missing.units, ["Bunch"], "named once for the person to add");
  assert.deepEqual(codes(items([{ name: "A", category: "Spices", unit: "Kg" }], { addCategories: false }).rows[0]), ["CATEGORY_NOT_FOUND"]);
});

test("goods and services: a service has no reorder level, origin or brand", () => {
  const svc = items([{ name: "Installation", category: "Rice", unit: "Hr", type: "service", reorderLevel: "5", origin: "UAE", brand: "X", salesPrice: "400" }]).rows[0];
  assert.equal(svc.status, "create");
  assert.equal(svc.fields.itemType, "service");
  assert.deepEqual([svc.fields.reorderLevel, svc.fields.origin, svc.fields.brand], [undefined, undefined, undefined]);
  assert.deepEqual(warns(svc), ["SERVICE_NO_REORDER"]);
  assert.deepEqual(codes(items([{ name: "A", category: "Rice", unit: "Kg", type: "gadget" }]).rows[0]), ["INVALID_ITEM_TYPE"]);
});

test("item amounts, HSN codes and what a person who cannot see costs may not set", () => {
  assert.deepEqual(codes(items([{ name: "A", category: "Rice", unit: "Kg", salesPrice: "cheap" }]).rows[0]), ["INVALID_AMOUNT"]);
  assert.deepEqual(codes(items([{ name: "A", category: "Rice", unit: "Kg", reorderLevel: "-1" }]).rows[0]), ["NEGATIVE_AMOUNT"]);
  assert.equal(items([{ name: "A", category: "Rice", unit: "Kg", hsn: "0402" }]).rows[0].fields.hsnCode, "0402", "a leading zero survives as text");
  const short = items([{ name: "A", category: "Rice", unit: "Kg", hsn: "402" }]).rows[0];
  assert.deepEqual(codes(short), ["INVALID_HSN"]);
  assert.match(short.errors[0].message, /format the column as text/);
  const blind = items([{ name: "A", category: "Rice", unit: "Kg", purchasePrice: "18" }, { name: "B", category: "Rice", unit: "Kg" }], { canSeeCost: false });
  assert.equal(blind.rows[0].fields.purchasePrice, undefined, "the cost was left out");
  assert.equal(blind.rows[0].status, "create");
  assert.deepEqual(blind.notes, ["The Purchase price column was left out: you may not set what items cost."]);
  assert.deepEqual(items([{ name: "B", category: "Rice", unit: "Kg" }], { canSeeCost: false }).notes, [], "no note when no cost was given");
});

test("an unknown supplier is told and left blank, not refused", () => {
  const row = items([{ name: "A", category: "Rice", unit: "Kg", supplier: "Nobody Ltd" }]).rows[0];
  assert.equal(row.status, "create");
  assert.deepEqual(warns(row), ["VENDOR_NOT_FOUND"]);
  assert.equal(row.fields.vendorId, undefined);
});

test("item duplicates: the SKU when one is given, else the name; earlier rows and held items", () => {
  const { rows } = items([
    { name: "Rice A", category: "Rice", unit: "Kg", sku: "RI0001" },
    { name: "Rice B", category: "Rice", unit: "Kg", sku: "ri0001" },
    { name: "Rice C", category: "Rice", unit: "Kg", sku: "RI0777" },
    { name: "Rice D", category: "Rice", unit: "Kg" },
    { name: "  rice   d ", category: "Rice", unit: "Kg" },
    { name: "Held Item", category: "Rice", unit: "Kg" },
  ], { existing: { skus: new Set(["ri0777"]), names: new Set(["held item"]) } });
  assert.deepEqual(rows.map((r) => r.status), ["create", "duplicate", "duplicate", "create", "duplicate", "duplicate"]);
  assert.deepEqual(rows[1].duplicateOf, { kind: "file", line: 2, by: "sku" });
  assert.deepEqual(rows[2].duplicateOf, { kind: "item", by: "sku" });
  assert.deepEqual(rows[4].duplicateOf, { kind: "file", line: 5, by: "name" });
  assert.deepEqual(rows[5].duplicateOf, { kind: "item", by: "name" });
});

test("an item file has the same caps and the same distrust of its input", () => {
  assert.equal(items([]).error.code, "IMPORT_ROWS_REQUIRED");
  assert.equal(items(Array.from({ length: 201 }, () => ({ name: "x" }))).error.code, "IMPORT_TOO_MANY");
  const hostile = items([{ name: { $ne: "x" }, category: ["Rice"], unit: { $gt: "" } }]).rows[0];
  assert.deepEqual(codes(hostile).sort(), ["CATEGORY_REQUIRED", "NAME_REQUIRED", "UNIT_REQUIRED"]);
});

test("items: a barcode is kept for goods, refused when repeated or already an item's code, and left out of a service", () => {
  const units = [{ id: "u1", unitName: "Kilogram", shortCode: "Kg" }];
  const row = (line, extra) => ({ line, name: `Item ${line}`, category: "Rice", unit: "Kg", ...extra });
  const plan = m.planItemImport(
    [row(2, { barcode: "6291000000019" }), row(3, { barcode: "6291000000019" }), row(4, { barcode: "RI0001" }), row(5, { type: "service", barcode: "SV-1" }), row(6, { barcode: 6291000000050 }), row(7, { barcode: "x".repeat(65) })],
    { units, existing: { codes: new Set(["RI0001"]) } },
  );
  const by = Object.fromEntries(plan.rows.map((r) => [r.line, r]));
  assert.equal(by[2].status, "create");
  assert.equal(by[2].fields.barcodeQrCode, "6291000000019");
  assert.deepEqual(by[3].errors.map((e) => e.code), ["BARCODE_REPEATED"], "two items cannot share one");
  assert.deepEqual(by[4].errors.map((e) => e.code), ["BARCODE_TAKEN"], "another item's SKU counts");
  assert.equal(by[5].status, "create");
  assert.equal(by[5].fields.barcodeQrCode, undefined);
  assert.deepEqual(by[5].warnings.map((e) => e.code), ["SERVICE_NO_BARCODE"]);
  assert.equal(by[6].fields.barcodeQrCode, "6291000000050", "a number from a spreadsheet keeps its digits");
  assert.deepEqual(by[7].errors.map((e) => e.code), ["INVALID_BARCODE"]);
});
