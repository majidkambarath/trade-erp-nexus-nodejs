// The cheque reminders on the notification feed, end to end on a throwaway database: what is told, to whom, that a change
// of stage tells a person again, that a notice resolves itself when the cheque moves on, and that an organisation is
// judged on its plan AND its overrides (the organisation row a job is handed used to omit them).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let svc, today;
const oid = () => new mongoose.Types.ObjectId();

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    Org: require("../core/organisationService"),
    OrgModel: require("../../models/core/organisationModel"),
    Notification: require("../core/notificationService"),
    Checks: require("../core/notificationChecksService"),
    ...require("../../models/modules/banking/bankingModels"),
    ctx: require("../../utils/tenantContext"),
    day: require("../../utils/documentExpiry"),
  };
  await mongoose.connection.syncIndexes();
  const make = (code, planCode) => svc.Org.create({ legalName: code, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode }, { by: "dev" });
  await make("chqfull", "premium");
  await make("chqtrade", "trading");
  await make("chqover", "trading");
  await svc.ctx.runUnscoped("test: sell banking to one trading organisation by override", () =>
    svc.OrgModel.updateOne({ code: "chqover" }, { $set: { featureOverrides: { banking: true }, moduleOverrides: { banking: true } } })
  );
  today = svc.day.todayInOrg();
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const inOrg = (code, fn) => svc.ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const FULL = (fn) => inOrg("chqfull", fn);
const seer = (grants = ["banking.view"]) => ({ admin: { id: "p1", grants } });
const at = (n) => svc.day.addDays(today, n); // a YYYY-MM-DD day, n days from today
let seq = 0;
const make = (code, over = {}) => inOrg(code, () => svc.Cheque.create({
  direction: "receipt", voucherId: oid(), voucherNo: `RV-${++seq}`, voucherDate: new Date(), chequeNo: `${2000 + seq}`, partyName: "Al Noor",
  amount: 500, bankAccountId: oid(), status: "pending", ...over, chequeDate: new Date(`${over.day ?? at(3)}T00:00:00.000Z`),
}));
const feed = async (code, who = seer()) => (await inOrg(code, () => svc.Notification.forPerson(who)));
const titles = async (code, who) => (await feed(code, who)).items.map((n) => n.title).sort();
const idOf = (c) => String(c._id);

test("maturing: due within a week or past due is told; later, deposited and cleared cheques are not", { skip }, async () => {
  const soon = await make("chqfull", { day: at(3) });
  const far = await make("chqfull", { day: at(20) });
  const late = await make("chqfull", { day: at(-6), partyName: "Gulf Trading" });
  const ours = await make("chqfull", { day: at(0), direction: "payment", partyName: "Gulf Mills" });
  const held = await make("chqfull", { day: at(0), status: "hold", holdReason: "wait", partyName: "Holder Ltd" });
  const dep = await make("chqfull", { day: at(-2), status: "deposited", presentedOn: new Date() });
  const done = await make("chqfull", { day: at(-2), status: "cleared" });
  const r = await FULL(() => svc.Checks.checkChequesMaturing(new Date()));
  assert.equal(r.told, 4, JSON.stringify(r));
  const t = await titles("chqfull");
  assert.ok(t.some((x) => x.includes(`${soon.chequeNo} from Al Noor matures in 3 days`)), t.join("|"));
  assert.ok(t.some((x) => x.includes(`${late.chequeNo} from Gulf Trading is 6 days past its date and not deposited`)));
  assert.ok(t.some((x) => x.includes(`Our cheque ${ours.chequeNo} to Gulf Mills can be paid from today: keep the account funded`)));
  assert.ok(t.some((x) => x.includes(`${held.chequeNo} from Holder Ltd can be taken off hold and deposited today`)));
  for (const c of [far, dep, done]) assert.equal(t.some((x) => x.includes(c.chequeNo)), false, `${c.chequeNo} should not be told`);
});

test("it is the finance desk's business: banking.view sees it, a person without it does not", { skip }, async () => {
  assert.ok((await feed("chqfull", seer(["banking.view"]))).items.length > 0);
  assert.equal((await feed("chqfull", seer(["sales.view"]))).items.length, 0);
  assert.ok((await feed("chqfull")).items.every((n) => n.link === "/cheques"));
});

test("running it again changes nothing: the same notices, not duplicates, and a read one stays read", { skip }, async () => {
  const before = await feed("chqfull");
  const first = before.items[0];
  await inOrg("chqfull", () => svc.Notification.markRead(seer(), first.id));
  await FULL(() => svc.Checks.checkChequesMaturing(new Date()));
  const after = await feed("chqfull");
  assert.equal(after.items.length, before.items.length, "no duplicates");
  assert.equal(after.items.find((n) => n.id === first.id).read, true, "re-detecting a condition does not un-read it");
});

test("ESCALATION TELLS AGAIN: 'matures tomorrow' read, then past its date is a new unread notice and the old one is gone", { skip }, async () => {
  const c = await make("chqfull", { day: at(1), partyName: "Escalator Co" });
  await FULL(() => svc.Checks.checkChequesMaturing(new Date()));
  const first = (await feed("chqfull")).items.find((n) => n.title.includes("Escalator Co"));
  assert.match(first.title, /matures in 1 day/);
  await inOrg("chqfull", () => svc.Notification.markRead(seer(), first.id));

  await inOrg("chqfull", () => svc.Cheque.updateOne({ _id: c._id }, { $set: { chequeDate: new Date(`${at(-1)}T00:00:00.000Z`) } })); // a day passes
  await FULL(() => svc.Checks.checkChequesMaturing(new Date()));
  const items = (await feed("chqfull")).items.filter((n) => n.title.includes("Escalator Co"));
  assert.equal(items.length, 1, "the old stage was resolved, not left beside the new one");
  assert.match(items[0].title, /1 day past its date and not deposited/);
  assert.equal(items[0].read, false, "a person who read the first is told again");
  assert.equal(items[0].severity, "warning");
});

test("it resolves itself the moment the cheque moves on", { skip }, async () => {
  const c = await make("chqfull", { day: at(2), partyName: "Mover Co" });
  await FULL(() => svc.Checks.checkChequesMaturing(new Date()));
  assert.ok((await titles("chqfull")).some((x) => x.includes("Mover Co")));
  await inOrg("chqfull", () => svc.Cheque.updateOne({ _id: c._id }, { $set: { status: "deposited", presentedOn: new Date() } }));
  await FULL(() => svc.Checks.checkChequesMaturing(new Date()));
  assert.equal((await titles("chqfull")).some((x) => x.includes("Mover Co")), false, "deposited: no longer a reminder to deposit it");
});

test("uncleared: a cheque at the bank for 5 days is told, one for 2 is not, and it resolves when it clears", { skip }, async () => {
  const slow = await make("chqfull", { day: at(-9), status: "deposited", presentedOn: new Date(`${at(-6)}T00:00:00.000Z`), depositSlipNo: "S-42", partyName: "Slow Pay" });
  await make("chqfull", { day: at(-4), status: "deposited", presentedOn: new Date(`${at(-2)}T00:00:00.000Z`), partyName: "Fresh Co" });
  const r = await FULL(() => svc.Checks.checkChequesUncleared(new Date()));
  assert.equal(r.told, 1);
  const t = (await feed("chqfull")).items.filter((n) => /deposited .* ago/.test(n.title));
  assert.equal(t.length, 1);
  assert.match(t[0].title, new RegExp(`Cheque ${slow.chequeNo} from Slow Pay was deposited 6 days ago and has not cleared`));
  assert.equal(t[0].severity, "warning");
  await inOrg("chqfull", () => svc.Cheque.updateOne({ _id: slow._id }, { $set: { status: "cleared" } }));
  await FULL(() => svc.Checks.checkChequesUncleared(new Date()));
  assert.equal((await feed("chqfull")).items.filter((n) => /deposited .* ago/.test(n.title)).length, 0, "cleared: nothing left to chase");
});

test("expiring: a warning inside 30 days of going stale, critical once stale; one at the bank is the bank's", { skip }, async () => {
  const warn = await make("chqfull", { day: at(-170), partyName: "Ageing Co" }); // 13 days left of 183
  const dead = await make("chqfull", { day: at(-200), partyName: "Stale Co" });
  await make("chqfull", { day: at(-100), partyName: "Healthy Co" });
  await make("chqfull", { day: at(-200), status: "deposited", presentedOn: new Date(), partyName: "AtBank Co" });
  await FULL(() => svc.Checks.checkChequesExpiring(new Date()));
  const items = (await feed("chqfull")).items.filter((n) => /stale/.test(n.title));
  const byParty = (p) => items.find((n) => n.title.includes(p));
  assert.match(byParty("Ageing Co").title, new RegExp(`${warn.chequeNo} from Ageing Co goes stale in 13 days`));
  assert.equal(byParty("Ageing Co").severity, "warning");
  assert.match(byParty("Stale Co").title, new RegExp(`${dead.chequeNo} from Stale Co has gone stale`));
  assert.equal(byParty("Stale Co").severity, "critical");
  assert.equal(byParty("Healthy Co"), undefined);
  assert.equal(byParty("AtBank Co"), undefined);
  // handing the stale one back ends its notice
  await inOrg("chqfull", () => svc.Cheque.updateOne({ _id: dead._id }, { $set: { status: "returned" } }));
  await FULL(() => svc.Checks.checkChequesExpiring(new Date()));
  assert.equal((await feed("chqfull")).items.some((n) => n.title.includes("Stale Co")), false);
});

test("an organisation is judged on its plan AND its overrides: banking sold by override is told, a plan without it is not", { skip }, async () => {
  await make("chqtrade", { day: at(2), partyName: "Trade Only" });
  await make("chqover", { day: at(2), partyName: "Override Buyer" });
  const results = await svc.Checks.processDue(new Date());
  const of = (code) => results.find((r) => r.code === code).result;
  assert.deepEqual(of("chqtrade").chequesMaturing, { skipped: "not in the plan" }, "the trading plan has no banking");
  assert.equal(of("chqover").chequesMaturing.told, 1, "banking bought as an override on that plan: the checks run");
  assert.equal((await feed("chqtrade")).items.length, 0);
  assert.match((await feed("chqover")).items[0].title, /Override Buyer matures in 2 days/);
  assert.ok(of("chqfull").chequesMaturing.told >= 1);
});

test("the banking FEATURE gates it on its own: the module is held, the feature switched off, nothing is told", { skip }, async () => {
  await svc.Org.create({ legalName: "chqnofeat", code: "chqnofeat", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" }, { by: "dev" });
  await svc.ctx.runUnscoped("test: switch the banking feature off for a premium organisation", () => svc.OrgModel.updateOne({ code: "chqnofeat" }, { $set: { featureOverrides: { banking: false } } }));
  await make("chqnofeat", { day: at(2), partyName: "Gated Off" });
  const results = await svc.Checks.processDue(new Date());
  assert.deepEqual(results.find((r) => r.code === "chqnofeat").result.chequesMaturing, { skipped: "not in the plan" });
  assert.equal((await feed("chqnofeat")).items.length, 0, "the page it links to would be refused, so nothing points at it");
});

test("the registry names its module and feature for every cheque check", { skip }, async () => {
  const rows = svc.Checks.CHECKS.filter((c) => c.key.startsWith("cheques"));
  assert.deepEqual(rows.map((r) => r.key).sort(), ["chequesExpiring", "chequesMaturing", "chequesUncleared"]);
  for (const r of rows) assert.deepEqual([r.module, r.feature], ["banking", "banking"]);
});
