const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../priceLists");
const v = require("../vanSales");

const RICE = "rice";
const list = (over) => ({ _id: "L1", name: "Wholesale", active: true, validFrom: "", validTo: "", customerIds: [], lines: [], ...over });

test("a customer's own list beats the route's, which beats the item's price", () => {
  const custList = list({ _id: "C", name: "Al Noor deal", customerIds: ["c1"], lines: [{ stockId: RICE, price: 17, minQty: 1 }] });
  const routeList = list({ _id: "R", name: "North route", lines: [{ stockId: RICE, price: 18, minQty: 1 }] });
  const lists = [custList, routeList];
  assert.deepEqual(p.priceFor({ stockId: RICE, customerId: "c1", routeListId: "R", lists, itemPrice: 20 }), { price: 17, source: "customer", listId: "C", listName: "Al Noor deal" });
  assert.equal(p.priceFor({ stockId: RICE, customerId: "c2", routeListId: "R", lists, itemPrice: 20 }).source, "route");
  assert.deepEqual(p.priceFor({ stockId: RICE, customerId: "c2", routeListId: null, lists, itemPrice: 20 }), { price: 20, source: "item", listId: "", listName: "" });
  assert.equal(p.priceFor({ stockId: "oil", customerId: "c1", routeListId: "R", lists, itemPrice: 30 }).source, "item", "an item on no list keeps its own price");
});

test("quantity breaks: the largest break the sale reaches wins", () => {
  const l = list({ customerIds: ["c1"], lines: [{ stockId: RICE, price: 18, minQty: 1 }, { stockId: RICE, price: 16, minQty: 10 }, { stockId: RICE, price: 15, minQty: 50 }] });
  const at = (qty) => p.priceFor({ stockId: RICE, qty, customerId: "c1", lists: [l], itemPrice: 20 }).price;
  assert.equal(at(1), 18);
  assert.equal(at(9.99), 18);
  assert.equal(at(10), 16);
  assert.equal(at(49), 16);
  assert.equal(at(50), 15);
});

test("a list out of its days or switched off prices nothing; two of the customer's lists give the lower price", () => {
  const old = list({ _id: "O", customerIds: ["c1"], validTo: "2026-10-31", lines: [{ stockId: RICE, price: 10, minQty: 1 }] });
  const off = list({ _id: "F", customerIds: ["c1"], active: false, lines: [{ stockId: RICE, price: 9, minQty: 1 }] });
  const a = list({ _id: "A", customerIds: ["c1"], lines: [{ stockId: RICE, price: 19, minQty: 1 }] });
  const b = list({ _id: "B", customerIds: ["c1"], validFrom: "2026-11-01", lines: [{ stockId: RICE, price: 18.5, minQty: 1 }] });
  const r = p.priceFor({ stockId: RICE, customerId: "c1", date: "2026-11-17", lists: [old, off, a, b], itemPrice: 20 });
  assert.equal(r.price, 18.5);
  assert.equal(r.listId, "B");
  assert.equal(p.priceFor({ stockId: RICE, customerId: "c1", date: "2026-10-15", lists: [old, off, a, b], itemPrice: 20 }).price, 10, "the old list was in force then");
});

test("a list is checked as it is saved", () => {
  assert.throws(() => p.validateList({}), (e) => e.code === "PRICE_LIST_NAME_REQUIRED");
  assert.throws(() => p.validateList({ name: "x", validFrom: "2026-12-01", validTo: "2026-11-01" }), (e) => e.code === "INVALID_RANGE");
  assert.throws(() => p.validateList({ name: "x", lines: [{ stockId: "a", price: -1 }] }), (e) => e.code === "PRICE_INVALID");
  assert.throws(() => p.validateList({ name: "x", lines: [{ stockId: "a", price: 1, minQty: 5 }, { stockId: "a", price: 2, minQty: 5 }] }), (e) => e.code === "DUPLICATE_PRICE_LINE");
  const ok = p.validateList({ name: " Wholesale ", customerIds: ["c1", "c1"], lines: [{ stockId: "a", price: "12.345" }, { stockId: "", price: 1 }] });
  assert.equal(ok.name, "Wholesale");
  assert.deepEqual(ok.customerIds, ["c1"]);
  assert.deepEqual(ok.lines, [{ stockId: "a", itemName: "", price: 12.35, minQty: 1 }]);
});

test("the strike rate counts each customer once, and is null when nobody was called on", () => {
  assert.deepEqual(v.calls({ buyers: ["a", "a", "b"], visited: ["b", "c", "d"] }), { productive: 2, calls: 4, strikeRate: 50 });
  assert.deepEqual(v.calls({ buyers: [], visited: [] }), { productive: 0, calls: 0, strikeRate: null });
  assert.equal(v.calls({ buyers: ["a"], visited: [] }).strikeRate, 100);
});

test("a transfer out is a negative load: the van's stock follows it", () => {
  const trip = { status: "ON_ROUTE", loads: [{ no: 1, lines: [{ stockId: RICE, qty: 40 }] }, { no: 2, kind: "transfer_out", lines: [{ stockId: RICE, qty: -10 }] }] };
  assert.equal(v.loadedOf(trip).get(RICE), 30);
  assert.equal(v.onVan({ status: "ON_ROUTE", loaded: v.loadedOf(trip) }).sellable.get(RICE), 30);
});
