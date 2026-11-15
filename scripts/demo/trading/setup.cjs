// Phase "setup": the company's letterhead, its fiscal years, its masters, its chart, its banks and its
// go-live position. Modelled on scripts/demo/abc-setup.cjs (same request bodies, which are proven) with
// three differences: the dates come from "today", the company is Sahara Gate, and nothing real is
// used - phones are 050 000 01xx and e-mails end in @example.com, so nothing the demo sends can reach
// a real person even if the mail guard were ever off.
const D = require("../abc-data.cjs");
const { r2, rec, listOf, must } = require("./lib.cjs");

const COMPANY = "Sahara Gate Foodstuff Trading LLC";
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18);

// Fake but plausible: 15 digits, the shape the form accepts.
const TRN = "100500123400003";

async function setup(ctx) {
  const { api, START, log } = ctx;
  const I = ctx.ids;
  const startDay = START;
  const startYear = Number(startDay.slice(0, 4));

  must(await api("PUT", "/accounting/settings", {
    profile: {
      legalName: COMPANY, trn: TRN, addressLine1: "Warehouse 14, Ras Al Khor Industrial Area 2", city: "Dubai",
      emirate: "Dubai", vatRegistered: true, email: "accounts@saharagate.example.com", phone: "+971 50 000 0100",
    },
  }), "company profile");

  // The tax codes and the groups, by name, so no id is written into this file.
  const groups = listOf(await api("GET", "/accounting/account-groups"));
  const group = (n) => { const g = groups.find((x) => x.name === n); if (!g) throw new Error(`account group "${n}" not found`); return g._id; };
  const tax = (await api("GET", "/accounting/tax-codes")).body || [];
  I.tax = { std: tax.find((t) => t.kind === "standard")?._id, zero: tax.find((t) => t.kind === "zero_rated")?._id };
  if (!I.tax.std || !I.tax.zero) throw new Error("the standard and zero-rated tax codes are missing: is this an AE organisation?");

  // Fiscal years: the one provisioning made (this year) plus the year the go-live day falls in.
  const years = listOf(await api("GET", "/accounting/fiscal-years"));
  I.fy = {};
  for (const y of years) I.fy[y.code] = y._id;
  for (let y = startYear; y < new Date().getUTCFullYear(); y += 1) {
    if (I.fy[String(y)]) continue;
    const r = must(await api("POST", "/accounting/fiscal-years", {
      code: String(y), startDate: `${y - 1}-12-31T20:00:00.000Z`, endDate: `${y}-12-31T19:59:59.999Z`,
    }), `fiscal year ${y}`);
    I.fy[String(y)] = rec(r)._id;
  }
  log("fiscal years:", Object.keys(I.fy).join(", "));

  // banks (masters)
  I.bank = {};
  const haveBanks = listOf(await api("GET", "/banking/banks"));
  for (const b of D.BANKS) {
    let row = haveBanks.find((x) => x.bankCode === b.bankCode);
    if (!row) row = rec(must(await api("POST", "/banking/banks", { bankName: b.bankName, bankCode: b.bankCode, swiftCode: b.swiftCode, country: "AE" }), `bank ${b.bankName}`));
    I.bank[b.key] = row._id;
  }

  // units and categories
  I.unit = {};
  const haveUnits = listOf(await api("GET", "/uom/units"));
  for (const u of D.UNITS) {
    const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
    let row = haveUnits.find((x) => same(x.shortCode, u.shortCode) || same(x.unitName, u.unitName));
    if (!row) row = rec(must(await api("POST", "/uom/units", { unitName: u.unitName, shortCode: u.shortCode, type: u.type, category: u.category }), `unit ${u.unitName}`));
    I.unit[u.key] = row._id;
  }
  I.cat = {};
  const haveCats = listOf(await api("GET", "/categories/categories?limit=200"));
  for (const c of D.CATEGORIES) {
    let row = haveCats.find((x) => x.name === c);
    if (!row) row = rec(must(await api("POST", "/categories/categories", { name: c, description: `${c} - wholesale trade` }), `category ${c}`));
    I.cat[c] = row._id;
  }

  // chart: the extra accounts and the three bank accounts
  I.acct = {};
  const readAccounts = async () => {
    for (const a of listOf(await api("GET", "/accounting/accounts/postable"))) I.acct[a.accountName] = a._id;
  };
  await readAccounts();
  for (const [name, grp] of D.EXTRA_ACCOUNTS) {
    if (I.acct[name]) continue;
    I.acct[name] = rec(must(await api("POST", "/accounting/accounts", { accountName: name, groupId: group(grp) }), `account ${name}`))._id;
  }
  const holder = COMPANY.toUpperCase();
  for (const b of D.BANK_ACCOUNTS) {
    if (I.acct[b.name]) continue;
    I.acct[b.name] = rec(must(await api("POST", "/accounting/accounts", {
      accountName: b.name, groupId: group("Bank"),
      bank: { bankId: I.bank[b.bank], branchCode: b.branchCode, accountNumber: b.number, iban: b.iban, accountHolder: holder },
    }), `bank account ${b.name}`))._id;
  }
  await readAccounts();
  // the unused starter "Bank Account" is switched off so every receipt and payment names a real bank
  if (I.acct["Bank Account"]) await api("PUT", `/accounting/accounts/${I.acct["Bank Account"]}`, { isActive: false });
  I.BANK = { enbd: I.acct[D.BANK_ACCOUNTS[0].name], mashreq: I.acct[D.BANK_ACCOUNTS[1].name], rak: I.acct[D.BANK_ACCOUNTS[2].name] };

  // vendors and customers (all phones and e-mails are made up)
  I.vendor = {};
  const haveVendors = listOf(await api("GET", "/vendors/vendors?limit=500"));
  let n = 0;
  for (const v of D.VENDORS) {
    n += 1;
    let row = haveVendors.find((x) => x.vendorName === v.name);
    if (!row) row = rec(must(await api("POST", "/vendors/vendors", {
      vendorName: v.name, contactPerson: v.contact, email: `accounts@${slug(v.name)}.example.com`,
      phone: `+971 50 000 02${String(n).padStart(2, "0")}`, address: v.city, paymentTerms: v.terms, trnNO: v.trn,
    }), `vendor ${v.name}`));
    I.vendor[v.key] = row._id;
  }
  I.customer = {};
  const haveCustomers = listOf(await api("GET", "/customers/customers?limit=500"));
  n = 0;
  for (const c of D.CUSTOMERS) {
    n += 1;
    let row = haveCustomers.find((x) => x.customerName === c.name);
    if (!row) {
      const body = {
        customerName: c.name, contactPerson: c.contact, email: `purchasing@${slug(c.name)}.example.com`,
        phone: `+971 50 000 01${String(n).padStart(2, "0")}`, billingAddress: c.addr, shippingAddress: c.addr,
        // generous while the history is written, then set to the real figures at the very end (phase "finish")
        creditLimit: c.credit * 20, paymentTerms: c.terms,
      };
      if (c.trn) body.trnNumber = c.trn;
      row = rec(must(await api("POST", "/customers", body), `customer ${c.name}`));
    }
    I.customer[c.key] = row._id;
  }

  // items
  I.item = {};
  const haveItems = listOf(await api("GET", "/stock/stock?limit=500"));
  for (const it of D.ITEMS) {
    let row = haveItems.find((x) => x.sku === it.sku);
    if (!row) {
      row = rec(must(await api("POST", "/stock/stock", {
        itemName: it.name, sku: it.sku, categoryId: I.cat[it.cat], unitOfMeasure: I.unit[it.unit], vendorId: I.vendor[it.vendor],
        origin: it.origin, brand: it.brand, salesPrice: it.price, purchasePrice: it.cost, currentStock: 0, reorderLevel: it.reorder,
      }), `item ${it.sku}`));
    }
    I.item[it.sku] = row._id;
  }
  log(`masters: ${Object.keys(I.vendor).length} vendors, ${Object.keys(I.customer).length} customers, ${Object.keys(I.item).length} items`);

  // go-live and the opening position (no carried-forward invoices: the story has its own overdue ones)
  must(await api("PUT", "/opening-balances/go-live", { date: startDay }), "go-live date");
  const A = I.acct;
  const stockRows = D.ITEMS.map((it) => ({ itemId: I.item[it.sku], qty: it.open[0], unitCost: it.open[1] }));
  const stockValue = r2(D.ITEMS.reduce((t, it) => t + r2(it.open[0] * it.open[1]), 0));
  const dr = [
    ["Cash in Hand", 18500], ["Petty Cash", 2500], [D.BANK_ACCOUNTS[0].name, 586742.5], [D.BANK_ACCOUNTS[1].name, 218235], [D.BANK_ACCOUNTS[2].name, 54620.75],
    ["Furniture & Equipment", 92000], ["Vehicles", 168000], ["Security Deposits", 30000], ["Prepaid Expenses", 14400],
  ];
  const cr = [
    ["Accumulated Depreciation - Furniture & Equipment", 27600], ["Accumulated Depreciation - Vehicles", 50400], ["Bank Loan", 180000],
    ["Accrued Expenses", 22300], ["Owner's Capital", 500000],
  ];
  const sum = (rows) => r2(rows.reduce((t, r) => t + r[1], 0));
  const retained = r2(sum(dr) + stockValue - sum(cr));
  const lines = [
    ...dr.map(([nm, v]) => ({ accountId: A[nm], debit: v })),
    ...cr.map(([nm, v]) => ({ accountId: A[nm], credit: v })),
    retained >= 0 ? { accountId: A["Retained Earnings"], credit: retained } : { accountId: A["Retained Earnings"], debit: -retained },
  ];
  for (const l of lines) if (!l.accountId) throw new Error("an opening account is missing from the chart");
  must(await api("POST", "/opening-balances/accounts", { date: startDay, lines, narration: "Opening balances brought forward" }), "opening account balances");
  must(await api("POST", "/opening-balances/stock", { date: startDay, rows: stockRows }), "opening stock");
  log(`opening position posted: stock ${stockValue}, retained earnings ${retained}`);
}

// Rebuild ctx.ids from what is already in the company (read only), so later phases can run in their own
// process after "setup" has finished.
async function loadIds(ctx) {
  const { api } = ctx;
  const I = (ctx.ids = {});
  const tax = (await api("GET", "/accounting/tax-codes")).body || [];
  I.tax = { std: tax.find((t) => t.kind === "standard")?._id, zero: tax.find((t) => t.kind === "zero_rated")?._id };
  I.fy = {};
  for (const y of listOf(await api("GET", "/accounting/fiscal-years"))) I.fy[y.code] = y._id;
  I.acct = {};
  for (const a of listOf(await api("GET", "/accounting/accounts/postable"))) I.acct[a.accountName] = a._id;
  I.BANK = { enbd: I.acct[D.BANK_ACCOUNTS[0].name], mashreq: I.acct[D.BANK_ACCOUNTS[1].name], rak: I.acct[D.BANK_ACCOUNTS[2].name] };
  I.vendor = {};
  const vendors = listOf(await api("GET", "/vendors/vendors?limit=500"));
  for (const v of D.VENDORS) I.vendor[v.key] = vendors.find((x) => x.vendorName === v.name)?._id;
  I.customer = {};
  const customers = listOf(await api("GET", "/customers/customers?limit=500"));
  for (const c of D.CUSTOMERS) I.customer[c.key] = customers.find((x) => x.customerName === c.name)?._id;
  I.item = {};
  const items = listOf(await api("GET", "/stock/stock?limit=500"));
  for (const it of D.ITEMS) I.item[it.sku] = items.find((x) => x.sku === it.sku)?._id;
  const missing = [
    ...Object.entries(I.vendor).filter(([, v]) => !v).map(([k]) => `vendor ${k}`),
    ...Object.entries(I.customer).filter(([, v]) => !v).map(([k]) => `customer ${k}`),
    ...Object.entries(I.item).filter(([, v]) => !v).map(([k]) => `item ${k}`),
    ...(I.BANK.enbd && I.BANK.mashreq && I.BANK.rak ? [] : ["bank accounts"]),
  ];
  if (missing.length) throw new Error(`the company is not set up yet (missing: ${missing.slice(0, 5).join(", ")}). Run --phase=setup first.`);
}

module.exports = { setup, loadIds, COMPANY };
