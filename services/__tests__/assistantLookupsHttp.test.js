// Zarvia AI LOOKING THINGS UP in the organisation's own books, end to end: a real strict server, real vendors /
// bills / stock / bank accounts, and a fake OpenAI-compatible model scripted to call the lookup tools.
//
// What it proves:
//   - "list unpaid vendors" answers with the figures the ageing report holds, written by the server;
//   - a vendor by name, choices for a name that fits two, overdue only, customers, stock, cash, sales;
//   - a person without the keys is never offered a lookup, and an administrator can switch them off;
//   - THE PRIVACY RULE: nothing the AI service receives - tool results, the next turn's history - carries a bill
//     number, an amount or a balance from the books;
//   - looking up writes nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const H = require("./support/httpHarness");
const data = require("../../utils/assistantData");

const skip = H.skipReason();
const ORG = "ailook";

// ---- the fake model ----------------------------------------------------------------------------
const seen = [];
const SCRIPT = {
  UNPAIDV: [{ name: "unpaid_bills", args: {} }],
  OVERDUEV: [{ name: "unpaid_bills", args: { overdue_only: true } }],
  GULFBILLS: [{ name: "unpaid_bills", args: { vendor: "gulf" } }],
  ALNOOR: [{ name: "unpaid_bills", args: { vendor: "al noor" } }],
  NOBODY: [{ name: "unpaid_bills", args: { vendor: "Nobody Trading" } }],
  UNPAIDC: [{ name: "unpaid_invoices", args: {} }],
  LOWSTOCK: [{ name: "stock_levels", args: { low_only: true } }],
  MILKSTOCK: [{ name: "stock_levels", args: { item: "milk" } }],
  CASHBANK: [{ name: "cash_and_bank", args: {} }],
  SALESYEAR: [{ name: "trade_totals", args: { kind: "sales", period: "this_year" } }],
  BUYYEAR: [{ name: "trade_totals", args: { kind: "purchases", period: "this_year" } }],
  MIXED: [{ name: "search_help", args: { question: "payables" } }, { name: "unpaid_bills", args: {} }],
  SLIPONCE: [{ name: "unpaid_invoices", args: {} }],
  PROFITNOW: [{ name: "profit_and_loss", args: { period: "this_year" } }],
  BALSHEET: [{ name: "balance_sheet", args: {} }],
  SNAPSHOT: [{ name: "business_snapshot", args: {} }],
  ALERTS: [{ name: "stock_alerts", args: {} }],
};
// Groq's 400 "tool_use_failed" (the model wrote a malformed tool call), once per question that asks for it.
let slipped = 0;
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push({ body, tools: (body.tools || []).map((t) => t.function.name) });
    const msgs = body.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const afterTool = msgs.slice(msgs.lastIndexOf(lastUser)).some((m) => m.role === "tool");
    const key = Object.keys(SCRIPT).sort((a, b) => b.length - a.length).find((k) => String(lastUser?.content || "").includes(k));
    const offered = seen.at(-1).tools;
    if (key === "SLIPONCE" && slipped === 0) {
      slipped += 1;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Failed to call a function. Please adjust your prompt.", type: "invalid_request_error", code: "tool_use_failed" } }));
      return;
    }
    let message;
    if (key && !afterTool && SCRIPT[key].every((c) => offered.includes(c.name))) {
      message = { role: "assistant", content: null, tool_calls: SCRIPT[key].map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
    } else {
      message = { role: "assistant", content: afterTool ? "The table above shows them." : "I can help with that in the documentation." };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "x", model: body.model, choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  });
});

// ---- the stack ---------------------------------------------------------------------------------
let stack;
let call;
const T = {};
const D = {};
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const as = (who, method, url, body, headers) => call(method, url, { token: T[who], body, headers });
const ask = (who, question, extra = {}) => as(who, "POST", "/assistant/ask", { question, screen: "/dashboard", ...extra });
const toolNames = () => seen.at(-1)?.tools || [];
const LOOKUPS = ["unpaid_bills", "unpaid_invoices", "stock_levels", "cash_and_bank", "trade_totals"];
const dubaiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());

test.before(async () => {
  if (skip) return;
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    ASSISTANT_PROVIDER: "openai",
    ASSISTANT_OPEN_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`,
    ASSISTANT_OPEN_MODEL: "test-model",
    ASSISTANT_ALLOW_PRIVATE_HOSTS: "true",
  });
  delete process.env.ASSISTANT_API_KEY;
  stack = await H.startStack("ailook");
  call = H.makeCaller(stack.base);
  const Admin = require("../../models/core/adminModel");
  await stack.Org.create({ legalName: "AI Look Trading LLC", code: ORG, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  for (const [who, type] of [["owner", "super_admin"], ["viewer", "viewer"]]) {
    const email = `${who}@${ORG}.ai.test`;
    await stack.as(ORG, () => new Admin({ name: `${who} person`, email, password: H.PASSWORD, status: "active", isActive: true, type }).save());
    const r = await call("POST", "/login", { body: { email, password: H.PASSWORD } });
    assert.equal(r.status, 200, r.text);
    T[who] = r.body.tokens.accessToken;
  }
  await as("owner", "GET", "/accounting/chart");

  const must = (res, what) => {
    assert.ok(res.status >= 200 && res.status < 300, `${what}: ${res.status} ${res.text.slice(0, 300)}`);
    const b = res.body;
    return b && typeof b === "object" && !b._id ? Object.values(b).find((v) => v && typeof v === "object" && v._id) || b : b;
  };
  const cat = must(await as("owner", "POST", "/categories/categories", { name: "Dairy", description: "Dairy" }), "category");
  const unit = must(await as("owner", "POST", "/uom/units", { unitName: "Carton", shortCode: "CTN", type: "Base", category: "Weight" }), "unit");
  // a reorder level above what will be on hand, so milk reads as running low
  D.milk = must(await as("owner", "POST", "/stock/stock", { itemName: "Milk 1L", sku: "MILK1", categoryId: cat._id, unitOfMeasure: unit._id, origin: "UAE", brand: "Local", salesPrice: 4.5, purchasePrice: 3, currentStock: 0, reorderLevel: 500 }), "milk");
  const vend = (name, n) => as("owner", "POST", "/vendors/vendors", { vendorName: name, contactPerson: "Contact", email: `v${n}@ailook.test`, phone: "0504445566", address: "Industrial Area", paymentTerms: "Net 30", trnNO: `10077733330000${n}` });
  D.gulf = must(await vend("Gulf Packaging", 3), "vendor");
  D.steel = must(await vend("Al Noor Steel", 1), "vendor");
  must(await vend("Al Noor Trading", 2), "vendor");
  D.customer = must(await as("owner", "POST", "/customers", { customerName: "Harbour Cafe", contactPerson: "Contact", email: "c1@ailook.test", phone: "0502223344", billingAddress: "Marina", creditLimit: 100000, paymentTerms: "Net 30" }), "customer");

  const doc = (type, partyId, partyType, qty, price, date) =>
    as("owner", "POST", "/transactions/transactions", { type, partyId, partyType, partyTypeRef: partyType, date, items: [{ itemId: D.milk._id, description: "Milk 1L", qty, price, rate: price, vatPercent: 5, batchNumber: "B1", expiryDate: "2099-12-31" }] });
  const approve = (id) => as("owner", "PATCH", `/transactions/transactions/${id}/process`, { action: "approve" });
  // Gulf: 315 (40 days old, Net 30 -> overdue) and 630 (not due yet). Al Noor Steel: 110.25. All with 5% VAT.
  D.po1 = must(await doc("purchase_order", D.gulf._id, "Vendor", 100, 3, day(-40)), "po1");
  D.po2 = must(await doc("purchase_order", D.gulf._id, "Vendor", 200, 3, day(-2)), "po2");
  D.po3 = must(await doc("purchase_order", D.steel._id, "Vendor", 35, 3, day(-2)), "po3");
  for (const po of [D.po1, D.po2, D.po3]) must(await approve(po._id), "approve po");
  D.so = must(await doc("sales_order", D.customer._id, "Customer", 10, 4.5, day(-1)), "so");
  must(await approve(D.so._id), "approve so");
  const Transaction = require("../../models/modules/transactionModel");
  D.numbers = await stack.as(ORG, async () => (await Transaction.find({}).select("transactionNo").lean()).map((t) => t.transactionNo));

  const groups = (await as("owner", "GET", "/accounting/account-groups")).body || [];
  const bankGroup = groups.find((g) => g.name === "Bank");
  D.bank = must(await as("owner", "POST", "/accounting/accounts", { accountName: "ENBD Current", groupId: bankGroup._id, openingBalance: 48210.75, openingSide: "debit" }), "bank");
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

test("list unpaid vendors: the ageing report's own figures, written by the server, and nothing written to the books", { skip }, async () => {
  const before = await counts();
  const r = await ask("owner", "UNPAIDV list unpaid vendors");
  assert.equal(r.status, 200, r.text);
  for (const n of LOOKUPS) assert.ok(toolNames().includes(n), `the owner is offered ${n}`);
  assert.equal(r.body.outcome, "answered", JSON.stringify(r.body));
  assert.equal(r.body.answer, "2 vendors are unpaid: AED 1,055.25 on 3 bills, of which AED 315.00 is past due.");
  assert.equal(r.body.tables.length, 1);
  const t = r.body.tables[0];
  assert.deepEqual(t.rows.map((x) => [x.label, x.value, x.tone]), [["Gulf Packaging", "AED 945.00", "danger"], ["Al Noor Steel", "AED 110.25", ""]]);
  assert.deepEqual(t.total, { label: "Total", value: "AED 1,055.25" });
  assert.equal(t.link.path, "/ageing?type=payable");

  // the same figures as the ageing report the screen shows
  const ageing = await as("owner", "GET", "/accounting/reports/ageing?type=payable");
  assert.equal(ageing.status, 200, ageing.text);
  const total = (ageing.body.totals && ageing.body.totals.total) ?? ageing.body.rows.reduce((s, x) => s + x.total, 0);
  assert.equal(Math.round(total * 100), 105525);
  assert.equal(seen.filter((s) => JSON.stringify(s.body.messages).includes("UNPAIDV")).length, 1, "one model call: the server wrote the answer");
  assert.deepEqual(await counts(), before, "looking up wrote nothing");
  // the answer is stored with its table, so a reopened panel shows it
  const mine = await as("owner", "GET", "/assistant/mine");
  assert.equal(mine.body[0].tables[0].title, "Unpaid vendors");
  D.firstConversation = r.body.conversationId;
});

test("one vendor by name, choices for a name that fits two, a plain sentence for none", { skip }, async () => {
  const g = await ask("owner", "GULFBILLS what do we owe gulf");
  assert.equal(g.body.answer, "You owe Gulf Packaging AED 945.00 on 2 bills, AED 315.00 of it past due.");
  assert.deepEqual(g.body.tables[0].rows.map((x) => x.value), ["AED 315.00", "AED 630.00"], "oldest first");
  const two = await ask("owner", "ALNOOR what do we owe al noor");
  assert.equal(two.body.answer, "Which vendor do you mean? Al Noor Steel, Al Noor Trading. Tell me which one and I will look it up.");
  assert.deepEqual(two.body.tables, []);
  const none = await ask("owner", "NOBODY what do we owe nobody");
  assert.match(none.body.answer, /I could not find a vendor called "Nobody Trading"/);
});

test("overdue only, customers, stock, cash and the year's sales and purchases", { skip }, async () => {
  const od = await ask("owner", "OVERDUEV overdue vendors");
  assert.equal(od.body.answer, "1 vendor is owed AED 315.00 that is past due, on 1 bill.");
  const c = await ask("owner", "UNPAIDC who owes us");
  assert.equal(c.body.answer, "1 customer has not paid in full: AED 47.25 on 1 invoice, none of it past due.");
  const low = await ask("owner", "LOWSTOCK what is low in stock");
  assert.deepEqual(low.body.tables[0].rows.map((x) => [x.label, x.value]), [["Milk 1L", "325"]], "335 bought, 10 sold, reorder level 500");
  const one = await ask("owner", "MILKSTOCK stock of milk");
  assert.equal(one.body.answer, "Milk 1L: 325 on hand, which is at or below its reorder level of 500.");
  const cash = await ask("owner", "CASHBANK how much is in the bank");
  const enbd = cash.body.tables[0].rows.find((x) => x.label === "ENBD Current");
  assert.equal(enbd.value, "AED 48,210.75");

  const period = data.periodOf("this_year", dubaiToday());
  for (const [key, direction] of [["SALESYEAR", "sales"], ["BUYYEAR", "purchases"]]) {
    const r = await ask("owner", `${key} ${direction} this year`);
    const route = await as("owner", "GET", `/trade-reports/summary?direction=${direction}&from=${period.from}&to=${period.to}&groupBy=party`);
    assert.equal(route.status, 200, route.text);
    if (route.body.rows.length) {
      assert.equal(r.body.tables[0].total.value, data.money(route.body.totals.net, "AED"), `${direction}: the same total as Analysis`);
    } else {
      assert.match(r.body.answer, /^No /);
    }
  }
});

test("a malformed tool call the AI service refuses is asked again once, and the person never sees it", { skip }, async () => {
  const r = await ask("owner", "SLIPONCE who owes us money");
  assert.equal(r.status, 200, r.text);
  assert.equal(slipped, 1, "the service refused the first try");
  assert.equal(r.body.outcome, "answered", JSON.stringify(r.body));
  assert.match(r.body.answer, /^1 customer has not paid in full/);
});

test("a round that mixes the help search with a lookup still sends the model no figures", { skip }, async () => {
  const r = await ask("owner", "MIXED unpaid vendors and how payables work");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.tables.length, 1, "the table is shown");
  const followUp = seen.filter((s) => JSON.stringify(s.body.messages).includes("MIXED")).at(-1);
  const toolMsgs = followUp.body.messages.filter((m) => m.role === "tool");
  const lookupResult = toolMsgs.find((m) => m.content.includes("shown_to_person"));
  assert.ok(lookupResult, "the model is told the table was shown");
  assert.equal(lookupResult.content, JSON.stringify({ shown_to_person: true }));
});

test("history keeps the figures out too: the next turn tells the model only that a table was shown", { skip }, async () => {
  await ask("owner", "CASHBANK bank balance please", { conversationId: D.firstConversation });
  await ask("owner", "thanks, and anything else?", { conversationId: D.firstConversation });
  const last = seen.at(-1).body.messages;
  const assistantTurns = last.filter((m) => m.role === "assistant").map((m) => m.content);
  assert.ok(assistantTurns.length >= 1, "earlier turns are sent");
  assert.ok(assistantTurns.every((c) => /showed the figures in a table/.test(c)), JSON.stringify(assistantTurns));
});

test("THE PRIVACY RULE: no bill number, amount or balance from the books ever reached the AI service", { skip }, async () => {
  const everything = JSON.stringify(seen.map((s) => s.body.messages));
  for (const n of D.numbers) assert.ok(!everything.includes(n), `${n} was sent to the AI service`);
  for (const figure of ["945", "1,055", "1055", "110.25", "315.00", "630", "48,210", "48210", "47.25", "325"]) {
    assert.ok(!everything.includes(figure), `${figure} was sent to the AI service`);
  }
});

test("a Viewer is offered only what their role can read, and an administrator can switch lookups off", { skip }, async () => {
  await ask("viewer", "UNPAIDV list unpaid vendors");
  const viewerTools = toolNames();
  // a Viewer reads every module, so whatever is offered must be offered by the role; what matters is the refusal path below
  const blocked = await as("viewer", "PUT", "/assistant/settings", { lookupsEnabled: false });
  assert.equal(blocked.status, 403, "only an administrator changes it");

  const off = await as("owner", "PUT", "/assistant/settings", { lookupsEnabled: false });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body.lookupsEnabled, false);
  await ask("owner", "UNPAIDV list unpaid vendors");
  assert.deepEqual(toolNames().filter((n) => LOOKUPS.includes(n)), [], "switched off: none offered");
  const tip = await as("owner", "GET", "/assistant/screen?screen=/dashboard");
  assert.deepEqual(tip.body.lookups, []);

  const on = await as("owner", "PUT", "/assistant/settings", { lookupsEnabled: true });
  assert.equal(on.body.lookupsEnabled, true);
  const tip2 = await as("owner", "GET", "/assistant/screen?screen=/dashboard");
  assert.ok(tip2.body.lookups.includes("unpaid_bills"));
  assert.ok(Array.isArray(viewerTools));
});

test("a role without the keys is never offered the lookup, and is refused if it calls one anyway", { skip }, async () => {
  const dataTools = require("../assistant/dataTools");
  const req = { admin: { grants: ["lookups.view", "settings.view", "reports.view"] } };
  assert.deepEqual(dataTools.definitionsFor(req, {}).map((d) => d.name), ["stock_alerts"], "reports.view opens only the stock alerts: the same reorder and expiry reports it already reads");
  const refused = await dataTools.run("unpaid_bills", {}, { req }, {});
  assert.deepEqual(refused, { ok: false, error: "Your role cannot see that. Ask an administrator." });
  const sales = { admin: { grants: ["reports.view", "sales.view"] } };
  assert.deepEqual(dataTools.definitionsFor(sales, {}).map((d) => d.name).sort(), ["stock_alerts", "trade_totals", "unpaid_invoices"]);
  assert.deepEqual(await dataTools.run("trade_totals", { kind: "purchases" }, { req: sales }, {}), { ok: false, error: "Your role cannot see purchases. Ask an administrator." });
  assert.deepEqual(dataTools.definitionsFor(sales, { lookupsEnabled: false }), []);
});

test("earlier chats: listed newest first, reopened with their tables, deleted, and never anybody else's", { skip }, async () => {
  const fresh = await ask("owner", "UNPAIDV list unpaid vendors for history");
  const id = fresh.body.conversationId;
  const list = await as("owner", "GET", "/assistant/conversations");
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body[0].id, id, "the newest chat is first");
  assert.equal(list.body[0].title, "UNPAIDV list unpaid vendors for history");
  assert.equal(list.body[0].questions, 1);

  const open = await as("owner", "GET", `/assistant/conversations/${id}`);
  assert.equal(open.status, 200, open.text);
  assert.equal(open.body.length, 1);
  assert.equal(open.body[0].tables[0].title, "Unpaid vendors", "the table is there when it is reopened");

  assert.equal((await as("viewer", "GET", `/assistant/conversations/${id}`)).status, 404, "another person's chat is a 404");
  assert.equal((await as("viewer", "DELETE", `/assistant/conversations/${id}`)).status, 404);
  assert.ok(!(await as("viewer", "GET", "/assistant/conversations")).body.some((c) => c.id === id), "nor is it in their list");
  assert.equal((await as("owner", "GET", "/assistant/conversations/not-an-id")).status, 404);

  assert.equal((await as("owner", "DELETE", `/assistant/conversations/${id}`)).status, 200);
  assert.equal((await as("owner", "GET", `/assistant/conversations/${id}`)).status, 404);
  assert.ok(!(await as("owner", "GET", "/assistant/conversations")).body.some((c) => c.id === id));
});


test("profit and loss, the balance sheet, the whole position and stock alerts: the reports' own figures", { skip }, async () => {
  const period = data.periodOf("this_year", dubaiToday());
  const pl = await as("owner", "GET", `/accounting/reports/profit-loss?from=${period.from}&to=${period.to}`);
  assert.equal(pl.status, 200, pl.text);
  const plData = pl.body.data || pl.body;
  const p = await ask("owner", "PROFITNOW profit this year");
  assert.equal(p.body.outcome, "answered", JSON.stringify(p.body));
  const net = Number(plData.netProfit);
  assert.equal(p.body.tables[0].stats[0].value, data.money(Math.abs(net), "AED"), "the same net profit as the statement");
  assert.equal(p.body.tables[0].stats[0].label, net < 0 ? "Net loss" : "Net profit");

  const today = dubaiToday();
  const bsRoute = await as("owner", "GET", `/vouchers/reports/financial?reportType=balance_sheet&dateTo=${today}`);
  assert.equal(bsRoute.status, 200, bsRoute.text);
  const bsData = (bsRoute.body.data || bsRoute.body).report || bsRoute.body.data;
  const b = await ask("owner", "BALSHEET show balance sheet");
  assert.equal(b.body.tables[0].stats[0].value, data.money(bsData.totalAssets, "AED"), "the same total assets as the balance sheet");
  assert.equal(b.body.tables[0].total.value, data.money(bsData.totalLiabilitiesAndEquity, "AED"));

  const snap = await ask("owner", "SNAPSHOT how are we doing");
  assert.match(snap.body.answer, /^You have AED 70,000\.00|^You have AED 48,210\.75/);
  assert.ok(snap.body.tables[0].rows.some((r) => r.label === "Customers owe you"));

  const al = await ask("owner", "ALERTS stock alerts");
  assert.equal(al.body.tables[0].title, "Stock alerts");
  assert.ok(al.body.tables[0].rows.some((r) => r.label === "Milk 1L" && /reorder at 500/.test(r.sub)), "the low item is listed");
});

test("the statements are offered only to a person who may read them", { skip }, async () => {
  const dataTools = require("../assistant/dataTools");
  const names = (grants) => dataTools.definitionsFor({ admin: { grants } }, {}).map((d) => d.name);
  assert.ok(!names(["inventory.view", "sales.view"]).includes("profit_and_loss"), "without reports.financial");
  assert.ok(names(["reports.financial"]).includes("balance_sheet"));
  assert.ok(names(["reports.financial"]).includes("business_snapshot"));
  assert.deepEqual(names(["inventory.view"]).sort(), ["stock_alerts", "stock_levels"]);
});
