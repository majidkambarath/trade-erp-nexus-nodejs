// Phase "trading": the company trades, one day at a time, from the go-live day to today. Everything goes
// through the HTTP API with the owner's sign-in: sales and purchases are created then approved (so
// stock, ledger and VAT move exactly as in life), customers pay on their terms by transfer, cheque or
// cash, suppliers are paid on theirs, and the month's rent, utilities, salaries and bank charges are
// entered as expense vouchers. A "hook" (story.cjs) may add a dated document on its day, which is how
// the demo script's named records land on their own dates.
const D = require("../abc-data.cjs");
const { r2, iso, parse, addDays, isWeekday, nextWeekday, rec, listOf, pmap } = require("./lib.cjs");
const CONC = Number(process.env.CONCURRENCY || 3);

const termDays = (t) => {
  const m = /(\d+)/.exec(String(t || ""));
  return m ? Number(m[1]) : 0;
};
// Customers the story writes its own documents for in the last two months: the engine leaves them alone then.
const STORY_CUSTOMERS = new Set(["garden", "basket", "coral", "madina", "feast"]);

async function trade(ctx) {
  const { api, R, ids: I, log } = ctx;
  const start = parse(ctx.START);
  const today = parse(ctx.TODAY);
  const quietFrom = addDays(today, -62);
  const itemBy = Object.fromEntries(D.ITEMS.map((i) => [i.sku, i]));
  const custBy = Object.fromEntries(D.CUSTOMERS.map((c) => [c.key, c]));
  const vendBy = Object.fromEntries(D.VENDORS.map((v) => [v.key, v]));

  const T = (ctx.T = {
    stock: Object.fromEntries(D.ITEMS.map((i) => [i.sku, i.open[0]])),
    cost: Object.fromEntries(D.ITEMS.map((i) => [i.sku, i.open[1]])),
    ar: [], ap: [], cheques: [], sales: [], purchases: [], counts: {}, failed: [], recentSales: {},
  });
  const count = (k) => { T.counts[k] = (T.counts[k] || 0) + 1; };
  const fail = (what, r) => { T.failed.push(`${what}: ${r.status} ${r.code || ""} ${r.message}`); };
  let ref = 4000;
  const nextRef = (p) => `${p}-${(ref += 1)}`;

  const approve = async (id, what, as = api) => {
    const a = await as("PATCH", `/transactions/transactions/${id}/process`, { action: "approve" });
    if (a.ok) return rec(a);
    fail(`approve ${what}`, a);
    await api("DELETE", `/transactions/transactions/${id}`); // a stray draft would block the year close
    return null;
  };

  // ---- documents ------------------------------------------------------------------------------------
  async function buy(Dt, wanted, vendorKey, { expiry = null, note = "Goods received at Ras Al Khor warehouse" } = {}) {
    const items = wanted.map((l) => {
      const it = itemBy[l.sku];
      const line = { itemId: I.item[l.sku], description: it.name, qty: l.qty, price: l.cost, rate: l.cost, vatPercent: 5, taxCodeId: I.tax.std };
      if (expiry && /^OIL-GHE/.test(l.sku)) { line.expiryDate = expiry; line.batchNumber = `GH${iso(Dt).replace(/-/g, "").slice(2)}`; }
      return line;
    });
    const c = await api("POST", "/transactions/transactions", {
      type: "purchase_order", partyId: I.vendor[vendorKey], partyType: "Vendor", partyTypeRef: "Vendor", date: iso(Dt), deliveryDate: iso(Dt),
      vendorReference: nextRef("VINV"), notes: note, items,
    });
    if (!c.ok) { fail(`purchase from ${vendorKey}`, c); return null; }
    const doc = await approve(rec(c)._id, `purchase ${rec(c).transactionNo}`);
    if (!doc) return null;
    count("purchases");
    for (const l of wanted) { T.stock[l.sku] += l.qty; T.cost[l.sku] = l.cost; }
    const v = vendBy[vendorKey];
    T.ap.push({ id: doc._id, no: doc.transactionNo, v: vendorKey, out: doc.outstandingAmount ?? doc.totalAmount, on: iso(addDays(Dt, termDays(v.terms) + R.int(-3, 8))) });
    T.purchases.push({ id: doc._id, v: vendorKey, lines: (doc.items || []).map((x, i) => ({ sku: wanted[i]?.sku, lineId: x._id, qty: x.qty, price: x.price, itemId: x.itemId })) });
    if (T.purchases.length > 8) T.purchases.shift();
    return doc;
  }

  // A sale. `lines` is [{sku, qty}]; `approveIt` false leaves a draft (the story's waiting invoice).
  async function sell(Dt, custKey, lines, { approveIt = true, note = "Delivered ex-warehouse", as = api } = {}) {
    const cust = custBy[custKey];
    const zero = cust.type === "export";
    lines = lines.filter((l) => T.stock[l.sku] >= l.qty);
    if (!lines.length) return null;
    for (const l of lines) T.stock[l.sku] -= l.qty; // reserved: sales run side by side
    const release = () => { for (const l of lines) T.stock[l.sku] += l.qty; };
    const items = lines.map((l) => {
      const it = itemBy[l.sku];
      return { itemId: I.item[l.sku], description: it.name, qty: l.qty, price: it.price, rate: it.price, vatPercent: zero ? 0 : 5, taxCodeId: zero ? I.tax.zero : I.tax.std };
    });
    const c = await as("POST", "/transactions/transactions", {
      type: "sales_order", partyId: I.customer[custKey], partyType: "Customer", partyTypeRef: "Customer", date: iso(Dt), deliveryDate: iso(Dt),
      lpono: `LPO-${R.int(1000, 9999)}`, notes: zero ? "Export to Oman - zero-rated, shipped from Ras Al Khor warehouse" : note, items,
    });
    if (!c.ok) { release(); fail(`sale to ${cust.name}`, c); return null; }
    const draft = rec(c);
    if (!approveIt) return draft;
    const doc = await approve(draft._id, `sale ${draft.transactionNo}`, as);
    if (!doc) { release(); return null; }
    count("sales");
    const entry = { id: doc._id, no: doc.transactionNo, c: custKey, out: doc.outstandingAmount ?? doc.totalAmount, total: doc.totalAmount, on: iso(addDays(Dt, termDays(cust.terms) + R.int(-2, 9))), date: iso(Dt) };
    T.ar.push(entry);
    T.sales.push({ id: doc._id, c: custKey, lines: (doc.items || []).map((x, i) => ({ sku: lines[i]?.sku, lineId: x._id, qty: x.qty, price: x.price, itemId: x.itemId })) });
    if (T.sales.length > 12) T.sales.shift();
    return { ...doc, entry };
  }

  // Buy whatever a story document needs and the shelf does not hold, the day before it.
  async function ensure(Dt, lines) {
    const byVendor = {};
    for (const l of lines) {
      const short = l.qty - T.stock[l.sku];
      if (short > 0) (byVendor[itemBy[l.sku].vendor] ||= []).push({ sku: l.sku, qty: short + Math.ceil(itemBy[l.sku].demand * 0.5), cost: itemBy[l.sku].cost });
    }
    for (const [v, wanted] of Object.entries(byVendor)) await buy(Dt, wanted, v);
  }
  T.sell = sell; T.buy = buy; T.ensure = ensure; T.itemBy = itemBy; T.custBy = custBy; T.nextRef = nextRef; T.approve = approve;

  const voucher = (body) => api("POST", "/vouchers/vouchers", body);

  // ---- money ----------------------------------------------------------------------------------------
  async function loadCheque(no) {
    const rows = listOf(await api("GET", "/banking/cheques"));
    return rows.find((c) => c.chequeNo === no);
  }
  const bankPick = () => { const x = R.next(); return x < 0.55 ? "enbd" : x < 0.8 ? "mashreq" : "rak"; };

  async function collect(Dt) {
    const day = iso(Dt);
    const by = {};
    for (const inv of T.ar) if (inv.out > 0.004 && inv.on <= day && !inv.held) (by[inv.c] ||= []).push(inv);
    await pmap(Object.keys(by), CONC, async (key) => {
      const cust = custBy[key];
      const invs = by[key].sort((a, b) => (a.on < b.on ? -1 : 1)).slice(0, 4);
      const part = invs.length === 1 && R.chance(0.1);
      const linked = invs.map((inv) => { const amt = part ? r2(inv.out * 0.6) : r2(inv.out); return { inv, amount: amt, balance: r2(inv.out - amt) }; });
      const total = r2(linked.reduce((t, l) => t + l.amount, 0));
      let mode = "transfer";
      const late = addDays(today, -25) < Dt; // a cheque written now would still be uncleared: keep the recent past simple
      const x = R.next();
      if (cust.type === "cash") mode = "cash";
      else if (cust.type !== "export" && !late && total >= 3000 && x < 0.15) mode = "cheque";
      else if (cust.type !== "export" && total <= 9000 && x > 0.93) mode = "cash";
      const body = {
        voucherType: "receipt", customerId: I.customer[key], totalAmount: total, date: day, paymentMode: mode,
        narration: `Receipt against ${linked.map((l) => l.inv.no).join(", ")}`,
        linkedInvoices: linked.map((l) => ({ invoiceId: l.inv.id, amount: l.amount, balance: l.balance })),
      };
      let chequeNo = null; let chequeDate = null;
      if (mode === "transfer") body.paymentDetails = { accountId: I.BANK[cust.type === "export" ? "enbd" : bankPick()], reference: nextRef("TRF") };
      if (mode === "cash") body.paymentDetails = { accountId: I.acct["Cash in Hand"], reference: nextRef("CR") };
      if (mode === "cheque") {
        chequeNo = String(R.int(100000, 999999)); chequeDate = nextWeekday(addDays(Dt, R.int(7, 18)));
        body.paymentDetails = { chequeNo, chequeDate: iso(chequeDate), accountId: I.BANK.enbd, drawnOnBankName: R.pick(["Dubai Islamic Bank", "Abu Dhabi Islamic Bank", "Commercial Bank of Dubai"]) };
      }
      const r = await voucher(body);
      if (!r.ok) { fail(`receipt from ${cust.name}`, r); return; }
      count("receipts");
      for (const l of linked) l.inv.out = l.balance;
      if (mode === "cheque") {
        const ch = await loadCheque(chequeNo);
        if (ch) T.cheques.push({ id: ch._id, no: chequeNo, on: iso(chequeDate) });
      }
    });
  }

  async function payVendors(Dt) {
    const day = iso(Dt);
    const by = {};
    for (const inv of T.ap) if (inv.out > 0.004 && inv.on <= day) (by[inv.v] ||= []).push(inv);
    await pmap(Object.keys(by), CONC, async (key) => {
      const invs = by[key].sort((a, b) => (a.on < b.on ? -1 : 1)).slice(0, 4);
      const total = r2(invs.reduce((t, i) => t + r2(i.out), 0));
      const r = await voucher({
        voucherType: "payment", vendorId: I.vendor[key], totalAmount: total, date: day, paymentMode: "transfer",
        paymentDetails: { accountId: I.BANK[R.chance(0.7) ? "enbd" : "mashreq"], reference: nextRef("PAY") },
        narration: `Payment of ${invs.map((i) => i.no).join(", ")}`,
        linkedInvoices: invs.map((i) => ({ invoiceId: i.id, amount: r2(i.out), balance: 0 })),
      });
      if (!r.ok) { fail(`payment to ${key}`, r); return; }
      count("payments");
      for (const i of invs) i.out = 0;
    });
  }

  async function clearCheques(Dt) {
    const day = iso(Dt);
    for (const ch of T.cheques.filter((c) => c.on <= day && !c.cleared)) {
      const r = await api("POST", `/banking/cheques/${ch.id}/clear`, { clearedOn: day });
      if (r.ok) { ch.cleared = true; count("chequesCleared"); } else fail(`clear cheque ${ch.no}`, r);
    }
    T.cheques = T.cheques.filter((c) => !c.cleared);
  }

  async function expense(Dt, account, amount, { vat = true, desc }) {
    const body = {
      voucherType: "expense", ledgerBased: true, expenseAccountId: I.acct[account], amount: r2(amount), description: desc,
      paymentMode: "transfer", date: iso(Dt), paymentDetails: { accountId: I.BANK.enbd, reference: nextRef("EXP") },
    };
    if (vat) body.taxCodeId = I.tax.std;
    const r = await voucher(body);
    if (r.ok) count("expenses"); else fail(`expense ${account}`, r);
  }

  async function monthly(Dt) {
    const dom = Dt.getUTCDate();
    const key = (n) => `${Dt.getUTCFullYear()}-${Dt.getUTCMonth()}:${n}`;
    const once = (n, day) => { if (dom >= day && !T.done[key(n)]) { T.done[key(n)] = true; return true; } return false; };
    if (once("rent", 3)) await expense(Dt, "Rent Expense", 12500, { desc: "Warehouse and office rent - Ras Al Khor" });
    if (once("util", 11)) await expense(Dt, "Utilities", R.int(2600, 3900), { desc: "DEWA electricity and water - warehouse" });
    if (once("tel", 14)) await expense(Dt, "Telephone & Internet", R.int(720, 860), { desc: "Business internet and mobile lines" });
    if (once("transport", 16)) await expense(Dt, "Transport & Delivery", R.int(1500, 3800), { desc: "Outsourced delivery runs - Sharjah and Ajman" });
    if (once("salary", 26)) await expense(Dt, "Salaries & Wages", 43200, { vat: false, desc: "Staff salaries via WPS" });
    const eom = new Date(Date.UTC(Dt.getUTCFullYear(), Dt.getUTCMonth() + 1, 0));
    let lastWd = eom; while (!isWeekday(lastWd)) lastWd = addDays(lastWd, -1);
    if (iso(Dt) === iso(lastWd) && !T.done[key("eom")]) {
      T.done[key("eom")] = true;
      await expense(Dt, "Bank Charges", R.int(95, 240), { desc: "Monthly account maintenance and transfer fees" });
    }
  }
  T.done = {};

  async function restock(Dt) {
    const lowByVendor = {};
    for (const it of D.ITEMS) {
      if (T.stock[it.sku] < it.reorder * 1.6) (lowByVendor[it.vendor] ||= []).push({ sku: it.sku, qty: Math.ceil(it.demand * 1.4), cost: r2(it.cost * (1 + (R.int(-20, 25) / 1000))) });
    }
    await pmap(Object.entries(lowByVendor), CONC, ([v, wanted]) => buy(Dt, wanted, v));
  }

  async function sales(Dt) {
    const n = R.chance(0.55) ? (R.chance(0.3) ? 2 : 1) : 0;
    const quiet = Dt >= quietFrom;
    const planned = [];
    for (let k = 0; k < n; k += 1) {
      const pool = D.CUSTOMERS.filter((c) => !(quiet && STORY_CUSTOMERS.has(c.key)));
      const weights = pool.flatMap((c) => Array(c.w).fill(c));
      const cust = R.pick(weights);
      const items = D.ITEMS.filter((it) => it.aff.includes(cust.type) && (cust.type !== "cash" || ["PCS", "CTN"].includes(it.unit)));
      const picked = [...items].sort(() => R.next() - 0.5).slice(0, cust.type === "cash" ? R.int(1, 2) : R.int(1, 4));
      const lines = picked.map((it) => {
        let qty = Math.max(1, Math.round((it.demand / 3) * (R.int(60, 140) / 100) * (cust.type === "cash" ? 0.1 : 1)));
        if (cust.type === "cash") qty = Math.min(qty, 6);
        qty = Math.min(qty, Math.floor(T.stock[it.sku] * 0.6));
        return qty >= 1 ? { sku: it.sku, qty } : null;
      }).filter(Boolean);
      if (lines.length) planned.push([cust.key, lines]);
    }
    await pmap(planned, CONC, ([key, lines]) => sell(Dt, key, lines));
  }

  async function aReturn(Dt) {
    const src = T.sales[T.sales.length - 1];
    if (!src) return;
    const line = src.lines.find((l) => l.qty >= 2 && l.sku);
    if (!line) return;
    const it = itemBy[line.sku];
    const c = await api("POST", "/transactions/transactions", {
      type: "sales_return", partyId: I.customer[src.c], partyType: "Customer", partyTypeRef: "Customer", date: iso(Dt),
      returnOf: { transactionId: src.id }, notes: "Goods returned by customer: damaged packaging",
      items: [{ itemId: line.itemId, description: it.name, qty: 1, price: line.price, rate: line.price, vatPercent: custBy[src.c].type === "export" ? 0 : 5, taxCodeId: I.tax.std, returnOfLineId: line.lineId }],
    });
    if (!c.ok) { fail("sales return", c); return; }
    if (await approve(rec(c)._id, "sales return")) { count("salesReturns"); T.stock[line.sku] += 1; }
  }

  // ---- the days -------------------------------------------------------------------------------------
  const hooks = require("./story.cjs").hooks(ctx);
  const lastDay = addDays(today, -1);
  let n = 0;
  for (let Dt = start; Dt <= lastDay; Dt = addDays(Dt, 1)) {
    const day = iso(Dt);
    if (isWeekday(Dt)) {
      await sales(Dt);
      if (Dt.getUTCDate() % 3 === 0 && Dt < addDays(today, -9)) await restock(Dt);
      await collect(Dt);
      await payVendors(Dt);
      await clearCheques(Dt);
      await monthly(Dt);
      if (Dt.getUTCDate() === 18 && Dt.getUTCMonth() % 2 === 0) await aReturn(Dt);
    }
    if (hooks[day]) { await hooks[day](Dt); }
    n += 1;
    if (n % 10 === 0) log(`${day}: ${JSON.stringify(T.counts)}`);
  }
  log(`trading done: ${JSON.stringify(T.counts)}`);
  if (T.failed.length) {
    log(`${T.failed.length} refusals (first 12):`);
    for (const f of T.failed.slice(0, 12)) log(`   ${f}`);
  }
}

module.exports = { trade, termDays };
