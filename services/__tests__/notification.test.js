// The in-app notification feed end to end: the create/touch/reopen lifecycle, that visibility is filtered
// per row by permission (not by the route), that reading never resurfaces a dismissed-but-still-open alert,
// and the one trigger built so far (low stock) opening and resolving its own notification as real stock
// moves below and back above the reorder level.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    Org: require("../core/organisationService"),
    Notification: require("../core/notificationService"),
    Checks: require("../core/notificationChecksService"),
    Stock: require("../../models/modules/stockModel"),
    ctx: require("../../utils/tenantContext"),
  };
  await mongoose.connection.syncIndexes();
  await svc.Org.create({ legalName: "Notif Test", code: "notiftest", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" }, { by: "dev" });
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const inOrg = (fn) => svc.ctx.runWithTenant({ companyId: "notiftest", branchId: "main" }, fn);
const reqOf = (id, grants) => ({ admin: { id, grants } });

test("raise/touch/reopen: a stable key never duplicates, and reading never resurfaces a still-open episode", { skip }, async () => {
  const seer = reqOf("person1", ["inventory.view"]);

  const created = await inOrg(() => svc.Notification.raise({ kind: "low_stock", title: "Widget is low", dedupeKey: "low_stock:w1", permission: "inventory.view" }));
  assert.equal(created.action, "create");

  const touched = await inOrg(() => svc.Notification.raise({ kind: "low_stock", title: "Widget is low", dedupeKey: "low_stock:w1", permission: "inventory.view" }));
  assert.equal(touched.action, "touch");
  assert.equal(touched.id, created.id, "the same row, not a second one");

  let feed = await inOrg(() => svc.Notification.forPerson(seer));
  assert.equal(feed.counts.unread, 1);
  assert.equal(feed.items[0].read, false);

  await inOrg(() => svc.Notification.markRead(seer, created.id));
  feed = await inOrg(() => svc.Notification.forPerson(seer));
  assert.equal(feed.counts.unread, 0);
  assert.equal(feed.items[0].read, true);

  // the condition is STILL true: re-detecting it must not resurface the dismissed row as unread
  await inOrg(() => svc.Notification.raise({ kind: "low_stock", title: "Widget is low", dedupeKey: "low_stock:w1", permission: "inventory.view" }));
  feed = await inOrg(() => svc.Notification.forPerson(seer));
  assert.equal(feed.counts.unread, 0, "touching an open row must not mark it unread again");

  // the condition goes away...
  await inOrg(() => svc.Notification.resolveMissing({ kind: "low_stock", activeDedupeKeys: [] }));
  feed = await inOrg(() => svc.Notification.forPerson(seer));
  assert.equal(feed.items.length, 0, "a resolved condition is not in the feed at all");

  // ...then recurs: a fresh episode, unread again, same dedupeKey
  const reopened = await inOrg(() => svc.Notification.raise({ kind: "low_stock", title: "Widget is low again", dedupeKey: "low_stock:w1", permission: "inventory.view" }));
  assert.equal(reopened.action, "reopen");
  assert.equal(reopened.id, created.id, "the same row is reused, not a new one");
  feed = await inOrg(() => svc.Notification.forPerson(seer));
  assert.equal(feed.counts.unread, 1, "a recurrence is unread even though the earlier episode was dismissed");
});

test("visibility is filtered per row by permission, not by the route", { skip }, async () => {
  await inOrg(() => svc.Notification.raise({ kind: "low_stock", title: "Gadget is low", dedupeKey: "low_stock:g1", permission: "inventory.view" }));
  const holder = reqOf("person2", ["inventory.view"]);
  const outsider = reqOf("person3", ["sales.view"]);
  const holderFeed = await inOrg(() => svc.Notification.forPerson(holder));
  const outsiderFeed = await inOrg(() => svc.Notification.forPerson(outsider));
  assert.ok(holderFeed.items.some((n) => n.title === "Gadget is low"));
  assert.ok(!outsiderFeed.items.some((n) => n.title === "Gadget is low"), "a permission the person does not hold must not surface the row");
  // marking read for someone who cannot see it refuses, rather than quietly succeeding
  const row = holderFeed.items.find((n) => n.title === "Gadget is low");
  await assert.rejects(() => inOrg(() => svc.Notification.markRead(outsider, row.id)), { code: "NOTIFICATION_NOT_FOUND" });
});

test("markAllRead clears every currently-visible unread row for that person, and no one else's", { skip }, async () => {
  await inOrg(() => svc.Notification.resolveMissing({ kind: "low_stock", activeDedupeKeys: [] })); // clear the state the earlier tests left
  await inOrg(() => svc.Notification.raise({ kind: "low_stock", title: "A is low", dedupeKey: "low_stock:a", permission: "inventory.view" }));
  await inOrg(() => svc.Notification.raise({ kind: "low_stock", title: "B is low", dedupeKey: "low_stock:b", permission: "inventory.view" }));
  const me = reqOf("person4", ["inventory.view"]);
  const someoneElse = reqOf("person5", ["inventory.view"]);
  const result = await inOrg(() => svc.Notification.markAllRead(me));
  assert.equal(result.count, 2);
  assert.equal((await inOrg(() => svc.Notification.forPerson(me))).counts.unread, 0);
  assert.equal((await inOrg(() => svc.Notification.forPerson(someoneElse))).counts.unread, 2, "one person's read state is their own");
});

test("checkLowStock opens a notification for an item at or below its reorder level and resolves it on restock", { skip }, async () => {
  await inOrg(() => svc.Notification.resolveMissing({ kind: "low_stock", activeDedupeKeys: [] }));
  const low = await inOrg(() => svc.Stock.create({ itemId: "LOWSTK1", sku: "LOWSTK1", itemName: "Nearly out widget", category: new mongoose.Types.ObjectId(), reorderLevel: 10, currentStock: 2 }));
  await inOrg(() => svc.Stock.create({ itemId: "FINESTK1", sku: "FINESTK1", itemName: "Well stocked widget", category: new mongoose.Types.ObjectId(), reorderLevel: 10, currentStock: 50 }));

  await inOrg(() => svc.Checks.checkLowStock());
  const seer = reqOf("person6", ["inventory.view"]);
  let feed = await inOrg(() => svc.Notification.forPerson(seer));
  assert.ok(feed.items.some((n) => n.title.includes("Nearly out widget")));
  assert.ok(!feed.items.some((n) => n.title.includes("Well stocked widget")));

  await inOrg(() => svc.Stock.updateOne({ _id: low._id }, { currentStock: 25 }));
  await inOrg(() => svc.Checks.checkLowStock());
  feed = await inOrg(() => svc.Notification.forPerson(seer));
  assert.ok(!feed.items.some((n) => n.title.includes("Nearly out widget")), "restocking resolves the alert instead of leaving it open forever");
});
