const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");

const DAY = 86400000;
const BUCKETS = [
  { key: "current", label: "Not yet due", from: -Infinity, to: 0 },
  { key: "d1_30", label: "1-30 days", from: 1, to: 30 },
  { key: "d31_60", label: "31-60 days", from: 31, to: 60 },
  { key: "d61_90", label: "61-90 days", from: 61, to: 90 },
  { key: "d90plus", label: "Over 90 days", from: 91, to: Infinity },
];

// Payment terms are stored as text ("Net 30", "45 days", "COD"). The number of days is derived,
// not stored twice. Cash on delivery and prepaid are due on the document date.
function termDays(terms) {
  const m = /(\d+)/.exec(String(terms || ""));
  return m ? Number(m[1]) : 0;
}

const bucketOf = (daysPastDue) => BUCKETS.find((b) => daysPastDue >= b.from && daysPastDue <= b.to).key;

class AgeingService {
  static termDays = termDays;
  static BUCKETS = BUCKETS;

  // Open (unpaid) invoices with their due date and how many days past due they are on `asOf`.
  static async openInvoices({ type, asOf = new Date(), partyId, session } = {}) {
    if (!["receivable", "payable"].includes(type)) throw new AppError("type must be receivable or payable", 400);
    const docType = type === "receivable" ? "sales_order" : "purchase_order";
    const partyModel = type === "receivable" ? "Customer" : "Vendor";
    const nameField = type === "receivable" ? "customerName" : "vendorName";
    const asOfDate = new Date(asOf);

    const match = {
      type: docType,
      status: "APPROVED",
      outstandingAmount: { $gt: 0.005 },
      date: { $lte: asOfDate },
    };
    if (partyId) match.partyId = new mongoose.Types.ObjectId(partyId);

    const q = Transaction.find(match)
      .select("transactionNo date dueDate isOpening partyId totalAmount paidAmount outstandingAmount")
      .populate({ path: "partyId", model: partyModel, select: `${nameField} paymentTerms` })
      .sort({ date: 1 })
      .lean();
    const docs = await (session ? q.session(session) : q);

    return docs.map((d) => {
      const days = termDays(d.partyId?.paymentTerms);
      // an opening invoice entered with its own due date keeps it; every other document is due by the party's terms
      const dueDate = d.dueDate ? new Date(d.dueDate) : new Date(new Date(d.date).getTime() + days * DAY);
      const pastDue = Math.floor((asOfDate - dueDate) / DAY);
      return {
        transactionId: d._id,
        transactionNo: d.transactionNo,
        isOpening: Boolean(d.isOpening),
        partyId: d.partyId?._id,
        partyName: d.partyId?.[nameField] || "(deleted)",
        paymentTerms: d.partyId?.paymentTerms || null,
        date: d.date,
        dueDate,
        daysPastDue: Math.max(pastDue, 0),
        daysToDue: pastDue < 0 ? -pastDue : 0,
        bucket: bucketOf(pastDue),
        total: round2(d.totalAmount),
        paid: round2(d.paidAmount),
        outstanding: round2(d.outstandingAmount),
      };
    });
  }

  // Ageing by party and bucket. Buckets always sum to the party total, and the grand total equals
  // the sum of the open invoices.
  static async report({ type, asOf = new Date() } = {}) {
    const invoices = await this.openInvoices({ type, asOf });
    const parties = new Map();
    for (const inv of invoices) {
      const k = String(inv.partyId);
      if (!parties.has(k)) {
        parties.set(k, {
          partyId: inv.partyId, partyName: inv.partyName, paymentTerms: inv.paymentTerms,
          buckets: Object.fromEntries(BUCKETS.map((b) => [b.key, 0])), total: 0, invoices: [],
        });
      }
      const p = parties.get(k);
      p.buckets[inv.bucket] = round2(p.buckets[inv.bucket] + inv.outstanding);
      p.total = round2(p.total + inv.outstanding);
      p.invoices.push(inv);
    }
    const rows = [...parties.values()].sort((a, b) => b.total - a.total);
    const totals = Object.fromEntries(BUCKETS.map((b) => [b.key, round2(rows.reduce((t, r) => t + r.buckets[b.key], 0))]));
    totals.total = round2(rows.reduce((t, r) => t + r.total, 0));
    return {
      type, asOf: new Date(asOf), buckets: BUCKETS.map(({ key, label }) => ({ key, label })),
      rows, totals,
      overdue: round2(totals.total - totals.current),
    };
  }
}

module.exports = AgeingService;
