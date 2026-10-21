// Phase 1 - the company's masters, its chart, and the go-live position on 1 Jan 2025. Idempotent: every step looks first and
// only creates what is missing, and the ids found are kept in abc-state.json for the trading phase.
const { api, rec, log, r2, loadState, saveState } = require("./abc-lib.cjs");
const D = require("./abc-data.cjs");

const GO_LIVE = "2025-01-01";
const listOf = (res) => {
  const b = res?.body;
  if (Array.isArray(b)) return b;
  if (b && typeof b === "object") for (const k of ["customers", "vendors", "stocks", "stock", "categories", "units", "rows", "items"]) if (Array.isArray(b[k])) return b[k];
  return [];
};
const must = (res, what) => {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${res.code || ""} ${res.message || ""}`);
  return res;
};

(async () => {
  const S = loadState() || { ids: {}, steps: {} };
  S.ids ||= {};
  const I = S.ids;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18);

  // ---- lookups: groups, tax codes
  const groups = listOf({ body: (await api("GET", "/accounting/account-groups")).body });
  const group = (n) => { const g = groups.find((x) => x.name === n); if (!g) throw new Error(`group "${n}" not found`); return g._id; };
  const tax = (await api("GET", "/accounting/tax-codes")).body || [];
  I.tax = { std: tax.find((t) => t.kind === "standard")?._id, zero: tax.find((t) => t.kind === "zero_rated")?._id, none: tax.find((t) => t.kind === "out_of_scope")?._id };
  if (!I.tax.std || !I.tax.zero) throw new Error("the standard and zero-rated tax codes are missing");
  log("tax codes:", Object.keys(I.tax).filter((k) => I.tax[k]).join(", "));

  // ---- banks (masters)
  I.bank ||= {};
  const haveBanks = listOf(await api("GET", "/banking/banks"));
  for (const b of D.BANKS) {
    let row = haveBanks.find((x) => x.bankCode === b.bankCode);
    if (!row) row = rec(must(await api("POST", "/banking/banks", { bankName: b.bankName, bankCode: b.bankCode, swiftCode: b.swiftCode, country: "AE" }), `bank ${b.bankName}`));
    I.bank[b.key] = row._id;
  }
  log("banks:", Object.keys(I.bank).length);

  // ---- units, categories
  I.unit ||= {};
  const haveUnits = listOf(await api("GET", "/uom/units"));
  for (const u of D.UNITS) {
    let row = haveUnits.find((x) => x.shortCode === u.shortCode);
    if (!row) row = rec(must(await api("POST", "/uom/units", { unitName: u.unitName, shortCode: u.shortCode, type: u.type, category: u.category }), `unit ${u.unitName}`));
    I.unit[u.key] = row._id;
  }
  I.cat ||= {};
  const haveCats = listOf(await api("GET", "/categories/categories?limit=200"));
  for (const c of D.CATEGORIES) {
    let row = haveCats.find((x) => x.name === c);
    if (!row) row = rec(must(await api("POST", "/categories/categories", { name: c, description: `${c} - wholesale trade` }), `category ${c}`));
    I.cat[c] = row._id;
  }
  log("units:", Object.keys(I.unit).length, "categories:", Object.keys(I.cat).length);

  // ---- chart: extra accounts and the three bank accounts
  I.acct ||= {};
  const readAccounts = async () => {
    const list = (await api("GET", "/accounting/accounts/postable")).body || [];
    for (const a of list) I.acct[a.accountName] = a._id;
    return list;
  };
  await readAccounts();
  for (const [name, grp] of D.EXTRA_ACCOUNTS) {
    if (I.acct[name]) continue;
    const r = must(await api("POST", "/accounting/accounts", { accountName: name, groupId: group(grp) }), `account ${name}`);
    I.acct[name] = rec(r)._id;
  }
  for (const b of D.BANK_ACCOUNTS) {
    if (I.acct[b.name]) continue;
    const r = must(await api("POST", "/accounting/accounts", {
      accountName: b.name, groupId: group("Bank"),
      bank: { bankId: I.bank[b.bank], branchCode: b.branchCode, accountNumber: b.number, iban: b.iban, accountHolder: b.holder },
    }), `bank account ${b.name}`);
    I.acct[b.name] = rec(r)._id;
  }
  await readAccounts();
  // the unused starter "Bank Account" is switched off so every receipt and payment names a real bank
  if (I.acct["Bank Account"]) await api("PUT", `/accounting/accounts/${I.acct["Bank Account"]}`, { isActive: false }, { quiet: true });
  log("accounts known:", Object.keys(I.acct).length);

  // ---- vendors and customers
  I.vendor ||= {};
  const haveVendors = listOf(await api("GET", "/vendors/vendors?limit=500"));
  for (const v of D.VENDORS) {
    let row = haveVendors.find((x) => x.vendorName === v.name);
    if (!row) row = rec(must(await api("POST", "/vendors/vendors", { vendorName: v.name, contactPerson: v.contact, email: `accounts@${slug(v.name)}.ae`, phone: v.phone, address: v.city, paymentTerms: v.terms, trnNO: v.trn }), `vendor ${v.name}`));
    I.vendor[v.key] = row._id;
  }
  I.customer ||= {};
  const haveCustomers = listOf(await api("GET", "/customers/customers?limit=500"));
  for (const c of D.CUSTOMERS) {
    let row = haveCustomers.find((x) => x.customerName === c.name);
    if (!row) {
      const body = { customerName: c.name, contactPerson: c.contact, email: `purchasing@${slug(c.name)}.ae`, phone: c.phone, billingAddress: c.addr, shippingAddress: c.addr, creditLimit: c.credit, paymentTerms: c.terms };
      if (c.trn) body.trnNumber = c.trn;
      row = rec(must(await api("POST", "/customers", body), `customer ${c.name}`));
    }
    I.customer[c.key] = row._id;
  }
  log("vendors:", Object.keys(I.vendor).length, "customers:", Object.keys(I.customer).length);

  // ---- items
  I.item ||= {};
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
  log("items:", Object.keys(I.item).length);

  // ---- fiscal year 2025 (Dubai midnight to Dubai midnight, the way provisioning makes a year) and the go-live day
  const years = (await api("GET", "/accounting/fiscal-years")).body || [];
  I.fy ||= {};
  let fy25 = years.find((y) => y.code === "2025");
  if (!fy25) fy25 = rec(must(await api("POST", "/accounting/fiscal-years", { code: "2025", startDate: "2024-12-31T20:00:00.000Z", endDate: "2025-12-31T19:59:59.999Z" }), "fiscal year 2025"));
  I.fy["2025"] = fy25._id;
  I.fy["2026"] = (years.find((y) => y.code === "2026") || {})._id;
  log("fiscal years:", JSON.stringify(I.fy));

  const gl = await api("GET", "/opening-balances/summary");
  const already = gl.body?.goLive?.date || gl.body?.goLiveDate;
  if (!S.steps.goLive) {
    must(await api("PUT", "/opening-balances/go-live", { date: GO_LIVE }), "go-live date");
    S.steps.goLive = true; saveState(S);
  }

  // ---- opening position
  const A = I.acct;
  const enbd = A[D.BANK_ACCOUNTS[0].name], mash = A[D.BANK_ACCOUNTS[1].name], rak = A[D.BANK_ACCOUNTS[2].name];
  const stockRows = D.ITEMS.map((it) => ({ itemId: I.item[it.sku], qty: it.open[0], unitCost: it.open[1] }));
  const stockValue = r2(D.ITEMS.reduce((t, it) => t + r2(it.open[0] * it.open[1]), 0));
  const arOpen = r2(D.OPENING_CUSTOMERS.reduce((t, r) => t + r[2], 0));
  const apOpen = r2(D.OPENING_VENDORS.reduce((t, r) => t + r[2], 0));
  const dr = [
    ["Cash in Hand", 18500], ["Petty Cash", 2500], [D.BANK_ACCOUNTS[0].name, 386742.5], [D.BANK_ACCOUNTS[1].name, 118235], [D.BANK_ACCOUNTS[2].name, 54620.75],
    ["Furniture & Equipment", 92000], ["Vehicles", 168000], ["Security Deposits", 30000], ["Prepaid Expenses", 14400],
  ];
  const cr = [
    ["Accumulated Depreciation - Furniture & Equipment", 27600], ["Accumulated Depreciation - Vehicles", 50400], ["Bank Loan", 180000],
    ["Accrued Expenses", 22300], ["Owner's Capital", 500000],
  ];
  const sum = (rows) => r2(rows.reduce((t, r) => t + r[1], 0));
  // what is left for retained earnings so that, with the stock and the carried-forward invoices, the books open with no suspense balance
  const retained = r2(sum(dr) + stockValue + arOpen - sum(cr) - apOpen);
  const lines = [
    ...dr.map(([n, v]) => ({ accountId: A[n], debit: v })),
    ...cr.map(([n, v]) => ({ accountId: A[n], credit: v })),
    retained >= 0 ? { accountId: A["Retained Earnings"], credit: retained } : { accountId: A["Retained Earnings"], debit: -retained },
  ];
  for (const l of lines) if (!l.accountId) throw new Error("an opening account is missing from the chart");

  if (!S.steps.openAccounts) {
    must(await api("POST", "/opening-balances/accounts", { date: GO_LIVE, lines, narration: "Opening balances brought forward - 1 January 2025" }), "opening account balances");
    S.steps.openAccounts = true; saveState(S); log("opening balances posted; retained earnings", retained);
  }
  if (!S.steps.openCustomers) {
    const rows = D.OPENING_CUSTOMERS.map(([k, ref, amt, dueIn]) => ({ partyId: I.customer[k], reference: ref, date: GO_LIVE, dueDate: new Date(Date.UTC(2025, 0, 1 + dueIn)).toISOString().slice(0, 10), amount: amt }));
    must(await api("POST", "/opening-balances/parties", { type: "customer", date: GO_LIVE, rows }), "opening customer invoices");
    S.steps.openCustomers = true; saveState(S);
  }
  if (!S.steps.openVendors) {
    const rows = D.OPENING_VENDORS.map(([k, ref, amt, dueIn]) => ({ partyId: I.vendor[k], reference: ref, date: GO_LIVE, dueDate: new Date(Date.UTC(2025, 0, 1 + dueIn)).toISOString().slice(0, 10), amount: amt }));
    must(await api("POST", "/opening-balances/parties", { type: "vendor", date: GO_LIVE, rows }), "opening vendor invoices");
    S.steps.openVendors = true; saveState(S);
  }
  if (!S.steps.openStock) {
    must(await api("POST", "/opening-balances/stock", { date: GO_LIVE, rows: stockRows }), "opening stock");
    S.steps.openStock = true; saveState(S);
  }
  log(`SETUP DONE - opening stock ${stockValue}, carried-forward receivables ${arOpen}, payables ${apOpen}, retained earnings ${retained}`);
  saveState(S);
})().catch((e) => { log("SETUP FAILED:", e.message); process.exit(1); });
