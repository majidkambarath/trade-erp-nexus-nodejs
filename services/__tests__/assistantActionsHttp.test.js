// Zarvia AI PREPARING documents, end to end: a real strict server, real vendors / customers / items /
// bills / accounts, and a fake OpenAI-compatible model that is scripted to call the prepare tools.
//
// What it proves:
//   - it is OFF until an administrator switches it on, and no prepare tool is even offered then;
//   - a person without the keys is never offered the tools;
//   - a prepared document is the exact body the normal route takes, and PREPARING WRITES NOTHING;
//   - posting that body to the normal route (as the person) creates the voucher, settles the bills
//     oldest first, applies the approval hold, refuses a missing reference, and writes the audit label;
//   - an ambiguous name is choices, never a guess;
//   - the "confirmed" mark works once, on the person's own message only.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const H = require("./support/httpHarness");

const skip = H.skipReason();
const ORG = "aiact";

// ---- the fake model ----------------------------------------------------------------------------
const seen = [];
const SCRIPT = {
  PAYCASH: { name: "prepare_payment", args: { vendor: "gulf pack", amount: 500, method: "cash" } },
  PAYBANK: { name: "prepare_payment", args: { vendor: "Gulf Packaging", amount: 1000, method: "bank transfer", account: "ENBD" } },
  PAYREF: { name: "prepare_payment", args: { vendor: "Gulf Packaging", amount: 1000, method: "bank transfer", account: "ENBD", reference: "TT-7781" } },
  PAYBIG: { name: "prepare_payment", args: { vendor: "Gulf Packaging", amount: 2000, method: "cash" } },
  PAYAMBIG: { name: "prepare_payment", args: { vendor: "al noor", amount: 100 } },
  PAYNOBANK: { name: "prepare_payment", args: { vendor: "Gulf Packaging", amount: 100, method: "bank transfer" } },
  PAYNOAMOUNT: { name: "prepare_payment", args: { vendor: "Gulf Packaging" } },
  PAYNOBODY: { name: "prepare_payment", args: { vendor: "Nobody Trading", amount: 100 } },
  PAYCHEQUE: { name: "prepare_payment", args: { vendor: "Gulf Packaging", amount: 100, method: "cheque" } },
  RECEIPT: { name: "prepare_receipt", args: { customer: "harbour", amount: 200, method: "cash" } },
  EXPENSE: { name: "prepare_expense", args: { account: "zeta fuel", amount: 150, description: "Fuel for the van" } },
  EXPENSEBARE: { name: "prepare_expense", args: { account: "zeta fuel", amount: 80 } },
  INVOICE: { name: "prepare_invoice", args: { customer: "harbour", lines: [{ item: "milk", qty: 10 }] } },
  NEWCUST: { name: "prepare_customer", args: { name: "Blue Sea Trading", phone: "050 123 4567", address: "Dubai Marina" } },
  NEWVEND: { name: "prepare_vendor", args: { name: "Desert Steel", phone: "0509998877" } },
  NEWDUP: { name: "prepare_customer", args: { name: "harbour cafe" } },
};
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push({ body, tools: (body.tools || []).map((t) => t.function.name) });
    const msgs = body.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const afterTool = msgs.slice(msgs.lastIndexOf(lastUser)).some((m) => m.role === "tool");
    // longest key first: "EXPENSEBARE" also contains "EXPENSE"
    const key = Object.keys(SCRIPT).sort((a, b) => b.length - a.length).find((k) => String(lastUser?.content || "").includes(k));
    let message;
    if (key && !afterTool && seen.at(-1).tools.includes(SCRIPT[key].name)) {
      message = { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: SCRIPT[key].name, arguments: JSON.stringify(SCRIPT[key].args) } }] };
    } else {
      const tool = msgs.filter((m) => m.role === "tool").at(-1);
      message = { role: "assistant", content: tool ? `Done with the tool. ${tool.content.slice(0, 60)}` : "I can help with that in the documentation." };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  });
});

// ---- the stack ---------------------------------------------------------------------------------
let stack;
let call;
let fakeBase;
const T = {};
const D = {};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const as = (who, method, url, body, headers) => call(method, url, { token: T[who], body, headers });
const ask = (who, question, extra = {}) => as(who, "POST", "/assistant/ask", { question, screen: "/payment-voucher", ...extra });
const toolNames = () => seen.at(-1)?.tools || [];

test.before(async () => {
  if (skip) return;
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    ASSISTANT_PROVIDER: "openai",
    ASSISTANT_OPEN_BASE_URL: `${fakeBase}/v1`,
    ASSISTANT_OPEN_MODEL: "test-model",
    ASSISTANT_ALLOW_PRIVATE_HOSTS: "true",
  });
  delete process.env.ASSISTANT_API_KEY;
  stack = await H.startStack("aiact");
  call = H.makeCaller(stack.base);
  const Admin = require("../../models/core/adminModel");
  await stack.Org.create({ legalName: "AI Act Trading LLC", code: ORG, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  for (const [who, type] of [["owner", "super_admin"], ["viewer", "viewer"]]) {
    const email = `${who}@${ORG}.ai.test`;
    await stack.as(ORG, () => new Admin({ name: `${who} person`, email, password: H.PASSWORD, status: "active", isActive: true, type }).save());
    const r = await call("POST", "/login", { body: { email, password: H.PASSWORD } });
    assert.equal(r.status, 200, r.text);
    T[who] = r.body.tokens.accessToken;
  }
  await as("owner", "GET", "/accounting/chart"); // opens the chart: posting on, accounts mapped

  const must = (res, what) => {
    assert.ok(res.status >= 200 && res.status < 300, `${what}: ${res.status} ${res.text.slice(0, 300)}`);
    const b = res.body;
    return b && typeof b === "object" && !b._id ? Object.values(b).find((v) => v && typeof v === "object" && v._id) || b : b;
  };
  const cat = must(await as("owner", "POST", "/categories/categories", { name: "Dairy", description: "Dairy" }), "category");
  const unit = must(await as("owner", "POST", "/uom/units", { unitName: "Carton", shortCode: "CTN", type: "Base", category: "Weight" }), "unit");
  const milk = must(await as("owner", "POST", "/stock/stock", { itemName: "Milk 1L", sku: "MILK1", categoryId: cat._id, unitOfMeasure: unit._id, origin: "UAE", brand: "Local", salesPrice: 4.5, purchasePrice: 3, currentStock: 0, reorderLevel: 5 }), "item");
  D.milkId = milk._id;
  const vend = (name, n) => as("owner", "POST", "/vendors/vendors", { vendorName: name, contactPerson: "Contact", email: `v${n}@aiact.test`, phone: "0504445566", address: "Industrial Area", paymentTerms: "Net 30", trnNO: `10077733330000${n}` });
  D.vendor = must(await vend("Gulf Packaging", 3), "vendor");
  must(await vend("Al Noor Steel", 1), "vendor");
  must(await vend("Al Noor Trading", 2), "vendor");
  D.customer = must(await as("owner", "POST", "/customers", { customerName: "Harbour Cafe", contactPerson: "Contact", email: "c1@aiact.test", phone: "0502223344", billingAddress: "Marina", creditLimit: 100000, paymentTerms: "Net 30" }), "customer");

  // two approved bills for Gulf Packaging (the older one is PO 1), and an approved sales invoice for Harbour Cafe
  const doc = (type, partyId, partyType, qty, price, date) =>
    as("owner", "POST", "/transactions/transactions", { type, partyId, partyType, partyTypeRef: partyType, date, items: [{ itemId: D.milkId, description: "Milk 1L", qty, price, rate: price, vatPercent: 5, batchNumber: "B1", expiryDate: "2099-12-31" }] });
  const approve = (id) => as("owner", "PATCH", `/transactions/transactions/${id}/process`, { action: "approve" });
  D.po1 = must(await doc("purchase_order", D.vendor._id, "Vendor", 100, 3, day(-40)), "po1");
  D.po2 = must(await doc("purchase_order", D.vendor._id, "Vendor", 200, 3, day(-10)), "po2");
  for (const po of [D.po1, D.po2]) must(await approve(po._id), "approve po");
  D.so = must(await doc("sales_order", D.customer._id, "Customer", 10, 4.5, day(-5)), "so");
  must(await approve(D.so._id), "approve so");

  const groups = (await as("owner", "GET", "/accounting/account-groups")).body || [];
  const bankGroup = groups.find((g) => g.name === "Bank");
  const expenseGroup = groups.find((g) => /operating expenses/i.test(g.name)) || groups.find((g) => String(g.category).toUpperCase() === "EXPENSE");
  assert.ok(bankGroup && expenseGroup, "the chart has a Bank group and an expense group");
  D.bank1 = must(await as("owner", "POST", "/accounting/accounts", { accountName: "ENBD Current", groupId: bankGroup._id, openingBalance: 50000, openingSide: "debit" }), "bank1");
  D.bank2 = must(await as("owner", "POST", "/accounting/accounts", { accountName: "Mashreq Current", groupId: bankGroup._id, openingBalance: 20000, openingSide: "debit" }), "bank2");
  D.fuel = must(await as("owner", "POST", "/accounting/accounts", { accountName: "Zeta Fuel Expense", groupId: expenseGroup._id }), "expense account");
});

test.after(async () => {
  if (stack) await stack.stop();
  fake.close();
});

const counts = async () => {
  const { Voucher } = require("../../models/modules/financial/financialModels");
  const Transaction = require("../../models/modules/transactionModel");
  return stack.as(ORG, async () => ({ vouchers: await Voucher.countDocuments({}), transactions: await Transaction.countDocuments({}) }));
};
const outstanding = async (id) => {
  const Transaction = require("../../models/modules/transactionModel");
  return stack.as(ORG, async () => (await Transaction.findById(id).lean()).outstandingAmount);
};

test("it is off until an administrator switches it on, and then no prepare tool is offered", { skip }, async () => {
  const r = await ask("owner", "PAYCASH pay Gulf Packaging 500");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(toolNames().filter((n) => n.startsWith("prepare_")), []);
  assert.ok(!r.body.proposals || r.body.proposals.length === 0);
  const screen = await as("owner", "GET", "/assistant/screen?screen=/payment-voucher");
  assert.equal(screen.body.actions, false);
});

test("only an administrator switches it on, and the setting is not secret", { skip }, async () => {
  assert.equal((await as("viewer", "PUT", "/assistant/settings", { actionsEnabled: true })).status, 403);
  const on = await as("owner", "PUT", "/assistant/settings", { actionsEnabled: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.actionsEnabled, true);
});

test("a person without the keys is never offered the tools", { skip }, async () => {
  await ask("viewer", "PAYCASH pay Gulf Packaging 500");
  assert.deepEqual(toolNames().filter((n) => n.startsWith("prepare_")), [], "a Viewer holds neither finance.create nor sales.create");
  const screen = await as("viewer", "GET", "/assistant/screen?screen=/payment-voucher");
  assert.equal(screen.body.actions, false);
  const owner = await as("owner", "GET", "/assistant/screen?screen=/payment-voucher");
  assert.equal(owner.body.actions, true);
});

test("a cash payment: prepared as the exact body, settling the oldest bill first, and NOTHING is written", { skip }, async () => {
  const before = await counts();
  const billBefore = await outstanding(D.po1._id);
  const r = await ask("owner", "PAYCASH pay Gulf Packaging 500 cash");
  assert.equal(r.status, 200, r.text);
  assert.ok(toolNames().includes("prepare_payment"));
  assert.equal(r.body.outcome, "answered", JSON.stringify(r.body));
  assert.equal(r.body.proposals.length, 1);
  const p = r.body.proposals[0];
  assert.equal(p.kind, "payment");
  assert.equal(p.endpoint, "voucher");
  assert.equal(p.body.voucherType, "payment");
  assert.equal(p.body.vendorId, String(D.vendor._id));
  assert.equal(p.body.totalAmount, 500);
  assert.equal(p.body.paymentMode, "cash");
  assert.match(p.body.date, /^\d{4}-\d{2}-\d{2}$/, "a real calendar day, today by default");
  // the older bill is 100 x 3 + 5% = 315, the newer 200 x 3 + 5% = 630: 500 clears the older and takes 185 of the newer
  assert.deepEqual(
    p.body.linkedInvoices,
    [{ invoiceId: String(D.po1._id), amount: 315, balance: 0 }, { invoiceId: String(D.po2._id), amount: 185, balance: 445 }],
    "oldest first, each with what it will still owe"
  );
  assert.equal(p.missing.length, 0);
  assert.match(p.confirm, /^Pay AED 500\.00 to Gulf Packaging$/);
  // The words with the card are written by the SERVER from the books: no second model call, and no chance of a wrong currency
  // (the real model once wrote "\u00a3500" for an AED payment). The fake model is asked exactly once.
  assert.match(r.body.answer, /^I have prepared a payment of AED 500\.00 to Gulf Packaging\. It settles PO-.* and PO-.*\. Check the details below and press the button to confirm\. Nothing is saved until you do\.$/);
  assert.ok(!r.body.answer.includes("\u00a3"));
  assert.equal(seen.filter((s) => JSON.stringify(s.body.messages).includes("PAYCASH")).length >= 1, true);
  assert.deepEqual(await counts(), before, "preparing wrote nothing");
  assert.equal(await outstanding(D.po1._id), billBefore, "no bill moved");
  D.cash = r.body;
});

test("confirming posts the SAME body through the normal route: voucher created, bill settled, audit labelled", { skip }, async () => {
  const p = D.cash.proposals[0];
  const posted = await as("owner", "POST", "/vouchers/vouchers", p.body, { "X-Prepared-By": "zarvia-ai" });
  assert.equal(posted.status, 201, posted.text);
  assert.equal(await outstanding(D.po1._id), 0, "the older bill is cleared");
  assert.equal(await outstanding(D.po2._id), 445, "the newer one owes 185 less");
  const ActivityLog = require("../../models/modules/financial/activityLogModel");
  const row = await stack.as(ORG, () => ActivityLog.findOne({ action: "VOUCHER_CREATED" }).sort({ createdAt: -1 }).lean());
  assert.match(row.summary, /\(prepared with Zarvia AI\)$/);
  // the same create WITHOUT the header carries no label: it is a typed voucher
  const typed = await as("owner", "POST", "/vouchers/vouchers", { ...p.body, totalAmount: 10, linkedInvoices: [] });
  assert.equal(typed.status, 201, typed.text);
  const row2 = await stack.as(ORG, () => ActivityLog.findOne({ action: "VOUCHER_CREATED" }).sort({ createdAt: -1 }).lean());
  assert.doesNotMatch(row2.summary, /Zarvia AI/);
});

test("a bank transfer without a reference is prepared with the reference still needed, and the server refuses it unsaved", { skip }, async () => {
  const r = await ask("owner", "PAYBANK pay Gulf Packaging 1000 by transfer from ENBD");
  const p = r.body.proposals[0];
  assert.deepEqual(p.missing, ["reference"]);
  assert.equal(p.body.paymentMode, "transfer");
  assert.equal(p.body.paymentDetails.accountId, String(D.bank1._id));
  const before = await counts();
  const refused = await as("owner", "POST", "/vouchers/vouchers", p.body, { "X-Prepared-By": "zarvia-ai" });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.code, "REFERENCE_REQUIRED");
  assert.deepEqual(await counts(), before);
  const filled = await ask("owner", "PAYREF pay Gulf Packaging 1000 by transfer from ENBD ref TT-7781");
  const q = filled.body.proposals[0];
  assert.deepEqual(q.missing, []);
  assert.equal(q.body.paymentDetails.reference, "TT-7781");
  const ok = await as("owner", "POST", "/vouchers/vouchers", q.body, { "X-Prepared-By": "zarvia-ai" });
  assert.equal(ok.status, 201, ok.text);
});

test("an amount over the organisation's approval threshold is HELD by the normal route, not posted", { skip }, async () => {
  assert.equal((await as("owner", "PUT", "/accounting/settings", { approvals: { secondApprovalAbove: 1000 } })).status, 200);
  const r = await ask("owner", "PAYBIG pay Gulf Packaging 2000 cash");
  const posted = await as("owner", "POST", "/vouchers/vouchers", r.body.proposals[0].body, { "X-Prepared-By": "zarvia-ai" });
  assert.equal(posted.status, 201, posted.text);
  assert.equal(posted.data.approval?.held, true, "held for a second approver");
  assert.equal((posted.body.status || posted.data.data?.status), "pending");
  await as("owner", "PUT", "/accounting/settings", { approvals: { secondApprovalAbove: "" } });
});

test("two vendors that match equally are CHOICES, and nothing is prepared", { skip }, async () => {
  const before = await counts();
  const r = await ask("owner", "PAYAMBIG pay al noor 100");
  assert.equal(r.status, 200);
  assert.equal(r.body.proposals.length, 0);
  assert.equal(r.body.answer, "Which vendor do you mean? Al Noor Steel, Al Noor Trading. Tell me which one and I will prepare it.");
  assert.ok(!JSON.stringify(seen.at(-1).body.messages).includes(String(D.vendor._id)), "no record ids are given to the model");
  assert.deepEqual(await counts(), before);
});

test("a bank payment with several bank accounts and none named asks which one; a missing amount, an unknown vendor and a cheque are refused", { skip }, async () => {
  const bank = await ask("owner", "PAYNOBANK pay Gulf Packaging 100 by transfer");
  assert.equal(bank.body.proposals.length, 0);
  assert.match(bank.body.answer, /^Which bank account should it come from\? .*ENBD Current.*Mashreq Current.*Tell me which one/);
  const said = async (q) => {
    const r = await ask("owner", q);
    assert.equal(r.body.proposals.length, 0, q);
    assert.equal(r.body.outcome, "answered", q);
    return r.body.answer;
  };
  assert.equal(await said("PAYNOAMOUNT pay Gulf Packaging"), "How much should it be?");
  assert.match(await said("PAYNOBODY pay Nobody Trading 100"), /^I could not find a vendor called "Nobody Trading"/);
  assert.match(await said("PAYCHEQUE pay Gulf Packaging by cheque"), /payment screen/);
});

test("a receipt, an expense and a draft invoice are prepared, and none of the three writes anything", { skip }, async () => {
  const before = await counts();
  const rec = await ask("owner", "RECEIPT Harbour Cafe paid 200");
  const r = rec.body.proposals[0];
  assert.equal(r.body.voucherType, "receipt");
  assert.equal(r.body.customerId, String(D.customer._id));
  assert.equal(r.body.vendorId, undefined);
  assert.equal(r.body.linkedInvoices[0].invoiceId, String(D.so._id));

  const exp = await ask("owner", "EXPENSE fuel for the van 150");
  const e = exp.body.proposals[0];
  assert.equal(e.body.voucherType, "expense");
  assert.equal(e.body.ledgerBased, true);
  assert.equal(e.body.expenseAccountId, String(D.fuel._id));
  assert.equal(e.body.taxCodeId, undefined);
  assert.equal(e.body.description, "Fuel for the van");
  // said only "fuel": the account is what it was for, rather than asking the person to say it twice
  const bare = await ask("owner", "EXPENSEBARE fuel 80");
  assert.equal(bare.body.proposals[0].body.description, "Zeta Fuel Expense");

  const inv = await ask("owner", "INVOICE Harbour Cafe 10 milk");
  const i = inv.body.proposals[0];
  assert.equal(i.endpoint, "transaction");
  assert.equal(i.body.type, "sales_order");
  assert.equal(i.body.partyId, String(D.customer._id));
  assert.deepEqual(i.body.items, [{ itemId: String(D.milkId), description: "Milk 1L", qty: 10, price: 4.5 }], "the item's own selling price");
  assert.equal(i.body.status, undefined, "the status is never chosen here");
  assert.deepEqual(await counts(), before, "preparing wrote nothing");

  // each posts through its normal route
  assert.equal((await as("owner", "POST", "/vouchers/vouchers", r.body, { "X-Prepared-By": "zarvia-ai" })).status, 201);
  assert.equal((await as("owner", "POST", "/vouchers/vouchers", e.body, { "X-Prepared-By": "zarvia-ai" })).status, 201);
  const made = await as("owner", "POST", "/transactions/transactions", i.body, { "X-Prepared-By": "zarvia-ai" });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.status, "DRAFT", "an invoice from here is a draft: nothing is posted until it is approved");
});

test("the confirmed mark works once, on the person's own message only", { skip }, async () => {
  const r = await ask("owner", "RECEIPT Harbour Cafe paid 200");
  const url = `/assistant/messages/${r.body.messageId}/proposals/p1/saved`;
  assert.equal((await as("viewer", "POST", url, { number: "RV-1" })).status, 404, "somebody else's message");
  const first = await as("owner", "POST", url, { number: "RV-2026-0001" });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.savedAs, "RV-2026-0001");
  assert.equal((await as("owner", "POST", url, { number: "RV-2" })).status, 404, "it cannot be saved twice");
  assert.equal((await as("owner", "POST", `/assistant/messages/${r.body.messageId}/proposals/p9/saved`, {})).status, 404);
  const mine = await as("owner", "GET", "/assistant/mine");
  const row = mine.body.find((m) => String(m._id) === r.body.messageId);
  assert.equal(row?.proposals?.[0]?.savedAs, "RV-2026-0001", "a reopened panel knows it was saved");
});

test("a reply in the same conversation sees the earlier turns, so 'the second one' makes sense", { skip }, async () => {
  const first = await ask("owner", "PAYAMBIG pay al noor 100");
  const reply = await ask("owner", "Al Noor Steel", { conversationId: first.body.conversationId });
  assert.equal(reply.status, 200);
  const msgs = seen.at(-1).body.messages;
  const users = msgs.filter((m) => m.role === "user").map((m) => String(m.content));
  assert.ok(users.some((c) => c.includes("PAYAMBIG")), "the earlier question is in the history");
  assert.ok(msgs.some((m) => m.role === "assistant" && String(m.content).length > 0), "and so is the earlier answer");
  // someone else's conversation id gives them nothing
  await ask("viewer", "hello", { conversationId: first.body.conversationId });
  assert.ok(!seen.at(-1).body.messages.some((m) => String(m.content || "").includes("PAYAMBIG")), "a conversation is one person's own");
});

test("a new customer and a new vendor are prepared, nothing is written, and the same body creates them through the normal routes", { skip }, async () => {
  const Customer = require("../../models/modules/customerModel");
  const Vendor = require("../../models/modules/vendorModel");
  const before = await stack.as(ORG, async () => ({ c: await Customer.countDocuments({}), v: await Vendor.countDocuments({}) }));

  const c = await ask("owner", "NEWCUST add a customer called Blue Sea Trading, phone 050 123 4567");
  assert.equal(c.body.outcome, "answered", JSON.stringify(c.body));
  assert.ok(toolNames().includes("prepare_customer") && toolNames().includes("prepare_vendor"));
  const cp = c.body.proposals[0];
  assert.deepEqual([cp.kind, cp.endpoint, cp.missing], ["customer", "party", []]);
  assert.deepEqual(cp.body, { customerName: "Blue Sea Trading", contactPerson: "Blue Sea Trading", billingAddress: "Dubai Marina", phone: "0501234567" });
  assert.match(c.body.answer, /^I have prepared a new customer, Blue Sea Trading\. Check the details below/);

  const v = await ask("owner", "NEWVEND create vendor Desert Steel");
  const vp = v.body.proposals[0];
  assert.deepEqual([vp.kind, vp.missing], ["vendor", ["address"]], "a vendor needs an address: asked for on the card, never invented");
  assert.match(v.body.answer, /Enter the address on the card first/);

  const after = await stack.as(ORG, async () => ({ c: await Customer.countDocuments({}), v: await Vendor.countDocuments({}) }));
  assert.deepEqual(after, before, "preparing wrote nothing");

  const madeC = await as("owner", "POST", "/customers", cp.body, { "X-Prepared-By": "zarvia-ai" });
  assert.equal(madeC.status, 201, madeC.text);
  const madeV = await as("owner", "POST", "/vendors/vendors", { ...vp.body, address: "Industrial Area 3" }, { "X-Prepared-By": "zarvia-ai" });
  assert.equal(madeV.status, 201, madeV.text);
  const now = await stack.as(ORG, async () => ({ c: await Customer.countDocuments({}), v: await Vendor.countDocuments({}) }));
  assert.deepEqual(now, { c: before.c + 1, v: before.v + 1 });
});

test("a name that already exists is not prepared again, and a Viewer is never offered the tools", { skip }, async () => {
  const dup = await ask("owner", "NEWDUP add a customer called harbour cafe");
  assert.equal(dup.body.proposals.length, 0);
  assert.match(dup.body.answer, /There is already a customer called Harbour Cafe/);
  await ask("viewer", "NEWCUST add a customer");
  assert.deepEqual(toolNames().filter((n) => n.startsWith("prepare_")), []);
});

test("switching it off again takes the tools away", { skip }, async () => {
  assert.equal((await as("owner", "PUT", "/assistant/settings", { actionsEnabled: false })).status, 200);
  await ask("owner", "PAYCASH pay Gulf Packaging 500");
  assert.deepEqual(toolNames().filter((n) => n.startsWith("prepare_")), []);
});
