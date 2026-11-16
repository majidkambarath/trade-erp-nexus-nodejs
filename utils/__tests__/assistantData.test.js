const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../assistantData");

test("a period word becomes two days in the organisation's calendar, never past today", () => {
  assert.deepEqual(d.periodOf("today", "2026-11-16"), { key: "today", from: "2026-11-16", to: "2026-11-16", label: "today" });
  assert.equal(d.periodOf("yesterday", "2026-01-01").from, "2025-12-31");
  // 16 Nov 2026 is a Monday
  assert.deepEqual([d.periodOf("this_week", "2026-11-18").from, d.periodOf("this_week", "2026-11-18").to], ["2026-11-16", "2026-11-18"]);
  assert.deepEqual([d.periodOf("last_week", "2026-11-18").from, d.periodOf("last_week", "2026-11-18").to], ["2026-11-09", "2026-11-15"]);
  const m = d.periodOf("this_month", "2026-11-16");
  assert.deepEqual([m.from, m.to], ["2026-11-01", "2026-11-16"], "this month stops at today");
  const lm = d.periodOf("last_month", "2026-01-10");
  assert.deepEqual([lm.from, lm.to, lm.label], ["2025-12-01", "2025-12-31", "Dec 2025"], "January's last month is last year's December");
  const lq = d.periodOf("last_quarter", "2026-02-10");
  assert.deepEqual([lq.from, lq.to], ["2025-10-01", "2025-12-31"], "Q1's last quarter is last year's Q4");
  assert.deepEqual([d.periodOf("this_year", "2026-11-16").from, d.periodOf("this_year", "2026-11-16").to], ["2026-01-01", "2026-11-16"]);
  assert.equal(d.periodOf("last_year", "2026-11-16").to, "2025-12-31");
  assert.equal(d.periodOf("next fortnight", "2026-11-16").key, "this_month", "an unknown word is this month");
  assert.equal(d.periodOf("last_month", "2024-03-15").to, "2024-02-29", "a leap February ends on the 29th");
});

const bill = (partyId, partyName, outstanding, daysPastDue = 0, extra = {}) => ({ partyId, partyName, outstanding, daysPastDue, daysToDue: daysPastDue ? 0 : 5, date: "2026-10-01", ...extra });

test("open bills are grouped by party, largest first, with what is overdue", () => {
  const g = d.groupOpen([bill("a", "Alpha", 100), bill("b", "Beta", 50, 3), bill("a", "Alpha", 25.5, 40), bill("c", "Cee", 125.5)]);
  assert.deepEqual(g.map((x) => x.name), ["Alpha", "Cee", "Beta"], "125.50 ties: by name");
  assert.deepEqual(g[0], { partyId: "a", name: "Alpha", count: 2, outstanding: 125.5, overdue: 25.5, overdueCount: 1, oldestDays: 40 });
});

test("the unpaid list says the total and what is past due, and the table carries the same figures", () => {
  const out = d.unpaidSummary([bill("a", "Alpha", 100), bill("b", "Beta", 50, 3)], { side: "payable", currency: "AED" });
  assert.equal(out.reply, "2 vendors are unpaid: AED 150.00 on 2 bills, of which AED 50.00 is past due.");
  assert.equal(out.table.title, "Unpaid vendors");
  assert.deepEqual(out.table.rows.map((r) => [r.label, r.value, r.tone]), [["Alpha", "AED 100.00", ""], ["Beta", "AED 50.00", "danger"]]);
  assert.deepEqual(out.table.total, { label: "Total", value: "AED 150.00" });
  assert.equal(out.table.link.path, "/ageing?type=payable");

  const overdue = d.unpaidSummary([bill("a", "Alpha", 100), bill("b", "Beta", 50, 3)], { side: "receivable", currency: "AED", overdueOnly: true });
  assert.deepEqual(overdue.table.rows.map((r) => r.label), ["Beta"], "overdue only keeps the ones past due");
  assert.match(overdue.reply, /^1 customer owes you AED 50\.00 that is past due/);

  assert.deepEqual(d.unpaidSummary([], { side: "payable" }), { reply: "No vendors are unpaid: there are no open approved bills.", table: null });
  const many = Array.from({ length: 20 }, (_, i) => bill(`p${i}`, `P${String(i).padStart(2, "0")}`, 10));
  const big = d.unpaidSummary(many, { side: "payable" });
  assert.equal(big.table.rows.length, d.MAX_ROWS);
  assert.equal(big.table.more, 5);
  assert.equal(big.table.total.value, "200.00", "the total is of ALL of them, not the rows shown");
});

test("one party's open documents, oldest first", () => {
  const out = d.partyUnpaid([bill("a", "Alpha", 40, 0, { transactionNo: "PO-2", date: "2026-11-01" }), bill("a", "Alpha", 60, 12, { transactionNo: "PO-1", date: "2026-09-01" })], { side: "payable", name: "Alpha", currency: "AED" });
  assert.equal(out.reply, "You owe Alpha AED 100.00 on 2 bills, AED 60.00 of it past due.");
  assert.deepEqual(out.table.rows.map((r) => r.label), ["PO-1", "PO-2"]);
  assert.match(out.table.rows[0].sub, /12 days overdue/);
  assert.equal(d.partyUnpaid([], { side: "receivable", name: "Harbour" }).reply, "Harbour has no unpaid invoices. Nothing is open.");
});

test("stock: low items, one item, and services left out", () => {
  const items = [
    { itemName: "Rice", currentStock: 3, reorderLevel: 10, sku: "R1" },
    { itemName: "Oil", currentStock: 50, reorderLevel: 10 },
    { itemName: "Delivery", currentStock: 0, reorderLevel: 0, itemType: "service" },
  ];
  const lowOut = d.stockTable(items, { lowOnly: true });
  assert.equal(lowOut.reply, "1 item is at or below the reorder level.");
  assert.deepEqual(lowOut.table.rows.map((r) => [r.label, r.value, r.tone]), [["Rice", "3", "danger"]]);
  assert.equal(d.stockTable([items[1]]).reply, "Oil: 50 on hand.");
  assert.equal(d.stockTable([items[0]]).reply, "Rice: 3 on hand, which is at or below its reorder level of 10.");
  assert.equal(d.stockTable([items[2]], { search: "delivery" }).reply, 'I could not find a stocked item called "delivery".');
  assert.equal(d.stockTable([items[1]], { lowOnly: true }).table, null);
});

test("cash and bank: every account, the total, an overdraft in red", () => {
  const out = d.cashTable({ cashAccounts: [{ accountName: "Petty cash", balance: 500 }], bankAccounts: [{ accountName: "ENBD", balance: 12000.5 }, { accountName: "ADCB", balance: -200 }] }, "AED");
  assert.equal(out.reply, "You have AED 12,300.50 across 3 cash and bank accounts: AED 11,800.50 in the bank and AED 500.00 in cash.");
  assert.deepEqual(out.table.rows.map((r) => [r.label, r.sub, r.tone]), [["ENBD", "Bank", ""], ["ADCB", "Bank", "danger"], ["Petty cash", "Cash", ""]]);
  assert.equal(d.cashTable({}).table, null);
});

test("sales and purchases for a period, from the trade report's own totals", () => {
  const period = d.periodOf("this_month", "2026-11-16");
  const summary = { rows: [{ partyName: "Harbour", documents: 2, net: 800, sharePct: 80 }, { partyName: "Bay", documents: 1, net: 200, sharePct: 20 }], totals: { net: 1000, total: 1050, documents: 3, parties: 2, returns: 0 } };
  const out = d.tradeTable(summary, { direction: "sales", period, currency: "AED" });
  assert.equal(out.reply, "Sales for this month (Nov 2026): AED 1,000.00 before tax (AED 1,050.00 with tax) on 3 invoices from 2 customers.");
  assert.equal(out.table.title, "Sales, 1 Nov 2026 to 16 Nov 2026");
  assert.equal(out.table.total.value, "AED 1,000.00");
  assert.equal(d.tradeTable({ rows: [], totals: {} }, { direction: "purchases", period }).reply, "No purchases were approved for this month (Nov 2026).");
});

test("a question about the person's own figures is told from a how-to question", () => {
  for (const q of ["list unpaid vendors", "Unpaid vendors", "how much do we owe Al Noor", "what is low in stock", "sales this month", "show bank balance", "who owes us money"]) {
    assert.equal(d.looksLikeLookup(q), true, q);
  }
  for (const q of ["how do I pay a vendor", "how to add stock", "explain the balance sheet", "where do I see the bank", "hi", ""]) {
    assert.equal(d.looksLikeLookup(q), false, q);
  }
});

test("profit and loss: headline tiles, the statement's lines, a loss said as a loss, an empty period said plainly", () => {
  const period = d.periodOf("this_month", "2026-11-16");
  const pl = { revenue: { total: 1000 }, directCosts: { total: 400 }, grossProfit: 600, grossMargin: 60, otherIncome: { total: 20 }, operatingExpenses: { total: 150 }, netProfit: 470 };
  const out = d.profitTable(pl, { period, currency: "AED" });
  assert.equal(out.reply, "For this month (Nov 2026) you have a profit of AED 470.00: revenue AED 1,000.00, gross profit AED 600.00 (60% margin).");
  assert.deepEqual(out.table.stats.map((s) => [s.label, s.value, s.tone]), [["Net profit", "AED 470.00", "good"], ["Revenue", "AED 1,000.00", ""], ["Gross margin", "60%", ""]]);
  assert.deepEqual(out.table.rows.map((r) => r.label), ["Revenue", "Direct costs", "Gross profit", "Other income", "Operating expenses", "Net profit"]);
  assert.equal(out.table.link.path, "/financial-statements");

  const loss = d.profitTable({ ...pl, netProfit: -80, grossProfit: 50, grossMargin: 5 }, { period, currency: "AED" });
  assert.match(loss.reply, /a loss of AED 80\.00/);
  assert.deepEqual([loss.table.stats[0].label, loss.table.stats[0].value, loss.table.stats[0].tone], ["Net loss", "AED 80.00", "danger"], "a loss says the word, so colour is not the only signal");
  assert.equal(loss.table.rows.at(-1).value, "-AED 80.00");

  assert.match(d.profitTable({ revenue: { total: 0 }, directCosts: { total: 0 }, operatingExpenses: { total: 0 }, otherIncome: { total: 0 }, netProfit: 0 }, { period }).reply, /nothing in the books for this month/);
});

test("balance sheet: what is owned, owed and left to the owners, and whether it balances", () => {
  const sec = (a, n, c) => ({ amount: a, nonCurrent: { amount: n }, current: { amount: c } });
  const bs = { totalAssets: 1500, totalLiabilities: 600, totalEquity: 900, totalLiabilitiesAndEquity: 1500, isBalanced: true, sections: { assets: sec(1500, 500, 1000), liabilities: sec(600, 100, 500), equity: { amount: 900 } } };
  const out = d.balanceTable(bs, { asOn: "2026-11-16", currency: "AED" });
  assert.equal(out.reply, "As at 16 Nov 2026 you own AED 1,500.00, owe AED 600.00 and the owners' equity is AED 900.00.");
  assert.deepEqual(out.table.rows.map((r) => [r.label, r.value]), [["Non-current assets", "AED 500.00"], ["Current assets", "AED 1,000.00"], ["Non-current liabilities", "AED 100.00"], ["Current liabilities", "AED 500.00"], ["Equity", "AED 900.00"]]);
  assert.equal(out.table.total.value, "AED 1,500.00");
  assert.match(d.balanceTable({ ...bs, isBalanced: false }, { asOn: "2026-11-16" }).reply, /does not balance/);
  assert.match(d.balanceTable({ sections: { assets: sec(0, 0, 0), liabilities: sec(0, 0, 0), equity: { amount: 0 } } }, { asOn: "2026-11-16" }).reply, /balance sheet is empty/);
});

test("the whole position in one look", () => {
  const out = d.snapshotTable({ cash: 5000, receivable: 1200, payable: 800, overdueReceivable: 200, overduePayable: 0, profit: -50, period: d.periodOf("this_month", "2026-11-16") }, "AED");
  assert.equal(out.reply, "You have AED 5,000.00 in cash and bank, customers owe you AED 1,200.00 and you owe vendors AED 800.00. For this month (Nov 2026) you are at a loss of AED 50.00.");
  assert.deepEqual(out.table.rows.map((r) => [r.label, r.tone]), [["Cash and bank", ""], ["Customers owe you", "danger"], ["You owe vendors", ""], ["Loss, this month (Nov 2026)", "danger"]]);
});

test("stock alerts: out, low and expiring in one table, and nothing to report said plainly", () => {
  const reorder = { rows: [{ itemName: "Rice", status: "out", qty: 0, reorderLevel: 10, vendorName: "Gulf" }, { itemName: "Oil", status: "below", qty: 3, reorderLevel: 10, vendorName: "" }] };
  const expiry = { rows: [{ itemName: "Milk", batchNumber: "B1", daysToExpiry: 5, expired: false, qtyOnHand: 20 }, { itemName: "Yogurt", batchNumber: "B2", daysToExpiry: -2, expired: true, qtyOnHand: 4 }] };
  const out = d.stockAlertsTable(reorder, expiry, { days: 30 });
  assert.equal(out.reply, "2 items are at or below the reorder level (1 out of stock), and 2 batches expired or will expire within 30 days.");
  assert.deepEqual(out.table.stats.map((s) => s.value), ["1", "1", "2"]);
  assert.match(out.table.rows[0].sub, /Out of stock · reorder at 10 · Gulf/);
  assert.match(out.table.rows[3].sub, /expired 2 days ago/);
  assert.match(d.stockAlertsTable({ rows: [] }, { rows: [] }).reply, /^Nothing needs attention/);
});

test("the position questions are lookups, and the how-to ones are not", () => {
  for (const q of ["profit this month", "show balance sheet", "how are we doing", "stock alerts", "what is expiring"]) assert.equal(d.looksLikeLookup(q), true, q);
  assert.equal(d.looksLikeLookup("how do I read the balance sheet"), false);
});
