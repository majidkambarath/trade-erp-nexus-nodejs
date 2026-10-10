// Fill ONE organisation with recognisable data through the product's own routes and services: every record carries a canary
// (`CANARY-<tag>-<kind>-<n>`) and the money in it uses amounts no other organisation uses. The data-bleed sweep seeds two
// organisations with it, then looks for one organisation's canaries, amounts and record ids in the other's responses.
//
// Every step is independent: one that fails (a payload the product no longer accepts) is recorded in `failures` and the rest
// carry on, and the caller asserts a floor on how many kinds were seeded, so a broken seed cannot quietly weaken the proof.
const H = require("./httpHarness");

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");

// Distinctive amounts: unlike anything in the other organisation (and unlikely to arise by chance in a figure computed from them).
const AMOUNTS = {
  A: { price: 7391.47, cost: 5123.89, credit: 913579.25, receipt: 4321.19, payment: 2468.13, expense: 1357.91, journal: 8642.75, contra: 975.31, note: 1864.27, opening: 31415.92, quote: 6283.19, serviceFee: 2718.28, qty: 137, buyQty: 523 },
  B: { price: 8642.31, cost: 6234.58, credit: 524680.75, receipt: 5432.21, payment: 3579.64, expense: 2468.35, journal: 9753.86, contra: 864.42, note: 2975.38, opening: 27182.81, quote: 7194.26, serviceFee: 3141.59, qty: 211, buyQty: 619 },
};

const today = () => new Date().toISOString().slice(0, 10);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const dmy = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

/**
 * @returns the registry:
 *   { code, tag, tokens: {owner, manager, viewer, branchUser}, ids: { kind: [id...] }, strings, numbers, failures, kinds, extra }
 */
async function seedOrg({ stack, call, code, tag, log = () => {} }) {
  const A = AMOUNTS[tag];
  const C = (kind, n = 1) => `CANARY-${tag}-${kind}-${n}`;
  const reg = { code, tag, tokens: {}, ids: {}, strings: [code], numbers: Object.values(A).filter((n) => String(n).includes(".")), failures: [], kinds: {}, extra: {}, amounts: A, C };
  const say = (s) => log(`[${tag}] ${s}`);
  const note = (...s) => reg.strings.push(...s.flat().filter(Boolean));
  const add = (kind, id) => {
    if (!id) return id;
    (reg.ids[kind] ||= []).push(String(id));
    reg.kinds[kind] = (reg.kinds[kind] || 0) + 1;
    return String(id);
  };
  // the record a create route answered with, whichever envelope it uses ({ data: rec }, { data: { category: rec } }, or the older { status, data })
  const rec = (res) => {
    let b = res?.body;
    if (b && typeof b === "object" && !b._id) { const inner = Object.values(b).find((v) => v && typeof v === "object" && !Array.isArray(v) && v._id); if (inner) b = inner; }
    return b && typeof b === "object" ? b : undefined;
  };
  const api = (who, method, url, body, extra = {}) => call(method, url, { token: reg.tokens[who], body, ...extra });
  // run a step; remember it as a failure if it throws or the route answered an error
  const step = async (name, fn) => {
    try {
      const res = await fn();
      if (res && typeof res.status === "number" && res.status >= 400) { reg.failures.push({ step: name, status: res.status, text: String(res.text).slice(0, 260) }); say(`FAILED ${name} ${res.status} ${String(res.text).slice(0, 160)}`); }
      return res;
    } catch (e) {
      reg.failures.push({ step: name, status: 0, text: String(e && e.stack || e).slice(0, 300) });
      say(`THREW ${name} ${e && e.message}`);
      return null;
    }
  };

  const Org = stack.Org;
  const Admin = require("../../../models/core/adminModel");
  const models = {
    Customer: require("../../../models/modules/customerModel"),
    Vendor: require("../../../models/modules/vendorModel"),
  };

  // ---------------------------------------------------------------- the organisation and the people in it
  await Org.create({ legalName: `${C("org")} Trading LLC`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  note(C("org"));
  const person = async (key, fields) => {
    const email = `${C(key).toLowerCase()}@${code}.sec.test`;
    await stack.as(code, () => new Admin({ name: C(key), email, password: H.PASSWORD, status: "active", isActive: true, ...fields }).save(), fields.branchId || "main");
    note(C(key), email);
    const r = await call("POST", "/login", { body: { email, password: H.PASSWORD } });
    if (r.status !== 200) throw new Error(`${key} could not sign in: ${r.text.slice(0, 200)}`);
    reg.tokens[key] = r.body.tokens.accessToken;
    const row = await stack.as(code, () => Admin.findOne({ email }).lean(), fields.branchId || "main");
    add("admin", row._id);
    return row;
  };
  await person("owner", { type: "super_admin" });
  await person("manager", { type: "manager" });
  await person("viewer", { type: "viewer" });

  // opening the chart switches ledger posting on and maps the posting accounts
  const chart = await api("owner", "GET", "/accounting/chart");
  const accounts = (await api("owner", "GET", "/accounting/accounts/postable")).body || [];
  const acct = (name) => accounts.find((a) => a.accountName === name);

  // ---------------------------------------------------------------- settings, profile, sending, e-invoicing, security
  await step("company profile", () => api("owner", "PUT", "/company/profile", { companyInfo: { companyName: C("company"), addressLine1: C("address"), city: "Dubai", phoneNumber: "+971 4 555 0199", email: `${C("companymail").toLowerCase()}@canary-${tag.toLowerCase()}.test` } }));
  note(C("company"), C("address"), `${C("companymail").toLowerCase()}@canary-${tag.toLowerCase()}.test`);
  const trn = tag === "A" ? "100777111200003" : "100888333400003";
  await step("accounting settings", () => api("owner", "PUT", "/accounting/settings", { profile: { legalName: C("legal"), trn, addressLine1: C("settings-street"), city: "Dubai", emirate: "Dubai" } }));
  note(C("legal"), trn, C("settings-street"));
  await step("messaging settings", () => api("owner", "PUT", "/messaging/settings", { provider: "console", fromName: C("sender"), fromEmail: `${C("billing").toLowerCase()}@canary-${tag.toLowerCase()}.test`, enabled: true }));
  note(C("sender"), `${C("billing").toLowerCase()}@canary-${tag.toLowerCase()}.test`);
  const webhookSecret = `whsec-${C("webhook")}`;
  reg.extra.webhookSecret = webhookSecret;
  await step("e-invoice settings", () => api("owner", "PUT", "/einvoice/settings", { participantId: `0235:${trn}`, webhookSecret, enabled: true }));
  note(webhookSecret, `0235:${trn}`);
  await step("security policy", () => api("owner", "PUT", "/auth/security-policy", { requireTwoFactor: false }));

  // ---------------------------------------------------------------- branches, roles, users, staff
  const branchCode = tag === "A" ? "shj" : "ajm"; // different in each organisation, so "the same code" is never a reason for a request to succeed
  reg.extra.branchCode = branchCode;
  const shj = await step("branch", () => api("owner", "POST", "/branches", { code: branchCode, name: C("branch"), addressLine1: C("branch-street"), city: "Sharjah", phone: "06 555 0000", email: `${C("branchmail").toLowerCase()}@canary-${tag.toLowerCase()}.test` }));
  note(C("branch"), C("branch-street"));
  add("branch", rec(shj)?._id);
  const role = await step("custom role", () => api("owner", "POST", "/access/roles", { key: `canary_${tag.toLowerCase()}_role`, name: C("role"), description: C("roledesc"), rank: 35, permissions: ["sales.view", "inventory.view"] }));
  note(C("role"), C("roledesc")); // (the role's key is not a marker: another organisation may name it, and it is then logged in that organisation's own trail)
  add("role", rec(role)?._id);
  const hire = await step("hired user", () => api("owner", "POST", "/access/users", { name: C("hire"), email: `${C("hire").toLowerCase()}@${code}.sec.test`, password: H.PASSWORD, role: `canary_${tag.toLowerCase()}_role` }));
  note(C("hire"), `${C("hire").toLowerCase()}@${code}.sec.test`);
  add("admin", rec(hire)?._id || rec(hire)?.id);
  // a person whose home is the Sharjah branch (made directly: the route makes them change their password first)
  if (shj?.status < 300) await step("branch user", () => person("branchUser", { type: "manager", branchId: branchCode }).then(() => ({ status: 200 })));
  const staffForm = new FormData();
  for (const [k, v] of Object.entries({ name: C("staff"), designation: C("designation"), contactNo: "0501234567", idNo: `784${tag === "A" ? "198765432109" : "112345678901"}8`, joiningDate: today() })) staffForm.append(k, v);
  const staff = await step("staff", () => api("owner", "POST", "/staff/staff", undefined, { form: staffForm }));
  note(C("staff"), C("designation"));
  add("staff", rec(staff)?._id);
  reg.extra.staffCode = rec(staff)?.staffId;
  reg.extra.roleKey = `canary_${tag.toLowerCase()}_role`;

  // ---------------------------------------------------------------- masters: categories, units, items, parties
  const cat = await step("category", () => api("owner", "POST", "/categories/categories", { name: C("category"), description: C("catdesc") }));
  note(C("category"), C("catdesc"));
  const categoryId = add("category", rec(cat)?._id);
  const unit = await step("unit", () => api("owner", "POST", "/uom/units", { unitName: C("unit"), shortCode: `CU${tag}`, type: "Base", category: "Weight" }));
  note(C("unit"), `CU${tag}`);
  const unitId = add("unit", rec(unit)?._id);
  const unit2 = await step("unit 2", () => api("owner", "POST", "/uom/units", { unitName: C("unit", 2), shortCode: `CV${tag}`, type: "Derived", category: "Weight" }));
  const unit2Id = add("unit", rec(unit2)?._id);
  if (unitId && unit2Id) {
    const conv = await step("unit conversion", () => api("owner", "POST", "/uom/conversions", { fromUOM: unitId, toUOM: unit2Id, conversionRatio: 12, category: "Weight" }));
    add("conversion", rec(conv)?._id);
  }
  const goods = await step("goods item", () => api("owner", "POST", "/stock/stock", { itemName: C("goods"), sku: C("sku"), categoryId, unitOfMeasure: unitId, origin: "UAE", brand: C("brand"), salesPrice: A.price, purchasePrice: A.cost, currentStock: 0, reorderLevel: 5 }));
  note(C("goods"), C("sku"), C("brand"));
  const goodsId = add("stock", rec(goods)?._id);
  reg.extra.itemCode = rec(goods)?.itemId;
  const service = await step("service item", () => api("owner", "POST", "/stock/stock", { itemName: C("service"), sku: C("sku", 2), categoryId, itemType: "service", salesPrice: A.serviceFee, purchasePrice: 0 }));
  note(C("service"), C("sku", 2));
  const serviceId = add("stock", rec(service)?._id);

  const cust = await step("customer", () => api("owner", "POST", "/customers", { customerName: C("customer"), contactPerson: C("contact"), email: `${C("custmail").toLowerCase()}@canary-${tag.toLowerCase()}.test`, phone: "0502223344", billingAddress: C("billing-address"), shippingAddress: C("shipping-address"), creditLimit: A.credit, paymentTerms: "Net 30", trnNumber: tag === "A" ? "100777222200003" : "100888444400003", eInvoice: { participantId: `0235:${tag === "A" ? "100777222200003" : "100888444400003"}`, city: "Dubai", countryCode: "AE" } }));
  note(C("customer"), C("contact"), C("billing-address"), C("shipping-address"), `${C("custmail").toLowerCase()}@canary-${tag.toLowerCase()}.test`, tag === "A" ? "100777222200003" : "100888444400003");
  const customerId = add("customer", rec(cust)?._id);
  reg.extra.customerCode = rec(cust)?.customerId;
  const cust2 = await step("customer 2", () => api("owner", "POST", "/customers", { customerName: C("customer", 2), contactPerson: C("contact", 2), email: `${C("custmail", 2).toLowerCase()}@canary-${tag.toLowerCase()}.test`, phone: "0502223355", billingAddress: C("billing-address", 2), creditLimit: 1000, paymentTerms: "Net 15" }));
  note(C("customer", 2));
  add("customer", rec(cust2)?._id);
  const vend = await step("vendor", () => api("owner", "POST", "/vendors/vendors", { vendorName: C("vendor"), contactPerson: C("vcontact"), email: `${C("vendmail").toLowerCase()}@canary-${tag.toLowerCase()}.test`, phone: "0504445566", address: C("vendor-address"), paymentTerms: "Net 30", trnNO: tag === "A" ? "100777333300003" : "100888555500003" }));
  note(C("vendor"), C("vcontact"), C("vendor-address"), tag === "A" ? "100777333300003" : "100888555500003");
  const vendorId = add("vendor", rec(vend)?._id);
  reg.extra.vendorCode = rec(vend)?.vendorId;

  // ---------------------------------------------------------------- accounting set-up: tax code, fiscal year, accounts
  const taxList = (await api("owner", "GET", "/accounting/tax-codes")).body || [];
  const std = taxList.find((t) => t.kind === "standard");
  taxList.forEach((t) => add("taxCode", t._id));
  const tax = await step("tax code", () => api("owner", "POST", "/accounting/tax-codes", { name: C("tax"), kind: "standard", ratePercent: 5 }));
  note(C("tax"));
  add("taxCode", rec(tax)?._id);
  const y = new Date().getFullYear();
  // provisioning already opened this year's fiscal year; add the next one as well
  for (const fy of (await api("owner", "GET", "/accounting/fiscal-years")).body || []) add("fiscalYear", fy._id);
  const fy = await step("fiscal year", () => api("owner", "POST", "/accounting/fiscal-years", { code: `FY${y + 1}`, startDate: `${y + 1}-01-01`, endDate: `${y + 1}-12-31` }));
  add("fiscalYear", rec(fy)?._id);
  const groups = (await api("owner", "GET", "/accounting/account-groups")).body || [];
  const findGroup = (n) => groups.find((g) => g.name === n);
  const grp = await step("account group", () => api("owner", "POST", "/accounting/account-groups", { name: C("group"), prefix: `${tag}ZG`, category: "ASSET", parentId: findGroup("Current Assets")?._id }));
  note(C("group"));
  add("accountGroup", rec(grp)?._id);
  groups.forEach((g) => add("accountGroup", g._id));
  const bankAcc = await step("bank account", () => api("owner", "POST", "/accounting/accounts", { accountName: C("bank-account"), groupId: findGroup("Bank")?._id, openingBalance: 5000, openingSide: "debit" }));
  note(C("bank-account"));
  const bankAccountId = add("account", rec(bankAcc)?._id);
  reg.extra.bankAccountId = bankAccountId;
  accounts.forEach((a) => add("account", a._id));

  // ---------------------------------------------------------------- trade documents
  const line = (itemId, qty, price, extra = {}) => ({ itemId, description: C("line"), qty, price, rate: price, vatPercent: 5, taxCodeId: std?._id, ...extra });
  const doc = (type, party, partyType, items, extra = {}) => api("owner", "POST", "/transactions/transactions", { type, partyId: party, partyType, partyTypeRef: partyType, items, notes: extra.notes || C("docnote"), ...extra });
  const approve = (id, extra = {}) => api("owner", "PATCH", `/transactions/transactions/${id}/process`, { action: "approve", ...extra });
  note(C("line"), C("docnote"));
  const po = await step("purchase order", () => doc("purchase_order", vendorId, "Vendor", [line(goodsId, A.buyQty, A.cost, { batchNumber: C("batch"), expiryDate: "2099-12-31" })]));
  note(C("batch"));
  const poId = add("transaction", rec(po)?._id);
  reg.extra.poNo = rec(po)?.transactionNo;
  if (poId) await step("approve purchase order", () => approve(poId));
  const po2 = await step("purchase order draft", () => doc("purchase_order", vendorId, "Vendor", [line(goodsId, 3, A.cost)], { notes: C("draftnote") }));
  note(C("draftnote"));
  add("transaction", rec(po2)?._id);
  const so = await step("sales order", () => doc("sales_order", customerId, "Customer", [line(goodsId, A.qty, A.price)]));
  const soId = add("transaction", rec(so)?._id);
  reg.extra.soNo = rec(so)?.transactionNo;
  reg.extra.soLineId = rec(so)?.items?.[0]?._id;
  if (soId) await step("approve sales order", () => approve(soId));
  const so2 = await step("sales order with a service", () => doc("sales_order", customerId, "Customer", [line(goodsId, 2, A.price), line(serviceId, 1, A.serviceFee)], { notes: C("draftnote", 2) }));
  const so2Id = add("transaction", rec(so2)?._id);
  note(C("draftnote", 2));
  if (soId && reg.extra.soLineId) {
    const sr = await step("sales return", () => doc("sales_return", customerId, "Customer", [line(goodsId, 4, A.price, { returnOfLineId: reg.extra.soLineId })], { returnOf: { transactionId: soId } }));
    const srId = add("transaction", rec(sr)?._id);
    if (srId) await step("approve sales return", () => approve(srId));
  }
  if (poId && rec(po)?.items?.[0]?._id) {
    const pr = await step("purchase return", () => doc("purchase_return", vendorId, "Vendor", [line(goodsId, 5, A.cost, { returnOfLineId: rec(po).items[0]._id })], { returnOf: { transactionId: poId } }));
    add("transaction", rec(pr)?._id);
  }

  // ---------------------------------------------------------------- quotation and delivery note
  const q = await step("quotation", () => api("owner", "POST", "/quotations", { partyId: customerId, validUntil: day(20), reference: C("rfq"), terms: C("terms"), notes: C("qnote"), items: [{ itemId: goodsId, qty: 7, price: A.quote, vatPercent: 5 }] }));
  note(C("rfq"), C("terms"), C("qnote"));
  const quoteId = add("quotation", rec(q)?._id);
  reg.extra.quotationNo = rec(q)?.quotationNo;
  if (quoteId) await step("send quotation", () => api("owner", "POST", `/quotations/${quoteId}/send`, {}));
  const q2 = await step("quotation 2", () => api("owner", "POST", "/quotations", { partyId: customerId, validUntil: day(10), items: [{ itemId: goodsId, qty: 1, price: A.quote, vatPercent: 5 }], notes: C("qnote", 2) }));
  note(C("qnote", 2));
  add("quotation", rec(q2)?._id);
  if (so2Id) {
    const pre = await api("owner", "GET", `/delivery-notes/from-order/${so2Id}`);
    const srcLine = pre.body?.lines?.[0]?.sourceLineId;
    if (srcLine) {
      const dn = await step("delivery note", () => api("owner", "POST", "/delivery-notes", { sourceTransactionId: so2Id, notes: C("dnnote"), items: [{ sourceLineId: srcLine, qty: 1 }] }));
      note(C("dnnote"));
      add("deliveryNote", rec(dn)?._id);
      reg.extra.deliveryNoteNo = rec(dn)?.deliveryNoteNo;
    }
  }

  // ---------------------------------------------------------------- vouchers: receipt, payment, journal, expense, contra, notes
  const cash = acct("Cash in Hand");
  const rent = acct("Rent Expense");
  const utilities = acct("Utilities");
  const v = (body) => api("owner", "POST", "/vouchers/vouchers", { date: today(), ...body });
  if (customerId && soId) {
    const rcpt = await step("receipt", () => v({ voucherType: "receipt", customerId, totalAmount: A.receipt, paymentMode: "cash", narration: C("receipt-note"), linkedInvoices: [{ invoiceId: soId, amount: A.receipt, balance: Math.round((Number(rec(so)?.totalAmount || 0) - A.receipt) * 100) / 100 }] }));
    note(C("receipt-note"));
    add("voucher", rcpt?.data?.data?._id || rcpt?.body?._id);
  }
  const pay = await step("payment", () => v({ voucherType: "payment", vendorId, totalAmount: A.payment, paymentMode: "cash", narration: C("payment-note") }));
  note(C("payment-note"));
  add("voucher", pay?.data?.data?._id || pay?.body?._id);
  if (rent && cash && utilities) {
    const jr = await step("journal", () => v({ voucherType: "journal", narration: C("journal-note"), lines: [{ accountId: rent._id, debit: A.journal, narration: C("journal-line") }, { accountId: cash._id, credit: A.journal }] }));
    note(C("journal-note"), C("journal-line"));
    add("voucher", jr?.data?.data?._id || jr?.body?._id);
    const ex = await step("expense", () => v({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: A.expense, taxCodeId: std?._id, description: C("expense-desc"), paymentMode: "cash" }));
    note(C("expense-desc"));
    add("voucher", ex?.data?.data?._id || ex?.body?._id);
  }
  if (cash && bankAccountId) {
    const co = await step("contra", () => v({ voucherType: "contra", ledgerBased: true, fromAccountId: bankAccountId, toAccountId: cash._id, totalAmount: A.contra, narration: C("contra-note") }));
    note(C("contra-note"));
    add("voucher", co?.data?.data?._id || co?.body?._id);
  }
  const income = acct("Other Income") || acct("Sales Revenue");
  if (income && customerId) {
    const cn = await step("credit note", () => v({ voucherType: "credit_note", partyType: "Customer", partyId: customerId, narration: C("cn-note"), lines: [{ accountId: income._id, amount: A.note, description: C("cn-line") }] }));
    note(C("cn-note"), C("cn-line"));
    add("voucher", cn?.data?.data?._id || cn?.body?._id);
    const dnv = await step("debit note", () => v({ voucherType: "debit_note", partyType: "Customer", partyId: customerId, narration: C("dn-note"), lines: [{ accountId: income._id, amount: A.note + 1, description: C("dn-line") }] }));
    note(C("dn-note"), C("dn-line"));
    add("voucher", dnv?.data?.data?._id || dnv?.body?._id);
  }

  // ---------------------------------------------------------------- banking: masters, a cheque, a statement
  const bank = await step("bank master", () => api("owner", "POST", "/banking/banks", { bankName: C("bank"), bankCode: `CB${tag}`, swiftCode: "EBILAEAD", country: "AE" }));
  note(C("bank"), `CB${tag}`);
  const bankMasterId = add("bank", rec(bank)?._id);
  const ct = await step("card type", () => api("owner", "POST", "/banking/card-types", { name: C("cardtype"), processingFeePercent: 2.5 }));
  note(C("cardtype"));
  add("cardType", rec(ct)?._id);
  const card = await step("card", () => api("owner", "POST", "/banking/cards", { label: C("card"), kind: "terminal", cardTypeId: rec(ct)?._id, accountId: bankAccountId }));
  note(C("card"));
  add("card", rec(card)?._id);
  if (customerId && bankAccountId) {
    const chq = await step("cheque receipt", () => v({ voucherType: "receipt", customerId, totalAmount: 600.37 + (tag === "A" ? 0 : 1), paymentMode: "cheque", paymentDetails: { chequeNo: C("chq"), chequeDate: day(5), accountId: bankAccountId, bankName: C("chqbank"), drawnOnBankName: C("chqbank") } }));
    note(C("chq"), C("chqbank"));
    add("voucher", chq?.data?.data?._id || chq?.body?._id);
    const cheques = await api("owner", "GET", "/banking/cheques");
    for (const c of cheques.body?.rows || cheques.body || []) add("cheque", c._id);
    const rv = await step("receipt for the statement", () => v({ voucherType: "receipt", customerId, totalAmount: 525.5, date: day(-3), paymentMode: "transfer", paymentDetails: { accountId: bankAccountId, reference: C("trf") } }));
    note(C("trf"));
    add("voucher", rv?.data?.data?._id || rv?.body?._id);
    const REC = "/banking/reconciliation";
    await step("reconciliation set-up", () => api("owner", "PUT", `${REC}/setup`, { accountId: bankAccountId, startDay: day(-3), statementOpening: 0 }));
    const grid = [["Date", "Description", "Debit", "Credit", "Balance"], [dmy(day(-3)), `TRANSFER ${C("stmt-line")}`, "", "525.50", "525.50"], [dmy(day(-2)), `BANK CHARGES ${C("stmt-fee")}`, "10.50", "", "515.00"]];
    note(C("stmt-line"), C("stmt-fee"));
    const imp = await step("statement import", () => api("owner", "POST", `${REC}/import`, { accountId: bankAccountId, rows: grid, fileName: `${C("statement")}.csv` }));
    note(C("statement"));
    add("statementImport", imp?.body?.importId || imp?.body?._id || imp?.body?.import?._id);
    const lines = await api("owner", "GET", `${REC}/lines?accountId=${bankAccountId}`);
    for (const l of lines.body?.rows || lines.body?.lines || (Array.isArray(lines.body) ? lines.body : [])) add("statementLine", l._id);
  }

  // ---------------------------------------------------------------- attachments, e-invoicing, sending, sharing
  const form = new FormData();
  form.append("file", new Blob([PDF], { type: "application/pdf" }), `${C("attachment")}.pdf`);
  form.append("ownerType", "account");
  form.append("ownerId", bankAccountId || "");
  form.append("label", C("attlabel"));
  const att = await step("attachment", () => api("owner", "POST", "/accounting/attachments", undefined, { form }));
  note(C("attachment"), C("attlabel"));
  reg.extra.attachmentId = att?.body?.attachmentId;
  add("attachment", rec(att)?.attachmentId);
  if (soId) {
    const sub = await step("e-invoice submission", () => api("owner", "POST", `/einvoice/submit/${soId}`, {}));
    const subId = rec(sub)?._id || rec(sub)?.id || rec(sub)?.submissionId;
    add("einvoiceSubmission", subId);
    // settle it for good (the sandbox acknowledges, then reports): the once-a-minute poll then has nothing left to change
    for (const s of ((await api("owner", "GET", "/einvoice/submissions")).body?.rows || [])) {
      add("einvoiceSubmission", s._id);
      await api("owner", "POST", `/einvoice/submissions/${s._id}/refresh`, {});
      await api("owner", "POST", `/einvoice/submissions/${s._id}/refresh`, {});
    }
    const sent = await step("send the invoice", () => api("owner", "POST", "/messaging/send", { docType: "tax_invoice", sourceId: soId, force: true }, { headers: { "Idempotency-Key": `sec-${tag}-${Date.now()}-0001` } }));
    add("send", sent?.body?.send?._id);
    const url = sent?.body?.share?.url;
    if (url) { reg.extra.shareToken = url.split("/d/")[1]; add("share", sent.body.share._id || sent.body.share.id); note(reg.extra.shareToken?.split(".")[0]); }
    const shares = await api("owner", "GET", "/messaging/shares");
    for (const s of shares.body?.rows || []) add("share", s._id);
  }

  // ---------------------------------------------------------------- currencies, document types, opening balances
  const cur = await step("currency", () => api("owner", "POST", "/currencies", { code: tag === "A" ? "USD" : "EUR", name: C("currency"), symbol: "$", rate: tag === "A" ? 3.6725 : 4.0123 }));
  note(C("currency"));
  reg.extra.currencyCode = tag === "A" ? "USD" : "EUR";
  const dt = await step("document type", () => api("owner", "POST", "/document-types", { name: C("doctype"), appliesTo: "customer", hasExpiry: true }));
  note(C("doctype"));
  add("documentType", rec(dt)?._id);
  await step("opening balance (go live)", () => api("owner", "PUT", "/opening-balances/go-live", { date: `${y}-01-01` }));

  // ---------------------------------------------------------------- the ids of everything the organisation owns, read back from the database
  reg.dbIds = await ownedIds(stack, code);
  say(`seeded: ${Object.entries(reg.kinds).map(([k, n]) => `${k}=${n}`).join(" ")} | failures: ${reg.failures.length}`);
  return reg;
}

/** Make every model known to this process (a model nobody has required cannot be listed). */
function loadAllModels() {
  const fs = require("fs");
  const path = require("path");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));
  for (const file of walk(path.join(H.ROOT, "models"))) {
    if (file.includes(`${path.sep}platform${path.sep}`)) continue; // the developer console's own collections carry no organisation
    try { require(file); } catch (_) { /* a helper that is not a model */ }
  }
}

/** Every _id of every tenant-scoped collection that belongs to `code`, by model name. */
async function ownedIds(stack, code) {
  const mongoose = require("mongoose");
  loadAllModels();
  const out = {};
  await stack.raw(async () => {
    for (const name of mongoose.modelNames()) {
      const M = mongoose.model(name);
      if (!M.schema.path("companyId")) continue;
      const rows = await M.find({ companyId: code }).select("_id").lean();
      if (rows.length) out[name] = rows.map((r) => String(r._id));
    }
  });
  return out;
}

module.exports = { seedOrg, ownedIds, loadAllModels, AMOUNTS, PDF, today, day };
