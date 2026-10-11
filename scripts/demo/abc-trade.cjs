// Phase 2 - trading, day by day, from go-live to UNTIL (inclusive). Every document is entered through the real routes
// (create, then approve), so stock, ledger, VAT and party balances move exactly as they would for a person at a desk.
// Resumable: the day, the random-number state and everything open (invoices, cheques, stock) live in abc-state.json.
const { api, rec, rng, r2, iso, addDays, parse, isWeekday, lastDayOfMonth, loadState, saveState, log } = require("./abc-lib.cjs");
const D = require("./abc-data.cjs");

const UNTIL = process.env.UNTIL;
const REAL_TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10); // TODAY=YYYY-MM-DD pins the one wall-clock input (quotation validity)
if (!UNTIL) { console.log("UNTIL=YYYY-MM-DD is required"); process.exit(1); }
const DEMAND_SCALE = 6;
const SEASON = {
  2025: [1.0, 1.0, 1.35, 1.1, 0.95, 0.9, 0.85, 0.85, 0.95, 1.0, 1.05, 1.1], // Ramadan in March
  2026: [1.0, 1.25, 1.2, 1.0, 0.95, 0.9, 0.85, 0.85, 0.95, 1.0, 1.05, 1.1], // Ramadan from mid February
};
const TYPE_SHARE = { supermarket: 0.3, wholesale: 0.4, caterer: 0.22, restaurant: 0.12, hotel: 0.14, export: 0.7, cash: 0.03 };
const TYPE_PRICE = { wholesale: 0.975, export: 0.96, cash: 1.05 };
const DRAWN_ON = ["Emirates NBD", "Dubai Islamic Bank", "Abu Dhabi Islamic Bank", "Commercial Bank of Dubai", "Mashreq Bank", "RAKBANK", "Sharjah Islamic Bank"];
const RETURNS = [
  { on: "2025-04-16", kind: "sales", party: "madina", sku: "SUG-WHT-10", qty: 12 },
  { on: "2025-08-21", kind: "purchase", party: "oils", sku: "OIL-SUN-18", qty: 6 },
  { on: "2025-11-12", kind: "sales", party: "feast", sku: "RIC-WHT-25", qty: 8 },
  { on: "2026-03-24", kind: "sales", party: "basket", sku: "TEA-CTC-20", qty: 5 },
  { on: "2026-07-14", kind: "sales", party: "garden", sku: "OIL-CRN-09", qty: 3 },
];

const S = loadState();
if (!S?.ids?.item) { console.log("run abc-setup.cjs first"); process.exit(1); }
const I = S.ids;
const R = rng(20250101);
const itemBy = Object.fromEntries(D.ITEMS.map((i) => [i.sku, i]));
const custBy = Object.fromEntries(D.CUSTOMERS.map((c) => [c.key, c]));
const termDays = (t) => { const m = /(\d+)/.exec(String(t || "")); return m ? Number(m[1]) : 0; };
const ref = (p) => `${p}${R.int(10000000, 99999999)}`;
const CONCURRENCY = 1;
const LEAN = 2.6; // 10 invoices a month instead of 26, each 2.6 times the size
async function pmap(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}

(async () => {
  // ---------------------------------------------------------------- state
  if (!S.trade) {
    const T = { next: "2025-01-02", rng: null, stock: {}, cost: {}, price: {}, ar: [], ap: [], cheques: [], sales: {}, pos: {}, done: {}, loan: 180000, n: {}, refused: 0, streak: 0 };
    for (const it of D.ITEMS) { T.stock[it.sku] = it.open[0]; T.cost[it.sku] = it.cost; T.price[it.sku] = it.price; }
    const byRef = async (type, key) => {
      const rows = (await api("GET", `/opening-balances/parties?type=${type}`)).body?.rows || [];
      return rows;
    };
    const custRows = await byRef("customer");
    for (const [k, rf, , dueIn] of D.OPENING_CUSTOMERS) {
      const row = custRows.find((r) => r.reference === rf);
      T.ar.push({ id: row._id, no: row.transactionNo, c: k, total: row.amount, out: row.outstanding, on: iso(addDays(parse("2025-01-01"), dueIn + R.int(0, 10))) });
    }
    const venRows = await byRef("vendor");
    for (const [k, rf, , dueIn] of D.OPENING_VENDORS) {
      const row = venRows.find((r) => r.reference === rf);
      T.ap.push({ id: row._id, no: row.transactionNo, v: k, total: row.amount, out: row.outstanding, on: iso(addDays(parse("2025-01-01"), dueIn + R.int(0, 6))) });
    }
    S.trade = T;
  }
  const T = S.trade;
  if (T.rng != null) R.state = T.rng;
  const count = (k, n = 1) => { T.n[k] = (T.n[k] || 0) + n; };
  const fail = (what, r) => { T.refused += 1; T.streak += 1; log(`  REFUSED ${what}: ${r.status} ${r.code || ""} ${String(r.message).slice(0, 140)}`); if (T.streak > 25) { saveState(S); throw new Error("too many refusals in a row - stopping to look"); } };
  const okay = () => { T.streak = 0; };

  const acct = (n) => { if (/^[0-9a-f]{24}$/.test(String(n))) return n; const id = I.acct[n]; if (!id) throw new Error(`no account ${n}`); return id; };
  const BANK = { enbd: acct(D.BANK_ACCOUNTS[0].name), mashreq: acct(D.BANK_ACCOUNTS[1].name), rak: acct(D.BANK_ACCOUNTS[2].name) };
  async function ensureCards() {
    if (T.cards) return;
    const listOf = (r) => (Array.isArray(r.body) ? r.body : r.body?.rows || []);
    const haveTypes = listOf(await api("GET", "/banking/card-types"));
    const mkType = async (name, fee) => haveTypes.find((t) => t.name === name) || rec(await api("POST", "/banking/card-types", { name, processingFeePercent: fee }));
    const vm = await mkType("Visa / Mastercard (POS)", 2.25);
    const ax = await mkType("American Express (POS)", 3.0);
    const haveCards = listOf(await api("GET", "/banking/cards"));
    const mkCard = async (body) => haveCards.find((c) => c.label === body.label) || rec(await api("POST", "/banking/cards", body));
    const terminal = await mkCard({ label: "POS Terminal - Ras Al Khor Showroom", kind: "terminal", cardTypeId: vm._id, accountId: BANK.rak, terminalId: "RAK-T-0457" });
    const credit = await mkCard({ label: "ENBD Business Credit Card", kind: "credit", cardTypeId: ax._id, holderName: "ABC TRADE LLC", last4: "4821", creditLimit: 60000, expiryMonth: 11, expiryYear: 2029 });
    if (!terminal?._id || !credit?._id) throw new Error("cards could not be set up");
    T.cards = { terminal: terminal._id, credit: credit._id, creditAccount: credit.accountId || null };
    log("cards ready: POS terminal + company credit card", T.cards.creditAccount ? "(ledger account " + T.cards.creditAccount + ")" : "");
  }
  const bankPick = () => { const x = R.next(); return x < 0.55 ? "enbd" : x < 0.75 ? "mashreq" : "rak"; };

  // ---------------------------------------------------------------- documents
  async function approveOrDrop(id, what) {
    const a = await api("PATCH", `/transactions/transactions/${id}/process`, { action: "approve" });
    if (a.ok) return rec(a);
    fail(`approve ${what}`, a);
    await api("DELETE", `/transactions/transactions/${id}`, undefined, { quiet: true }); // a stray draft would block the year close
    return null;
  }

  async function makeSale(Dt, cust, wanted) {
    const zero = cust.type === "export";
    const season = SEASON[Dt.getUTCFullYear()]?.[Dt.getUTCMonth()] || 1;
    let lines = wanted;
    if (!lines) {
      const pool = D.ITEMS.filter((it) => it.aff.includes(cust.type) && (cust.type !== "cash" || ["PCS", "CTN"].includes(it.unit)));
      const picked = [...pool].sort(() => R.next() - 0.5).slice(0, cust.type === "cash" ? R.int(1, 2) : R.int(1, 4));
      lines = picked.map((it) => {
        let qty = Math.round(it.demand * DEMAND_SCALE * TYPE_SHARE[cust.type] * season * LEAN * (R.int(60, 140) / 100));
        if (cust.type === "cash") qty = Math.min(qty, 6);
        qty = Math.max(1, Math.min(qty, T.stock[it.sku]));
        return T.stock[it.sku] >= 1 ? { sku: it.sku, qty } : null;
      }).filter(Boolean);
    }
    lines = lines.filter((l) => T.stock[l.sku] >= l.qty);
    if (!lines.length) return null;
    for (const l of lines) T.stock[l.sku] -= l.qty; // reserved: sales run side by side
    const release = () => { for (const l of lines) T.stock[l.sku] += l.qty; };
    const items = lines.map((l) => {
      const it = itemBy[l.sku];
      const price = r2(T.price[l.sku] * (TYPE_PRICE[cust.type] || 1));
      return { itemId: I.item[l.sku], description: it.name, qty: l.qty, price, rate: price, vatPercent: zero ? 0 : 5, taxCodeId: zero ? I.tax.zero : I.tax.std };
    });
    const c = await api("POST", "/transactions/transactions", {
      type: "sales_order", partyId: I.customer[cust.key], partyType: "Customer", partyTypeRef: "Customer", date: iso(Dt), deliveryDate: iso(Dt),
      lpono: `LPO-${R.int(1000, 9999)}`, notes: zero ? "Export to Oman - zero-rated, shipped from Ras Al Khor warehouse" : "Delivered ex-warehouse", items,
    });
    if (!c.ok) { release(); fail(`sale to ${cust.name}`, c); return null; }
    const doc = await approveOrDrop(rec(c)._id, `sale ${rec(c).transactionNo}`);
    if (!doc) { release(); return null; }
    okay(); count("sales");
    const due = iso(addDays(Dt, termDays(cust.terms) + (cust.type === "cash" ? 0 : R.int(0, 18))));
    T.ar.push({ id: doc._id, no: doc.transactionNo, c: cust.key, total: doc.totalAmount, out: doc.outstandingAmount ?? doc.totalAmount, on: due });
    const keep = (T.sales[cust.key] ||= []);
    keep.push({ id: doc._id, no: doc.transactionNo, date: iso(Dt), lines: (doc.items || []).map((x, i) => ({ sku: lines[i]?.sku, lineId: x._id, qty: x.qty, price: x.price, itemId: x.itemId })) });
    if (keep.length > 8) keep.shift();
    return doc;
  }

  async function makePurchase(Dt, vendorKey, wanted) {
    const items = wanted.map((l) => {
      const it = itemBy[l.sku];
      return { itemId: I.item[l.sku], description: it.name, qty: l.qty, price: T.cost[l.sku], rate: T.cost[l.sku], vatPercent: 5, taxCodeId: I.tax.std };
    });
    const c = await api("POST", "/transactions/transactions", {
      type: "purchase_order", partyId: I.vendor[vendorKey], partyType: "Vendor", partyTypeRef: "Vendor", date: iso(Dt), deliveryDate: iso(Dt),
      vendorReference: `VINV-${R.int(10000, 99999)}`, notes: "Goods received at Ras Al Khor warehouse", items,
    });
    if (!c.ok) { fail(`purchase from ${vendorKey}`, c); return null; }
    const doc = await approveOrDrop(rec(c)._id, `purchase ${rec(c).transactionNo}`);
    if (!doc) return null;
    okay(); count("purchases");
    for (const l of wanted) T.stock[l.sku] += l.qty;
    const v = D.VENDORS.find((x) => x.key === vendorKey);
    T.ap.push({ id: doc._id, no: doc.transactionNo, v: vendorKey, total: doc.totalAmount, out: doc.outstandingAmount ?? doc.totalAmount, on: iso(addDays(Dt, termDays(v.terms) + R.int(-3, 8))) });
    const keep = (T.pos[vendorKey] ||= []);
    keep.push({ id: doc._id, no: doc.transactionNo, lines: (doc.items || []).map((x, i) => ({ sku: wanted[i]?.sku, lineId: x._id, qty: x.qty, price: x.price, itemId: x.itemId })) });
    if (keep.length > 6) keep.shift();
    return doc;
  }

  async function makeReturn(Dt, r) {
    const isSales = r.kind === "sales";
    const src = (isSales ? T.sales[r.party] : T.pos[r.party] || [])?.slice().reverse().find((d) => d.lines.some((l) => l.sku === r.sku && l.qty >= r.qty));
    if (!src) { log(`  (no ${r.kind} document to return ${r.sku} against - skipped)`); return; }
    const line = src.lines.find((l) => l.sku === r.sku && l.qty >= r.qty);
    const it = itemBy[r.sku];
    const c = await api("POST", "/transactions/transactions", {
      type: isSales ? "sales_return" : "purchase_return",
      partyId: isSales ? I.customer[r.party] : I.vendor[r.party], partyType: isSales ? "Customer" : "Vendor", partyTypeRef: isSales ? "Customer" : "Vendor",
      date: iso(Dt), returnOf: { transactionId: src.id }, notes: isSales ? "Goods returned by customer" : "Goods returned to supplier",
      items: [{ itemId: line.itemId || I.item[r.sku], description: it.name, qty: r.qty, price: line.price, rate: line.price, vatPercent: custBy[r.party]?.type === "export" ? 0 : 5, taxCodeId: I.tax.std, returnOfLineId: line.lineId }],
    });
    if (!c.ok) { fail(`${r.kind} return`, c); return; }
    const doc = await approveOrDrop(rec(c)._id, `${r.kind} return`);
    if (!doc) return;
    okay(); count(isSales ? "salesReturns" : "purchaseReturns");
    T.stock[r.sku] += isSales ? r.qty : -r.qty;
  }

  // ---------------------------------------------------------------- vouchers
  const voucher = (body) => api("POST", "/vouchers/vouchers", body);
  async function loadCheque(chequeNo) {
    const rows = (await api("GET", "/banking/cheques")).body?.rows || [];
    return rows.find((c) => c.chequeNo === chequeNo);
  }

  async function collect(Dt) {
    const today = iso(Dt);
    const byCust = {};
    for (const inv of T.ar) if (inv.out > 0.004 && inv.on <= today) (byCust[inv.c] ||= []).push(inv);
    await pmap(Object.keys(byCust), CONCURRENCY, async (key) => {
      const cust = custBy[key];
      const invs = byCust[key].sort((a, b) => (a.on < b.on ? -1 : 1)).slice(0, 4);
      const part = invs.length === 1 && R.chance(0.12);
      const linked = invs.map((inv) => {
        const amt = part ? r2(inv.out * 0.6) : r2(inv.out);
        return { inv, amount: amt, balance: r2(inv.out - amt) };
      });
      const total = r2(linked.reduce((t, l) => t + l.amount, 0));
      let mode = "transfer";
      if (cust.type === "cash") mode = R.chance(0.7) ? "card" : "cash";
      else if (["restaurant", "hotel", "caterer", "supermarket"].includes(cust.type) && total <= 15000 && R.chance(0.3)) mode = "card";
      else if (cust.type !== "export") { const x = R.next(); if (x < 0.14 && total >= 3000) mode = "cheque"; else if (x < 0.18 && total <= 12000) mode = "cash"; }
      const body = {
        voucherType: "receipt", customerId: I.customer[key], totalAmount: total, date: today, paymentMode: mode,
        narration: `Receipt against ${linked.map((l) => l.inv.no).join(", ")}`,
        linkedInvoices: linked.map((l) => ({ invoiceId: l.inv.id, amount: l.amount, balance: l.balance })),
      };
      let chequeNo = null, chequeDate = null;
      if (mode === "transfer") body.paymentDetails = { accountId: BANK[cust.type === "export" ? "enbd" : bankPick()], reference: ref("TRF") };
      if (mode === "card") body.paymentDetails = { cardId: T.cards.terminal, approvalCode: String(R.int(100000, 999999)) };
      if (mode === "cheque") {
        chequeNo = String(R.int(100000, 999999)); chequeDate = addDays(Dt, R.int(7, 21));
        while (!isWeekday(chequeDate)) chequeDate = addDays(chequeDate, 1);
        body.paymentDetails = { chequeNo, chequeDate: iso(chequeDate), accountId: BANK.enbd, drawnOnBankName: R.pick(DRAWN_ON) };
      }
      const r = await voucher(body);
      if (!r.ok) { fail(`receipt from ${cust.name}`, r); return; }
      okay(); count("receipts");
      for (const l of linked) l.inv.out = l.balance;
      if (mode === "card") count("cardReceipts");
      if (mode === "cheque") {
        const ch = await loadCheque(chequeNo);
        if (ch) T.cheques.push({ id: ch._id, no: chequeNo, on: iso(chequeDate), dir: "receipt", alloc: linked.map((l) => ({ invId: l.inv.id, amount: l.amount })) });
      }
    });
  }

  async function payVendors(Dt) {
    const today = iso(Dt);
    const byV = {};
    for (const inv of T.ap) if (inv.out > 0.004 && inv.on <= today) (byV[inv.v] ||= []).push(inv);
    await pmap(Object.keys(byV), CONCURRENCY, async (key) => {
      const invs = byV[key].sort((a, b) => (a.on < b.on ? -1 : 1)).slice(0, 4);
      const total = r2(invs.reduce((t, i) => t + r2(i.out), 0));
      const bank = R.chance(0.7) ? "enbd" : "mashreq";
      const byCheque = R.chance(0.2);
      const chequeNo = byCheque ? String(R.int(200000, 299999)) : null;
      let chequeOn = null;
      if (byCheque) { chequeOn = addDays(Dt, R.int(0, 12)); while (!isWeekday(chequeOn)) chequeOn = addDays(chequeOn, 1); }
      const r = await voucher({
        voucherType: "payment", vendorId: I.vendor[key], totalAmount: total, date: today, paymentMode: byCheque ? "cheque" : "transfer",
        paymentDetails: byCheque ? { chequeNo, chequeDate: iso(chequeOn), accountId: BANK[bank] } : { accountId: BANK[bank], reference: ref("PAY") },
        narration: `Payment of ${invs.map((i) => i.no).join(", ")}`,
        linkedInvoices: invs.map((i) => ({ invoiceId: i.id, amount: r2(i.out), balance: 0 })),
      });
      if (!r.ok) { fail(`payment to ${key}`, r); return; }
      okay(); count("payments");
      if (byCheque) {
        const ch = await loadCheque(chequeNo);
        if (ch) T.cheques.push({ id: ch._id, no: chequeNo, on: iso(chequeOn), dir: "payment", alloc: invs.map((i) => ({ invId: i.id, amount: i.out })) });
      }
      for (const i of invs) i.out = 0;
    });
  }

  async function clearCheques(Dt) {
    const today = iso(Dt);
    for (const ch of T.cheques.filter((c) => c.on <= today && !c.cleared)) {
      const r = await api("POST", `/banking/cheques/${ch.id}/clear`, { clearedOn: today });
      if (r.ok) { ch.cleared = true; count("chequesCleared"); okay(); } else fail(`clear cheque ${ch.no}`, r);
    }
    T.cheques = T.cheques.filter((c) => !c.cleared);
  }

  async function expense(Dt, account, amount, { vat = true, mode = "transfer", bank = "enbd", desc }) {
    const body = { voucherType: "expense", ledgerBased: true, expenseAccountId: acct(account), amount: r2(amount), description: desc, paymentMode: mode, date: iso(Dt) };
    if (vat) body.taxCodeId = I.tax.std;
    if (mode === "transfer") body.paymentDetails = { accountId: BANK[bank], reference: ref("EXP") };
    if (mode === "card") body.paymentDetails = { cardId: T.cards.credit };
    const r = await voucher(body);
    if (r.ok) { okay(); count("expenses"); return true; }
    fail(`expense ${account}`, r);
    return false;
  }
  async function journal(Dt, narration, lines) {
    const r = await voucher({ voucherType: "journal", date: iso(Dt), narration, lines: lines.map(([n, side, v, nar]) => ({ accountId: acct(n), [side]: r2(v), ...(nar ? { narration: nar } : {}) })) });
    if (r.ok) { okay(); count("journals"); } else fail(`journal ${narration}`, r);
  }
  async function contra(Dt, from, to, amount, narration) {
    const r = await voucher({ voucherType: "contra", ledgerBased: true, fromAccountId: from, toAccountId: to, totalAmount: r2(amount), narration, date: iso(Dt) });
    if (r.ok) { okay(); count("contras"); } else fail(`contra ${narration}`, r);
  }

  // once per key, on the first working day on or after `dom`
  const due = (Dt, key, dom) => {
    const k = `${Dt.getUTCFullYear()}-${String(Dt.getUTCMonth() + 1).padStart(2, "0")}:${key}`;
    if (T.done[k] || Dt.getUTCDate() < dom) return false;
    T.done[k] = true;
    return true;
  };

  async function monthly(Dt) {
    const y = Dt.getUTCFullYear(), m = Dt.getUTCMonth() + 1, summer = m >= 6 && m <= 9;
    if (due(Dt, "sweep", 20)) {
      const tb = await api("GET", `/vouchers/reports/financial?reportType=trial_balance&dateFrom=2025-01-01&dateTo=${iso(Dt)}`);
      const rows = tb.body?.report?.trialBalance || [];
      const bal = (n) => r2(rows.find((r) => r.accountName === n)?.balance || 0);
      const rak = bal(D.BANK_ACCOUNTS[2].name), mash = bal(D.BANK_ACCOUNTS[1].name), enbd = bal(D.BANK_ACCOUNTS[0].name);
      let pool = r2(rak - 25000);
      const toMash = Math.max(0, r2(Math.min(pool, 80000 - mash)));
      if (toMash > 1000) { await contra(Dt, BANK.rak, BANK.mashreq, toMash, "Collections swept to Mashreq operating account"); pool = r2(pool - toMash); }
      const toEnbd = Math.max(0, r2(Math.min(pool, 200000 - enbd)));
      if (toEnbd > 1000) await contra(Dt, BANK.rak, BANK.enbd, toEnbd, "Collections swept to Emirates NBD operating account");
    }
    if (due(Dt, "withdraw", 2)) await contra(Dt, BANK.enbd, acct("Cash in Hand"), 6000, "Cash withdrawn for counter and petty expenses");
    if (due(Dt, "rent", 3)) await expense(Dt, "Rent Expense", 12500, { desc: "Warehouse and office rent - Ras Al Khor" });
    if (due(Dt, "loan", 5)) {
      const interest = r2(T.loan * 0.07 / 12), principal = r2(3564 - interest);
      await journal(Dt, "Term loan instalment - Emirates NBD", [["Bank Loan", "debit", principal, "Principal"], ["Interest Expense", "debit", interest, "Interest"], [D.BANK_ACCOUNTS[0].name, "credit", 3564]]);
      T.loan = r2(T.loan - principal);
    }
    if (due(Dt, "fuel", 8)) { const a = R.int(600, 950); if (await expense(Dt, "Fuel & Vehicle Running", a, { mode: "card", desc: "Diesel - delivery trucks (company card)" })) T.ccDue = r2((T.ccDue || 0) + a * 1.05); }
    if (due(Dt, "util", 11)) await expense(Dt, "Utilities", R.int(2600, 3900) * (summer ? 1.4 : 1), { desc: "DEWA electricity and water - warehouse" });
    if (due(Dt, "tel", 14)) await expense(Dt, "Telephone & Internet", R.int(720, 860), { desc: "Business internet and mobile lines" });
    if (due(Dt, "transport", 16)) await expense(Dt, "Transport & Delivery", R.int(1500, 3800), { desc: "Outsourced delivery runs - Sharjah and Ajman" });
    if (R.chance(0.03) && due(Dt, "repair", 10)) await expense(Dt, "Repairs & Maintenance", R.int(400, 2400), { desc: "Truck servicing and warehouse repairs" });
    if (m % 3 === 1 && due(Dt, "mkt", 12)) { const a = R.int(1000, 3500); if (await expense(Dt, "Marketing & Advertising", a, { mode: "card", desc: "Trade flyers and WhatsApp catalogue campaign (company card)" })) T.ccDue = r2((T.ccDue || 0) + a * 1.05); }
    if (m === 3 || m === 9) { if (due(Dt, "ins", 9)) await expense(Dt, "Insurance", 9600, { desc: "Stock and vehicle insurance - half-year premium" }); }
    if (m === 1 && due(Dt, "licence", 20)) await expense(Dt, "Government Fees & Licences", 8750, { vat: false, desc: "Trade licence renewal - DED" });
    if (m % 3 === 0 && due(Dt, "audit", 20)) await expense(Dt, "Professional Fees", 3150, { desc: "Accounting and VAT filing services" });
    if (m % 3 === 0 && due(Dt, "draw", 24)) await journal(Dt, "Owner's drawings", [["Owner's Drawings", "debit", 15000], [D.BANK_ACCOUNTS[0].name, "credit", 15000]]);
    if (m % 3 === 0 && due(Dt, "deposit", 15)) await contra(Dt, acct("Cash in Hand"), BANK.enbd, 10000, "Counter cash deposited at Emirates NBD");
    if (due(Dt, "ccbill", 25) && (T.ccDue || 0) > 0 && T.cards?.creditAccount) {
      await journal(Dt, "Company credit card statement paid", [[T.cards.creditAccount, "debit", T.ccDue], [D.BANK_ACCOUNTS[0].name, "credit", T.ccDue]]);
      T.ccDue = 0;
    }
    if (due(Dt, "salary", 26)) await expense(Dt, "Salaries & Wages", y === 2025 ? 41000 : 43200, { vat: false, desc: "Staff salaries via WPS" });
    // last working day: bank charges and depreciation
    const eom = lastDayOfMonth(y, Dt.getUTCMonth());
    let lastWd = eom; while (!isWeekday(lastWd)) lastWd = addDays(lastWd, -1);
    if (iso(Dt) === iso(lastWd) && !T.done[`${y}-${m}:eom`]) {
      T.done[`${y}-${m}:eom`] = true;
      await expense(Dt, "Bank Charges", R.int(95, 240), { desc: "Monthly account maintenance and transfer fees" });
      await journal(Dt, "Monthly depreciation", [["Depreciation Expense", "debit", 4333.33], ["Accumulated Depreciation - Furniture & Equipment", "credit", 1533.33], ["Accumulated Depreciation - Vehicles", "credit", 2800]]);
    }
    // VAT return settled with the FTA on the 28th after each quarter
    if ([1, 4, 7, 10].includes(m) && due(Dt, "vat", 28)) {
      const qEnd = iso(new Date(Date.UTC(y, m - 1, 0)));
      const tb = await api("GET", `/vouchers/reports/financial?reportType=trial_balance&dateFrom=2025-01-01&dateTo=${qEnd}`);
      const rows = tb.body?.report?.trialBalance || [];
      const bal = (n) => r2(rows.find((r) => r.accountName === n)?.balance || 0);
      const out = bal("Output VAT"), inn = bal("Input VAT"), diff = r2(out - inn);
      if (out > 0 || inn > 0) {
        const lines = [["Output VAT", "debit", out], ["Input VAT", "credit", inn]];
        lines.push(diff >= 0 ? [D.BANK_ACCOUNTS[0].name, "credit", diff] : [D.BANK_ACCOUNTS[0].name, "debit", -diff]);
        await journal(Dt, `VAT return to period ending ${qEnd} - paid to FTA`, lines.filter((l) => l[2] > 0));
        count("vatSettlements");
      }
    }
  }

  // ---------------------------------------------------------------- flows
  const priceFor = (cust, sku) => r2(T.price[sku] * (TYPE_PRICE[cust.type] || 1));
  const itemsFor = (cust, lines, zero) => lines.map(([sku, qty]) => {
    const it = itemBy[sku], price = priceFor(cust, sku);
    return { itemId: I.item[sku], description: it.name, qty, price, rate: price, vatPercent: zero ? 0 : 5, taxCodeId: zero ? I.tax.zero : I.tax.std };
  });
  const bookSale = (Dt, custKey, doc, lines) => {
    const cust = custBy[custKey];
    T.ar.push({ id: doc._id, no: doc.transactionNo, c: custKey, total: doc.totalAmount, out: doc.outstandingAmount ?? doc.totalAmount, on: iso(addDays(Dt, termDays(cust.terms) + R.int(0, 18))) });
    const keep = (T.sales[custKey] ||= []);
    keep.push({ id: doc._id, no: doc.transactionNo, date: iso(Dt), lines: (doc.items || []).map((x, i) => ({ sku: lines[i]?.[0], lineId: x._id, qty: x.qty, price: x.price, itemId: x.itemId })) });
    if (keep.length > 8) keep.shift();
  };
  // only what is in stock; reserved at once
  const stockable = (lines) => { const ok = lines.filter(([sku, q]) => T.stock[sku] >= q); for (const [sku, q] of ok) T.stock[sku] -= q; return ok; };
  const unreserve = (lines) => { for (const [sku, q] of lines) T.stock[sku] += q; };

  async function approveOrder(Dt, custKey, order, lines) {
    const doc = await approveOrDrop(order._id, `order ${order.transactionNo}`);
    if (!doc) { unreserve(lines); return null; }
    okay(); count("sales"); bookSale(Dt, custKey, doc, lines);
    return doc;
  }

  // a quotation through its life: won (order), declined, left to expire, or delivered first and invoiced after
  async function quoteFlow(Dt, o) {
    const cust = custBy[o.cust], zero = cust.type === "export";
    const lines = stockable(o.lines);
    if (!lines.length) { log("  (quotation " + o.ref + ": nothing in stock - skipped)"); return; }
    const q = await api("POST", "/quotations", { partyId: I.customer[o.cust], date: o.quoteDate, validUntil: o.outcome === "expire" ? REAL_TODAY : iso(addDays(parse(REAL_TODAY), 30)), reference: o.ref, terms: "Prices valid for the period shown; payment " + cust.terms + "; delivery ex-warehouse", notes: o.note || "", items: itemsFor(cust, lines, zero) });
    if (!q.ok) { unreserve(lines); return fail("quotation " + o.ref, q); }
    const qid = rec(q)._id;
    const sent = await api("POST", `/quotations/${qid}/send`, {});
    if (!sent.ok) { unreserve(lines); return fail("send quotation", sent); }
    count("quotations");
    if (o.outcome === "expire") { unreserve(lines); log("  quotation " + o.ref + " left to lapse"); return; }
    if (o.outcome === "reject") { unreserve(lines); const r = await api("POST", `/quotations/${qid}/reject`, { reason: "Customer found a lower price elsewhere" }); if (!r.ok) fail("reject quotation", r); else count("quotationsDeclined"); return; }
    const acc = await api("POST", `/quotations/${qid}/accept`, { acceptedBy: cust.contact });
    if (!acc.ok) { unreserve(lines); return fail("accept quotation", acc); }
    if (o.outcome === "deliveryNote") {
      const dn = await api("POST", `/quotations/${qid}/delivery-note`, { date: iso(Dt) });
      if (!dn.ok) { unreserve(lines); return fail("quotation to delivery note", dn); }
      const note = dn.body?.deliveryNote || rec(dn);
      await deliverNote(Dt, note._id, cust.contact);
      const inv = await api("POST", "/delivery-notes/invoice", { deliveryNoteIds: [note._id], date: iso(Dt) });
      if (!inv.ok) { unreserve(lines); return fail("invoice from delivery note", inv); }
      count("deliveryNotes");
      await approveOrder(Dt, o.cust, inv.body.salesOrder, lines);
      return;
    }
    const conv = await api("POST", `/quotations/${qid}/convert`, { date: iso(Dt) });
    if (!conv.ok) { unreserve(lines); return fail("convert quotation", conv); }
    count("quotationsWon");
    await approveOrder(Dt, o.cust, conv.body.salesOrder, lines);
  }

  async function deliverNote(Dt, id, receivedBy) {
    const d = await api("POST", `/delivery-notes/${id}/dispatch`, { vehicleNo: "DXB " + R.pick(["A", "B", "K"]) + " " + R.int(1000, 9999), driverName: R.pick(["Raju", "Imran", "Sajid", "Anwar"]) });
    if (!d.ok) return fail("dispatch delivery note", d);
    const r = await api("POST", `/delivery-notes/${id}/deliver`, { receivedBy, proofNote: "Signed copy on file" });
    if (!r.ok) return fail("deliver delivery note", r);
    okay();
  }

  // delivery notes raised against an order in parts, then the order is approved (invoiced)
  async function deliveryFlow(Dt, o) {
    const cust = custBy[o.cust];
    const lines = stockable(o.lines);
    if (!lines.length) { log("  (delivery flow " + o.name + ": nothing in stock - skipped)"); return; }
    if (o.mode === "goodsFirst") {
      const dn = await api("POST", "/delivery-notes", { partyId: I.customer[o.cust], date: iso(Dt), notes: o.note, items: itemsFor(cust, lines, false) });
      if (!dn.ok) { unreserve(lines); return fail("delivery note " + o.name, dn); }
      const id = rec(dn)._id;
      await deliverNote(Dt, id, cust.contact);
      const inv = await api("POST", "/delivery-notes/invoice", { deliveryNoteIds: [id], date: iso(Dt) });
      if (!inv.ok) { unreserve(lines); return fail("invoice from notes " + o.name, inv); }
      count("deliveryNotes");
      return approveOrder(Dt, o.cust, inv.body.salesOrder, lines);
    }
    const order = await api("POST", "/transactions/transactions", { type: "sales_order", partyId: I.customer[o.cust], partyType: "Customer", partyTypeRef: "Customer", date: iso(Dt), deliveryDate: iso(Dt), lpono: "LPO-" + R.int(1000, 9999), notes: o.note, items: itemsFor(cust, lines, false) });
    if (!order.ok) { unreserve(lines); return fail("order for " + o.name, order); }
    const ord = rec(order);
    const pre = await api("GET", `/delivery-notes/from-order/${ord._id}`);
    const src = pre.body?.lines || [];
    for (const part of o.parts) {
      const items = src.map((l, i) => ({ sourceLineId: l.sourceLineId, qty: Math.max(1, Math.round(lines[i][1] * part)) })).filter((x, i) => x.qty > 0 && x.qty <= (src[i].remaining ?? src[i].qty ?? 1e9));
      const dn = await api("POST", "/delivery-notes", { sourceTransactionId: ord._id, date: iso(Dt), items });
      if (!dn.ok) { fail("delivery note part " + o.name, dn); continue; }
      await deliverNote(Dt, rec(dn)._id, cust.contact);
      count("deliveryNotes");
    }
    return approveOrder(Dt, o.cust, ord, lines);
  }

  async function note(Dt, kind, partyType, partyKey, account, net, why) {
    const isCust = partyType === "Customer";
    const r = await voucher({ voucherType: kind, partyType, partyId: isCust ? I.customer[partyKey] : I.vendor[partyKey], date: iso(Dt), narration: why, taxCodeId: I.tax.std, lines: [{ accountId: acct(account), amount: net, description: why }] });
    if (r.ok) { okay(); count("notes"); } else fail(kind + " " + partyKey, r);
  }
  async function advance(Dt, kind, key, amount, why) {
    const isRcpt = kind === "receipt";
    const r = await voucher({ voucherType: kind, [isRcpt ? "customerId" : "vendorId"]: isRcpt ? I.customer[key] : I.vendor[key], totalAmount: amount, date: iso(Dt), paymentMode: "transfer", paymentDetails: { accountId: BANK[isRcpt ? "rak" : "enbd"], reference: ref("ADV") }, narration: why });
    if (r.ok) { okay(); count("advances"); } else fail(kind + " on account " + key, r);
  }
  async function voidCheque(Dt, dir, action, reason) {
    let ch = T.cheques.find((c) => c.dir === dir && !c.cleared && c.on > iso(Dt));
    if (!ch && action === "bounce" && dir === "receipt") {
      const rows = (await api("GET", "/banking/cheques")).body?.rows || [];
      const cleared = rows.filter((c) => c.status === "cleared" && c.direction === "receipt").sort((a, b) => (a.chequeDate < b.chequeDate ? 1 : -1))[0];
      if (cleared) {
        const v = await api("GET", `/vouchers/vouchers/${cleared.voucherId}`);
        const linked = v.body?.voucher?.linkedInvoices || [];
        ch = { id: cleared._id, no: cleared.chequeNo, on: iso(Dt), dir, alloc: linked.map((l) => ({ invId: String(l.invoiceId?._id || l.invoiceId), amount: l.amount })), wasCleared: true };
      }
    }
    if (!ch) { log("  (no " + dir + " cheque to " + action + ")"); return; }
    const r = await api("POST", `/banking/cheques/${ch.id}/${action}`, { reason, on: iso(Dt) });
    if (!r.ok) return fail(`${action} cheque ${ch.no}`, r);
    okay(); count(action === "bounce" ? "chequesBounced" : "chequesCancelled");
    for (const a of ch.alloc || []) {
      const inv = (dir === "receipt" ? T.ar : T.ap).find((x) => x.id === a.invId);
      if (inv) { inv.out = r2(inv.out + a.amount); inv.on = iso(addDays(Dt, 7)); }
    }
    T.cheques = T.cheques.filter((c) => c !== ch);
  }

  const ENBD_N = D.BANK_ACCOUNTS[0].name;
  const FLOWS = [
    // quotations
    { on: "2025-03-19", name: "qt-basket", run: (d) => quoteFlow(d, { cust: "basket", quoteDate: "2025-03-12", ref: "RFQ-BSK-0312", outcome: "order", lines: [["SUG-WHT-50", 120], ["OIL-SUN-18", 60]], note: "Ramadan stocking order" }) },
    { on: "2025-05-21", name: "qt-feast", run: (d) => quoteFlow(d, { cust: "feast", quoteDate: "2025-05-14", ref: "RFQ-RFC-0514", outcome: "order", lines: [["RIC-SEL-20", 80], ["FLR-APF-50", 60], ["PUL-CHK-25", 20]], note: "Event season supply" }) },
    { on: "2025-08-13", name: "qt-pearl", run: (d) => quoteFlow(d, { cust: "pearl", quoteDate: "2025-08-06", ref: "RFQ-DPS-0806", outcome: "reject", lines: [["TEA-CTC-20", 40], ["OIL-GHE-16", 25]] }) },
    { on: "2025-10-22", name: "qt-palm", run: (d) => quoteFlow(d, { cust: "palm", quoteDate: "2025-10-15", ref: "RFQ-PGH-1015", outcome: "deliveryNote", lines: [["CAN-TOM-12", 40], ["CAN-CHK-24", 30], ["TEA-CTC-20", 15]], note: "Delivered first, invoiced after" }) },
    { on: "2026-02-17", name: "qt-reef", run: (d) => quoteFlow(d, { cust: "reef", quoteDate: "2026-02-10", ref: "RFQ-ART-0210", outcome: "order", lines: [["RIC-BAS-40", 90], ["SUG-WHT-50", 100]], note: "Pre-Ramadan wholesale order" }) },
    { on: "2026-04-09", name: "qt-coral", run: (d) => quoteFlow(d, { cust: "coral", quoteDate: "2026-10-02", ref: "RFQ-CBG-1002", outcome: "expire", lines: [["OIL-SUN-15", 30], ["RIC-BAS-05", 120]] }) },
    { on: "2026-06-24", name: "qt-sohar", run: (d) => quoteFlow(d, { cust: "sohar", quoteDate: "2026-06-17", ref: "RFQ-SVT-0617", outcome: "order", lines: [["RIC-WHT-25", 200], ["SUG-WHT-50", 150]], note: "Export - zero-rated" }) },
    // delivery notes
    { on: "2025-04-08", name: "dn-madina", run: (d) => deliveryFlow(d, { name: "madina", cust: "madina", mode: "orderFirst", parts: [0.6, 0.4], lines: [["RIC-BAS-40", 70], ["OIL-SUN-15", 60], ["TEA-CTC-20", 20]], note: "Delivered in two drops" }) },
    { on: "2025-09-17", name: "dn-garden", run: (d) => deliveryFlow(d, { name: "garden", cust: "garden", mode: "goodsFirst", lines: [["RIC-SEL-20", 25], ["OIL-SUN-18", 12], ["PUL-MAS-25", 6]], note: "Goods delivered before the invoice" }) },
    { on: "2026-01-22", name: "dn-seven", run: (d) => deliveryFlow(d, { name: "seven", cust: "seven", mode: "orderFirst", parts: [1], lines: [["FLR-APF-50", 30], ["OIL-CRN-09", 10]], note: "Single delivery" }) },
    // finance
    { on: "2025-05-05", name: "interbank", run: (d) => contra(d, BANK.enbd, BANK.mashreq, 75000, "Funds moved to Mashreq operating account") },
    { on: "2025-06-24", name: "cn-reef", run: (d) => note(d, "credit_note", "Customer", "reef", "Sales Discounts Given", 1200, "Volume rebate agreed for Q2 - Al Reef Trading") },
    { on: "2025-03-24", name: "capital", run: (d) => journal(d, "Capital introduced by the owner to fund the Ramadan stock build", [[ENBD_N, "debit", 250000], ["Owner's Capital", "credit", 250000]]) },
    { on: "2025-07-15", name: "vendor-advance", run: (d) => advance(d, "payment", "sugar", 25000, "Advance against next sugar shipment") },
    { on: "2025-08-12", name: "staff-advance", run: (d) => journal(d, "Salary advance - warehouse supervisor", [["Staff Advances", "debit", 3000], ["Cash in Hand", "credit", 3000]]) },
    { on: "2025-10-02", name: "dn-palm", run: (d) => note(d, "debit_note", "Customer", "palm", "Freight Recovered", 850, "Delivery charges recovered from customer") },
    { on: "2025-10-30", name: "staff-recovery", run: (d) => journal(d, "Salary advance recovered", [["Cash in Hand", "debit", 3000], ["Staff Advances", "credit", 3000]]) },
    { on: "2025-11-03", name: "customer-advance", run: (d) => advance(d, "receipt", "sohar", 50000, "Advance received against next export shipment") },
    { on: "2025-12-30", name: "accrual", run: (d) => journal(d, "Year-end accrual - audit fee", [["Professional Fees", "debit", 6300], ["Accrued Expenses", "credit", 6300]]) },
    { on: "2026-02-03", name: "dn-vendor", run: (d) => note(d, "debit_note", "Vendor", "gg", "Purchase Variance", 2400, "Short supply claim - 8 bags below invoiced weight") },
    { on: "2026-05-04", name: "interbank-2", run: (d) => contra(d, BANK.enbd, BANK.mashreq, 50000, "Funds moved to Mashreq operating account") },
    // cheques
    { on: "2025-08-19", name: "cheque-bounce", run: (d) => voidCheque(d, "receipt", "bounce", "Insufficient funds - returned by drawee bank") },
    { on: "2025-09-24", name: "cheque-cancel", run: (d) => voidCheque(d, "payment", "cancel", "Cheque withdrawn - paid by bank transfer instead") },
    { on: "2026-04-14", name: "cheque-bounce-2", run: (d) => voidCheque(d, "receipt", "bounce", "Signature mismatch - returned by drawee bank") },
  ];
  async function runFlows(Dt) {
    for (const f of FLOWS) {
      if (iso(Dt) >= f.on && !T.done["flow:" + f.name]) {
        T.done["flow:" + f.name] = true;
        try { await f.run(Dt); } catch (e) { log("  FLOW ERROR " + f.name + ": " + e.message); }
        saveState(S);
      }
    }
  }

  // ---------------------------------------------------------------- the loop
  await ensureCards();
  const END = parse(UNTIL);
  let Dt = parse(T.next);
  let monthKey = iso(Dt).slice(0, 7);
  const snap = () => `docs: ${T.n.sales || 0} sales, ${T.n.purchases || 0} purchases, ${T.n.receipts || 0} receipts, ${T.n.payments || 0} payments, ${T.n.expenses || 0} expenses, ${T.n.journals || 0} journals; refused ${T.refused}`;
  while (Dt <= END) {
    if (require('fs').existsSync(require('path').join(__dirname, 'abc-stop'))) { log('stop file found - stopped at ' + iso(Dt)); break; }
    if (!isWeekday(Dt)) { Dt = addDays(Dt, 1); continue; }
    const mk = iso(Dt).slice(0, 7);
    if (mk !== monthKey) { log(`== ${monthKey} done | ${snap()}`); monthKey = mk; }
    const y = Dt.getUTCFullYear(), mi = Dt.getUTCMonth();
    const season = SEASON[y]?.[mi] || 1;

    await clearCheques(Dt);
    await monthly(Dt);

    // purchases: one buying round a month (about a month of demand), and a mid-month top-up only for what has run short
    const dom = Dt.getUTCDate();
    const roundA = dom >= 3 && due(Dt, "buyA", 3);
    const roundB = !roundA && dom >= 17 && due(Dt, "buyB", 17);
    if (roundA || roundB) {
      for (const v of D.VENDORS) {
        const wanted = [];
        for (const it of D.ITEMS.filter((x) => x.vendor === v.key)) {
          const monthly = it.demand * DEMAND_SCALE * season * (y === 2026 ? 1.1 : 1);
          const need = roundA ? T.stock[it.sku] < monthly * 0.6 + it.reorder : T.stock[it.sku] < it.reorder * 1.2;
          if (!need) continue;
          const target = roundA ? monthly * 1.1 + it.reorder : monthly * 0.5 + it.reorder;
          const step = it.cost > 100 ? 5 : 10;
          const qty = Math.max(step, Math.ceil((target - T.stock[it.sku]) / step) * step);
          T.cost[it.sku] = r2(T.cost[it.sku] * (1 + (R.int(-12, 15) / 1000)));
          T.price[it.sku] = r2(Math.max(T.cost[it.sku] * 1.07, T.price[it.sku] * (1 + (R.int(-6, 10) / 1000))));
          wanted.push({ sku: it.sku, qty });
        }
        if (wanted.length) await makePurchase(Dt, v.key, wanted);
      }
    }

    // sales
    const expected = (10 * season * (y === 2026 ? 1.1 : 1)) / 21.7;
    let n = Math.floor(expected) + (R.next() < expected - Math.floor(expected) ? 1 : 0);
    const weights = D.CUSTOMERS.flatMap((c) => Array(c.w).fill(c.key));
    const todays = []; while (n-- > 0) todays.push(custBy[R.pick(weights)]);
    await pmap(todays, CONCURRENCY, (c) => makeSale(Dt, c));

    // scheduled returns, each preceded a few days earlier by the sale / purchase it returns against
    for (const r of RETURNS) {
      const sellOn = (() => { let d = addDays(parse(r.on), -6); while (!isWeekday(d)) d = addDays(d, -1); return iso(d); })();
      if (iso(Dt) === sellOn && !T.done[`ret-prep:${r.on}`]) {
        T.done[`ret-prep:${r.on}`] = true;
        if (r.kind === "sales") await makeSale(Dt, custBy[r.party], [{ sku: r.sku, qty: r.qty * 3 }]);
        else await makePurchase(Dt, r.party, [{ sku: r.sku, qty: r.qty * 3 }]);
      }
      if (iso(Dt) >= r.on && !T.done[`ret:${r.on}`]) { T.done[`ret:${r.on}`] = true; await makeReturn(Dt, r); }
    }

    await runFlows(Dt);
    await collect(Dt);
    await payVendors(Dt);

    Dt = addDays(Dt, 1);
    T.next = iso(Dt);
    T.rng = R.state;
    saveState(S);
  }
  log(`== RUN COMPLETE to ${UNTIL} | ${snap()}`);
  const open = (arr, k) => r2(arr.filter((x) => x.out > 0.004).reduce((t, x) => t + x.out, 0));
  log(`open receivables ${open(T.ar)} (${T.ar.filter((x) => x.out > 0.004).length} invoices) | open payables ${open(T.ap)} (${T.ap.filter((x) => x.out > 0.004).length}) | pending cheques ${T.cheques.length} | loan ${T.loan}`);
})().catch((e) => { log("TRADE STOPPED:", e.message); process.exit(1); });
