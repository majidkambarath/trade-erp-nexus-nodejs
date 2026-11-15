// The records the demo script names (trade erp/docs/sales-kit/demo-company.md), planted on their own
// dates, relative to today. They are written DURING the trading phase, on the day they belong to, so
// the history around them is consistent: the stock they need is bought the day before, and the
// engine leaves their customers alone for the last two months so nothing else muddies them.
const { r2, iso, parse, addDays, rec, listOf, must, nextWeekday } = require("./lib.cjs");

function hooks(ctx) {
  const { api, ids: I, log, T } = ctx;
  const today = parse(ctx.TODAY);
  const at = (n) => addDays(today, n);
  const day = (n) => iso(at(n));
  const map = {};
  const on = (n, fn) => {
    const k = day(n);
    const prev = map[k];
    map[k] = prev ? async (d) => { await prev(d); await fn(d); } : fn;
  };
  const ravi = () => ctx.peopleApis.sales?.api || api;
  const fatima = () => ctx.peopleApis.accountant?.api || api;
  const lineOf = (sku, qty, price) => {
    const it = T.itemBy[sku];
    return { itemId: I.item[sku], description: it.name, qty, price: price ?? it.price, rate: price ?? it.price, vatPercent: 5, taxCodeId: I.tax.std };
  };

  // 12. Last year closed and the months closed are done in the "finish" phase.

  // 11. A batch of Pure Ghee that expires 25 days from today.
  on(-30, async (d) => {
    await T.buy(d, [{ sku: "OIL-GHE-16", qty: 40, cost: 190 }], "oils", { expiry: day(25), note: "Pure Ghee: batch with a short expiry" });
    log("story: ghee batch expiring", day(25));
  });

  // 3. Spice Garden: an invoice 48 days old on Net 30 terms, so 18 days late, still unpaid.
  on(-50, async (d) => { await T.ensure(d, [{ sku: "FLR-APF-50", qty: 50 }, { sku: "RIC-SEL-20", qty: 30 }, { sku: "OIL-GHE-16", qty: 20 }]); });
  on(-48, async (d) => {
    const doc = await T.sell(d, "garden", [{ sku: "FLR-APF-50", qty: 50 }, { sku: "RIC-SEL-20", qty: 30 }, { sku: "OIL-GHE-16", qty: 20 }]);
    if (doc) { doc.entry.held = true; log("story: Spice Garden invoice", doc.transactionNo, doc.totalAmount, "dated", day(-48)); }
  });

  // 5. Coral Bay owes about 56,000 against a credit limit of 60,000 (the limit is set in "finish").
  on(-22, async (d) => { await T.ensure(d, [{ sku: "RIC-BAS-40", qty: 100 }, { sku: "SUG-WHT-50", qty: 90 }, { sku: "OIL-SUN-18", qty: 60 }, { sku: "FLR-APF-50", qty: 40 }]); });
  on(-20, async (d) => {
    const doc = await T.sell(d, "coral", [{ sku: "RIC-BAS-40", qty: 100 }, { sku: "SUG-WHT-50", qty: 90 }, { sku: "OIL-SUN-18", qty: 60 }, { sku: "FLR-APF-50", qty: 40 }]);
    if (doc) { doc.entry.held = true; log("story: Coral Bay invoice", doc.transactionNo, doc.totalAmount); }
  });

  // 6. Two customer cheques in hand: Bright Star due in 2 days, Al Reef in 5. Received on account.
  const chequeReceipt = (n, custKey, amount, chequeDay, no) => on(n, async (d) => {
    const r = await api("POST", "/vouchers/vouchers", {
      voucherType: "receipt", customerId: I.customer[custKey], totalAmount: amount, date: iso(d), paymentMode: "cheque",
      narration: "Post-dated cheque received",
      paymentDetails: { chequeNo: no, chequeDate: chequeDay, accountId: I.BANK.enbd, drawnOnBankName: "Dubai Islamic Bank" },
    });
    if (!r.ok) T.failed.push(`cheque from ${custKey}: ${r.status} ${r.code} ${r.message}`); else log("story: cheque", no, amount, "due", chequeDay);
  });
  chequeReceipt(-6, "star", 18450, day(2), "480221");
  chequeReceipt(-4, "reef", 24300, day(5), "480222");

  // 9. A purchase order to Gulf Grain, confirmed 4 days ago, goods not yet received.
  on(-4, async (d) => {
    const r = await api("POST", "/trade-orders", {
      kind: "purchase", partyId: I.vendor.gg, date: iso(d), reference: "Weekly rice order",
      items: [lineOf("RIC-BAS-05", 150, 25.5), lineOf("RIC-WHT-25", 60, 70)],
    });
    if (!r.ok) { T.failed.push(`purchase order: ${r.status} ${r.code} ${r.message}`); return; }
    const c = await api("POST", `/trade-orders/${rec(r)._id}/confirm`, {});
    if (!c.ok) T.failed.push(`confirm purchase order: ${c.status} ${c.code} ${c.message}`); else log("story: purchase order", rec(r).orderNo);
  });

  // 1. Royal Feast quotation, sent 3 days ago, valid for 14 days.
  on(-3, async (d) => {
    await T.ensure(d, [{ sku: "RIC-BAS-40", qty: 40 }, { sku: "OIL-SUN-18", qty: 20 }]);
    const q = await api("POST", "/quotations", {
      partyId: I.customer.feast, date: iso(d), validUntil: day(11), reference: "Weekly supply enquiry",
      terms: "Prices valid for the period shown; payment Net 45; delivery ex-warehouse", notes: "",
      items: [lineOf("RIC-BAS-40", 40), lineOf("OIL-SUN-18", 20)],
    });
    if (!q.ok) { T.failed.push(`quotation: ${q.status} ${q.code} ${q.message}`); return; }
    const s = await api("POST", `/quotations/${rec(q)._id}/send`, {});
    if (!s.ok) T.failed.push(`send quotation: ${s.status} ${s.code} ${s.message}`); else log("story: quotation", rec(q).quotationNo || rec(q)._id, "sent");
  });

  // 2. Al Madina: an order confirmed 2 days ago, delivered yesterday and signed for by Khalid, not invoiced.
  on(-3, async (d) => { await T.ensure(d, [{ sku: "RIC-BAS-05", qty: 100 }, { sku: "SUG-WHT-10", qty: 60 }, { sku: "OIL-SUN-15", qty: 40 }]); });
  let madinaOrder = null;
  on(-2, async (d) => {
    const r = await api("POST", "/trade-orders", {
      kind: "sales", partyId: I.customer.madina, date: iso(d), reference: "LPO-7714",
      items: [lineOf("RIC-BAS-05", 100), lineOf("SUG-WHT-10", 60), lineOf("OIL-SUN-15", 40)],
    });
    if (!r.ok) { T.failed.push(`sales order: ${r.status} ${r.code} ${r.message}`); return; }
    madinaOrder = rec(r);
    const c = await api("POST", `/trade-orders/${madinaOrder._id}/confirm`, {});
    if (!c.ok) T.failed.push(`confirm sales order: ${c.status} ${c.code} ${c.message}`);
  });
  on(-1, async (d) => {
    if (!madinaOrder) return;
    const full = await api("GET", `/trade-orders/${madinaOrder._id}`);
    const order = rec(full) || full.body;
    const items = (order?.items || []).map((l) => ({ sourceLineId: l._id, qty: l.qty }));
    const dn = await api("POST", "/delivery-notes", { sourceTradeOrderId: madinaOrder._id, date: iso(d), items });
    if (!dn.ok) { T.failed.push(`delivery note: ${dn.status} ${dn.code} ${dn.message}`); return; }
    const id = rec(dn)._id;
    const dis = await api("POST", `/delivery-notes/${id}/dispatch`, { vehicleNo: "DXB A 4417", driverName: "Raju" });
    const del = await api("POST", `/delivery-notes/${id}/deliver`, { receivedBy: "Khalid Al Nuaimi", proofNote: "Signed copy on file" });
    if (!dis.ok || !del.ok) T.failed.push(`deliver note: ${(dis.ok ? del : dis).status} ${(dis.ok ? del : dis).code} ${(dis.ok ? del : dis).message}`);
    else log("story: delivery note delivered, not invoiced");
  });

  // 10. Basmati 5kg pushed below its reorder level (150) by a sale to Al Reef.
  on(-1, async (d) => {
    const it = T.itemBy["RIC-BAS-05"];
    const sell = T.stock["RIC-BAS-05"] - Math.floor(it.reorder * 0.6);
    if (sell > 0) await T.sell(d, "reef", [{ sku: "RIC-BAS-05", qty: sell }]);
    log("story: RIC-BAS-05 stock now", T.stock["RIC-BAS-05"], "reorder level", it.reorder);
  });

  // 4. A large invoice waiting for a second approver: prepared by Ravi, first approval by Fatima.
  on(-2, async () => {
    const r = await api("PUT", "/accounting/settings", { approvals: { separateApprover: false, secondApprovalAbove: 50000 } });
    if (!r.ok) T.failed.push(`approval policy: ${r.status} ${r.code} ${r.message}`);
  });
  on(-1, async (d) => {
    await T.ensure(d, [{ sku: "RIC-BAS-40", qty: 200 }, { sku: "SUG-WHT-50", qty: 80 }]);
    const draft = await T.sell(d, "basket", [{ sku: "RIC-BAS-40", qty: 200 }, { sku: "SUG-WHT-50", qty: 80 }], { approveIt: false, as: ravi() });
    if (!draft) return;
    const a = await fatima()("PATCH", `/transactions/transactions/${draft._id}/process`, { action: "approve" });
    if (!a.ok) T.failed.push(`first approval: ${a.status} ${a.code} ${a.message}`);
    else log("story: Green Basket invoice", draft.transactionNo, draft.totalAmount, "first approval by Fatima:", JSON.stringify(a.body?.approval || {}));
  });

  return map;
}

// The end-state check of the story: what the script relies on is really there.
async function story(ctx) {
  const { api, log } = ctx;
  const out = {};
  out.cheques = listOf(await api("GET", "/banking/cheques")).filter((c) => c.status === "PENDING" || c.status === "pending" || !c.status).length;
  out.waiting = (await api("GET", "/approvals/waiting")).body;
  log("story check:", JSON.stringify({ chequesListed: out.cheques, waiting: out.waiting?.forYou?.length ?? out.waiting }));
}

module.exports = { hooks, story };
