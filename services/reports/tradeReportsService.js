const mongoose = require("mongoose");
const Stock = require("../../models/modules/stockModel");
const Category = require("../../models/modules/categoryModel");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const LedgerReportsService = require("./ledgerReportsService");
const AgeingService = require("../financial/ageingService");
const orgLocale = require("../../utils/orgLocale");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");

// Trade reports: who bought what and from whom, and what each customer or vendor owes or is owed.
//
//   summary        sales or purchases of a period, grouped by party, by item, by party and item (who bought which
//                  items), or by month; optionally with a column per month
//   register       the same documents line by line (date, number, party, item, quantity, price, VAT, total)
//   partyMovement  receivables or payables per party: opening, invoiced, returns, received / paid, closing, overdue
//
// WHAT COUNTS. Approved documents only (a draft is not in the books and so is not in a report), opening-balance invoices
// left out (they are what the business was owed when it began, not trading of the period), and returns subtracted from
// the sale or purchase they belong to. Value is the line's value after line discounts, VAT shown beside it; a header
// discount and charges such as freight are not allocated to items. Services are included (they are revenue too).
//
// DAYS. A period is the organisation's own calendar days, and a month is the organisation's calendar month.

const APPROVED = ["APPROVED", "PAID", "PARTIAL"]; // PAID / PARTIAL: what documents approved by older versions may still carry
const MAX_LINES = 20000; // the register and the grouped summaries read at most this many document lines
const r2 = (n) => round2(n) || 0; // `|| 0` turns -0 into 0
const r5 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e5) / 1e5 || 0;
const r6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6 || 0;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isObjectIdText = (v) => /^[0-9a-f]{24}$/i.test(String(v));

const GROUPS = ["party", "item", "party_item", "month"];
const KINDS = {
  sales: { types: ["sales_order", "sales_return"], party: "Customer", partyField: "customerName", codeField: "customerId" },
  purchases: { types: ["purchase_order", "purchase_return"], party: "Vendor", partyField: "vendorName", codeField: "vendorId" },
};

function objectId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (!isObjectIdText(value)) throw new AppError(`${label} is not valid`, 400, "INVALID_ID");
  return new mongoose.Types.ObjectId(String(value));
}

function span({ from, to } = {}) {
  const f = from || `${orgLocale.today().slice(0, 7)}-01`;
  const t = to || orgLocale.today();
  const start = LedgerReportsService.dayStart(f);
  const end = LedgerReportsService.dayEnd(t);
  if (start > end) throw new AppError("The start date is after the end date", 400, "INVALID_RANGE");
  return { start, end, from: f, to: t };
}

const monthOf = (ymd) => String(ymd).slice(0, 7);
const nextMonth = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};
const monthsBetween = (a, b) => {
  const out = [];
  for (let m = a; m <= b && out.length < 600; m = nextMonth(m)) out.push(m);
  return out;
};

class TradeReportsService {
  // ------------------------------------------------------------------ the lines of a period, one row per party x item x month x kind
  static async grain({ direction, from, to, partyId, itemIds }) {
    const kind = KINDS[direction];
    if (!kind) throw new AppError("direction must be sales or purchases", 400, "INVALID_DIRECTION");
    const w = span({ from, to });
    const match = {
      type: { $in: kind.types }, status: { $in: APPROVED }, isOpening: { $ne: true }, date: { $gte: w.start, $lte: w.end },
    };
    const party = objectId(partyId, "partyId");
    if (party) match.partyId = party;
    const tz = orgLocale.timezone();

    const pipeline = [{ $match: match }, { $unwind: "$items" }];
    if (itemIds) pipeline.push({ $match: { "items.itemId": { $in: itemIds } } });
    pipeline.push(
      {
        $group: {
          _id: {
            party: "$partyId", item: "$items.itemId", type: "$type",
            month: { $dateToString: { format: "%Y-%m", date: "$date", timezone: tz } },
          },
          qty: { $sum: { $ifNull: ["$items.qty", 0] } },
          total: { $sum: { $ifNull: ["$items.lineTotal", 0] } },
          vat: { $sum: { $ifNull: ["$items.vatAmount", 0] } },
          docs: { $addToSet: "$_id" },
          first: { $min: "$date" },
          last: { $max: "$date" },
        },
      },
      { $limit: MAX_LINES }
    );
    const rows = await Transaction.aggregate(pipeline);
    return { window: w, kind, rows, returnType: kind.types[1] };
  }

  // names for the ids that appear (and the item master for filters)
  static async names({ direction, partyIds, itemIdStrings }) {
    const kind = KINDS[direction];
    const Party = direction === "sales" ? Customer : Vendor;
    const [parties, stocks, categories] = await Promise.all([
      Party.find({ _id: { $in: partyIds } }).select(`${kind.partyField} ${kind.codeField} vat trnNumber trnNO`).lean(),
      Stock.find({ _id: { $in: itemIdStrings } }).select("itemId sku itemName itemType category unitOfMeasure").lean(),
      Category.find({}).select("name").lean(),
    ]);
    const catName = new Map(categories.map((c) => [String(c._id), c.name]));
    return {
      party: new Map(parties.map((p) => [String(p._id), {
        name: p[kind.partyField] || "Unknown", code: p[kind.codeField] || "",
        vatStatus: p.vat?.status || (p.vat?.trn || p.trnNumber || p.trnNO ? "registered" : "unregistered"),
        trn: p.vat?.trn || p.trnNumber || p.trnNO || "",
      }])),
      item: new Map(stocks.map((s) => [String(s._id), {
        name: s.itemName, code: s.sku || s.itemId, itemType: s.itemType || "goods",
        categoryId: s.category ? String(s.category) : null, category: catName.get(String(s.category)) || "Uncategorised",
      }])),
    };
  }

  // the items a category / search selects, as ids; null when neither filter is on
  static async itemSelection({ categoryId, search }) {
    const q = {};
    const cat = objectId(categoryId, "categoryId");
    if (cat) q.category = cat;
    const needle = String(search || "").trim();
    if (!cat && !needle) return null;
    // a search that names an item narrows by item; one that names a party is applied to the grouped rows afterwards
    if (needle) {
      const rx = new RegExp(escapeRegex(needle), "i");
      q.$or = [{ itemName: rx }, { sku: rx }, { itemId: rx }];
    }
    const items = await Stock.find(q).select("_id").lean();
    return items.map((i) => i._id);
  }

  // ------------------------------------------------------------------ 1. summary
  /**
   * groupBy: party | item | party_item | month
   * monthly: true adds `monthly` to each row ({ "2026-09": { quantity, net } }) and a `months` list
   */
  static async summary({ direction = "sales", from, to, groupBy = "party", partyId, itemId, categoryId, search, monthly = false } = {}) {
    if (!GROUPS.includes(groupBy)) throw new AppError(`groupBy must be one of ${GROUPS.join(", ")}`, 400, "INVALID_GROUP");
    const needle = String(search || "").trim();

    // the search box finds parties and items alike, so it is applied to the grouped lines below (by name and code); the
    // category narrows at the source
    let itemIds = await this.itemSelection({ categoryId, search: "" });
    const only = objectId(itemId, "itemId");
    if (only) itemIds = itemIds ? itemIds.filter((i) => String(i) === String(only)) : [only];

    const { window: w, kind, rows: every, returnType } = await this.grain({ direction, from, to, partyId, itemIds });
    const partyIds = [...new Set(every.map((g) => String(g._id.party)))].map((id) => new mongoose.Types.ObjectId(id));
    const itemIdText = [...new Set(every.map((g) => String(g._id.item)))];
    const names = await this.names({ direction, partyIds, itemIdStrings: itemIdText.filter(isObjectIdText) });
    const needleRx = needle ? new RegExp(escapeRegex(needle), "i") : null;
    const grain = needleRx
      ? every.filter((g) => {
          const p = names.party.get(String(g._id.party));
          const i = names.item.get(String(g._id.item));
          return needleRx.test(`${p?.name || ""} ${p?.code || ""} ${p?.trn || ""} ${i?.name || ""} ${i?.code || ""}`);
        })
      : every;

    const label = (g) => {
      const p = names.party.get(String(g._id.party)) || { name: "Unknown party", code: "", vatStatus: "unregistered", trn: "" };
      const i = names.item.get(String(g._id.item)) || { name: "Deleted item", code: "", itemType: "goods", categoryId: null, category: "Uncategorised" };
      return { p, i };
    };

    const buckets = new Map();
    const monthSet = new Set();
    const keyOf = (g, p, i) => {
      if (groupBy === "party") return String(g._id.party);
      if (groupBy === "item") return String(g._id.item);
      if (groupBy === "month") return g._id.month;
      return `${g._id.party}|${g._id.item}`;
    };
    for (const g of grain) {
      const { p, i } = label(g);
      const key = keyOf(g, p, i);
      if (!buckets.has(key)) {
        buckets.set(key, {
          key, out: 0, back: 0, outNet: 0, backNet: 0, vat: 0, total: 0, docs: new Set(), parties: new Set(), items: new Set(),
          first: null, last: null, monthly: {}, p, i,
        });
      }
      const b = buckets.get(key);
      const isReturn = g._id.type === returnType;
      const sign = isReturn ? -1 : 1;
      const net = (g.total || 0) - (g.vat || 0);
      b[isReturn ? "back" : "out"] += g.qty;
      b[isReturn ? "backNet" : "outNet"] += net;
      b.vat += sign * (g.vat || 0);
      b.total += sign * (g.total || 0);
      g.docs.forEach((d) => b.docs.add(String(d)));
      b.parties.add(String(g._id.party));
      b.items.add(String(g._id.item));
      if (!b.first || g.first < b.first) b.first = g.first;
      if (!b.last || g.last > b.last) b.last = g.last;
      monthSet.add(g._id.month);
      const m = (b.monthly[g._id.month] ||= { quantity: 0, net: 0 });
      m.quantity += sign * g.qty;
      m.net += sign * net;
    }

    let list = [...buckets.values()].map((b) => {
      const quantity = r6(b.out - b.back);
      const net = r2(b.outNet - b.backNet);
      const row = {
        key: b.key, documents: b.docs.size, quantity, soldQty: r6(b.out), returnedQty: r6(b.back),
        gross: r2(b.outNet), returns: r2(b.backNet), net, vat: r2(b.vat), total: r2(b.total),
        avgPrice: quantity > 0 ? r5(net / quantity) : null,
        firstDate: b.first, lastDate: b.last,
      };
      if (groupBy === "party" || groupBy === "party_item") {
        Object.assign(row, { partyId: [...b.parties][0], partyName: b.p.name, partyCode: b.p.code, vatStatus: b.p.vatStatus, trn: b.p.trn });
      }
      if (groupBy === "item" || groupBy === "party_item") {
        Object.assign(row, { itemId: [...b.items][0], itemName: b.i.name, itemCode: b.i.code, category: b.i.category, ...(b.i.itemType === "service" ? { itemType: "service" } : {}) });
      }
      if (groupBy === "party") row.items = b.items.size;
      if (groupBy === "item") row.parties = b.parties.size;
      if (groupBy === "month") row.month = b.key;
      if (monthly) {
        row.monthly = Object.fromEntries(Object.entries(b.monthly).map(([m, v]) => [m, { quantity: r6(v.quantity), net: r2(v.net) }]));
      }
      return row;
    });

    const sortKey = groupBy === "month" ? null : "net";
    if (sortKey) list.sort((a, b) => b.net - a.net || String(a.partyName || a.itemName).localeCompare(String(b.partyName || b.itemName)));
    else list.sort((a, b) => a.month.localeCompare(b.month));
    const total = r2(list.reduce((t, r) => t + r.net, 0));
    list = list.map((r) => ({ ...r, sharePct: total > 0 ? r2((r.net / total) * 100) : null }));

    const months = monthly || groupBy === "month"
      ? monthsBetween(monthOf(w.from), monthOf(w.to))
      : [];
    const seen = new Set(list.flatMap((r) => (r.monthly ? Object.keys(r.monthly) : [])));
    for (const m of seen) if (!months.includes(m)) months.push(m);
    months.sort();

    const docs = new Set();
    for (const b of buckets.values()) b.docs.forEach((d) => docs.add(d));
    return {
      direction, groupBy, from: w.from, to: w.to, months, monthly: Boolean(monthly), partyLabel: kind.party,
      rows: list,
      totals: {
        quantity: r6(list.reduce((t, r) => t + r.quantity, 0)),
        gross: r2(list.reduce((t, r) => t + r.gross, 0)),
        returns: r2(list.reduce((t, r) => t + r.returns, 0)),
        net: total,
        vat: r2(list.reduce((t, r) => t + r.vat, 0)),
        total: r2(list.reduce((t, r) => t + r.total, 0)),
        documents: docs.size,
        parties: new Set(grain.map((g) => String(g._id.party))).size,
        items: new Set(grain.map((g) => String(g._id.item))).size,
      },
      truncated: every.length >= MAX_LINES,
    };
  }

  // ------------------------------------------------------------------ 2. register (line by line)
  static async register({ direction = "sales", from, to, partyId, itemId, categoryId, search, page = 1, limit = 100 } = {}) {
    const kind = KINDS[direction];
    if (!kind) throw new AppError("direction must be sales or purchases", 400, "INVALID_DIRECTION");
    const w = span({ from, to });
    const size = Math.min(Math.max(Number(limit) || 100, 1), 500);

    let itemIds = await this.itemSelection({ categoryId, search: "" });
    const only = objectId(itemId, "itemId");
    if (only) itemIds = itemIds ? itemIds.filter((i) => String(i) === String(only)) : [only];

    const match = { type: { $in: kind.types }, status: { $in: APPROVED }, isOpening: { $ne: true }, date: { $gte: w.start, $lte: w.end } };
    const party = objectId(partyId, "partyId");
    if (party) match.partyId = party;
    const pipeline = [{ $match: match }, { $unwind: "$items" }];
    if (itemIds) pipeline.push({ $match: { "items.itemId": { $in: itemIds } } });
    pipeline.push(
      {
        $project: {
          date: 1, transactionNo: 1, type: 1, partyId: 1, lpono: 1, vendorReference: 1,
          itemId: "$items.itemId", description: "$items.description", qty: "$items.qty", price: { $ifNull: ["$items.price", "$items.rate"] },
          discount: { $ifNull: ["$items.discountAmount", 0] }, vat: { $ifNull: ["$items.vatAmount", 0] }, total: { $ifNull: ["$items.lineTotal", 0] },
          vatPercent: "$items.vatPercent",
        },
      },
      { $sort: { date: -1, transactionNo: -1 } },
      { $limit: MAX_LINES }
    );
    const raw = await Transaction.aggregate(pipeline);
    const names = await this.names({
      direction,
      partyIds: [...new Set(raw.map((r) => String(r.partyId)))].map((id) => new mongoose.Types.ObjectId(id)),
      itemIdStrings: [...new Set(raw.map((r) => String(r.itemId)))].filter(isObjectIdText),
    });

    const needle = String(search || "").trim();
    const rx = needle ? new RegExp(escapeRegex(needle), "i") : null;
    let rows = raw.map((r) => {
      const p = names.party.get(String(r.partyId)) || { name: "Unknown party", code: "" };
      const i = names.item.get(String(r.itemId)) || { name: r.description || "Deleted item", code: "", category: "Uncategorised" };
      const isReturn = r.type === kind.types[1];
      const sign = isReturn ? -1 : 1;
      return {
        date: r.date, documentNo: r.transactionNo, kind: isReturn ? "return" : "invoice", reference: r.lpono || r.vendorReference || "",
        partyId: String(r.partyId), partyName: p.name, partyCode: p.code,
        itemId: String(r.itemId), itemName: i.name, itemCode: i.code, category: i.category,
        quantity: r6(sign * (Number(r.qty) || 0)), price: r5(Number(r.price) || 0),
        net: r2(sign * ((r.total || 0) - (r.vat || 0))), vat: r2(sign * (r.vat || 0)), total: r2(sign * (r.total || 0)),
        vatPercent: r.vatPercent ?? null,
      };
    });
    if (rx) rows = rows.filter((r) => rx.test(r.documentNo) || rx.test(r.partyName) || rx.test(r.itemName) || rx.test(r.itemCode) || rx.test(r.reference));

    const totals = {
      lines: rows.length,
      quantity: r6(rows.reduce((t, r) => t + r.quantity, 0)),
      net: r2(rows.reduce((t, r) => t + r.net, 0)),
      vat: r2(rows.reduce((t, r) => t + r.vat, 0)),
      total: r2(rows.reduce((t, r) => t + r.total, 0)),
    };
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const at = Math.min(Math.max(1, Number(page) || 1), pages);
    return {
      direction, from: w.from, to: w.to, partyLabel: kind.party,
      rows: rows.slice((at - 1) * size, at * size),
      totals, pagination: { page: at, pages, limit: size, total: rows.length },
      truncated: raw.length >= MAX_LINES,
    };
  }

  // ------------------------------------------------------------------ 3. receivables / payables movement per party
  /**
   * type: customer | vendor. For each party: what it owed at `from` (opening), what the period added (invoiced),
   * what took it down (returns and credit notes, received / paid, anything else) and what it owes at `to` (closing),
   * with how much of that is past due. Read from the ledger's party accounts, so it agrees with the party balances and
   * the ageing; opening-balance vouchers are brought forward whatever their date.
   */
  static async partyMovement({ type = "customer", from, to, includeZero = false, search } = {}) {
    if (!["customer", "vendor"].includes(type)) throw new AppError("type must be customer or vendor", 400, "INVALID_TYPE");
    const customer = type === "customer";
    const w = span({ from, to });
    const rx = customer ? /^Customer( Advance)? - / : /^(Vendor|Advance to Vendor) - /;
    const accounts = await LedgerAccount.find({ accountName: rx }).select("accountName").lean();
    const nameOf = new Map(accounts.map((a) => [String(a._id), a.accountName.replace(rx, "")]));
    const OPENING = ["opening", "opening_stock"];

    const sums = await LedgerEntry.aggregate([
      { $match: { accountId: { $in: accounts.map((a) => a._id) }, isReversed: { $ne: true }, date: { $lte: w.end } } },
      {
        $group: {
          _id: {
            account: "$accountId", type: "$voucherType",
            phase: { $cond: [{ $or: [{ $lt: ["$date", w.start] }, { $in: ["$voucherType", OPENING] }] }, "before", "in"] },
          },
          debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" },
        },
      },
    ]);

    // natural direction: what a customer owes is debit - credit; what we owe a vendor is credit - debit
    const raises = customer ? ["sales_order", "debit_note"] : ["purchase_order", "credit_note"];
    const returns = customer ? ["sales_return", "credit_note"] : ["purchase_return", "debit_note"];
    const settles = ["receipt", "payment", "cheque_clearance"];
    const byName = new Map();
    const row = (name) => {
      if (!byName.has(name)) byName.set(name, { name, opening: 0, invoiced: 0, returns: 0, settled: 0, other: 0 });
      return byName.get(name);
    };
    for (const s of sums) {
      const r = row(nameOf.get(String(s._id.account)));
      const natural = customer ? s.debit - s.credit : s.credit - s.debit;
      if (s._id.phase === "before") {
        r.opening += natural;
      } else if (raises.includes(s._id.type) && natural > 0) {
        r.invoiced += natural;
      } else if (returns.includes(s._id.type) && natural < 0) {
        r.returns += -natural;
      } else if (settles.includes(s._id.type) && natural < 0) {
        r.settled += -natural;
      } else {
        r.other += natural; // adjustments, journals, a receipt that was reversed into the party, advances moving
      }
    }

    const Party = customer ? Customer : Vendor;
    const nameField = customer ? "customerName" : "vendorName";
    const codeField = customer ? "customerId" : "vendorId";
    const parties = await Party.find({ [nameField]: { $in: [...byName.keys()] } }).select(`${nameField} ${codeField} paymentTerms vat trnNumber trnNO`).lean();
    const partyByName = new Map(parties.map((p) => [p[nameField], p]));
    const ageing = await AgeingService.report({ type: customer ? "receivable" : "payable", asOf: w.end });
    const overdueOf = new Map(ageing.rows.map((a) => [a.partyName, r2(a.total - a.buckets.current)]));

    const needle = String(search || "").trim();
    const srx = needle ? new RegExp(escapeRegex(needle), "i") : null;
    let list = [...byName.values()].map((r) => {
      const p = partyByName.get(r.name);
      const closing = r2(r.opening + r.invoiced - r.returns - r.settled + r.other);
      return {
        partyId: p?._id || null, partyCode: p?.[codeField] || "", partyName: r.name, paymentTerms: p?.paymentTerms || "",
        vatStatus: p?.vat?.status || (p?.vat?.trn || p?.trnNumber || p?.trnNO ? "registered" : "unregistered"),
        trn: p?.vat?.trn || p?.trnNumber || p?.trnNO || "",
        opening: r2(r.opening), invoiced: r2(r.invoiced), returns: r2(r.returns), settled: r2(r.settled), other: r2(r.other),
        closing, overdue: overdueOf.get(r.name) || 0,
      };
    });
    if (srx) list = list.filter((r) => srx.test(r.partyName) || srx.test(r.partyCode) || srx.test(r.trn));
    if (!includeZero) list = list.filter((r) => [r.opening, r.invoiced, r.returns, r.settled, r.other, r.closing].some((v) => Math.abs(v) >= 0.005));
    list.sort((a, b) => b.closing - a.closing || a.partyName.localeCompare(b.partyName));
    const sum = (k) => r2(list.reduce((t, r) => t + r[k], 0));
    return {
      type, from: w.from, to: w.to, rows: list,
      totals: {
        opening: sum("opening"), invoiced: sum("invoiced"), returns: sum("returns"), settled: sum("settled"), other: sum("other"),
        closing: sum("closing"), overdue: sum("overdue"), parties: list.length,
      },
    };
  }
}

module.exports = TradeReportsService;
