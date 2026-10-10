// The approvals list: what is waiting for a decision, from the point of view of the person asking.
//
// Not a second set of rules. Every row is judged by utils/approvalRules.js `decide` - the SAME function the approve routes
// call, with the same policy and the same person - so the list can never offer what the server would refuse, nor hide what
// it would allow. A document or voucher appears here only if the person holds the approve permission of its module (a
// storekeeper is not shown the finance queue at all); then it falls in one of two lists:
//
//   forYou   they could approve it right now (module permission, their role's limit, the separate-approver rule, and the
//            second-approver state: a document whose first approval was given by someone else waits for a DIFFERENT person)
//   others   it is waiting, but not for them, with the reason in the server's own words (over their limit, they prepared it,
//            they gave the first approval already)
//
// Read-only. Trade documents are the DRAFT ones (a draft is a document waiting to be approved); vouchers are the pending
// ones (a voucher held for approval, or an older one waiting). Branch scope is automatic: both models are branch-scoped, so a
// person sees what the branch they are working in has waiting.
const Transaction = require("../../models/modules/transactionModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const Admin = require("../../models/core/adminModel");
const mongoose = require("mongoose");
const roles = require("../../utils/permissions");
const rules = require("../../utils/approvalRules");
const tz = require("../../utils/tz");
const orgLocale = require("../../utils/orgLocale");
const ApprovalPolicyService = require("./approvalPolicyService");

// Each source is read oldest first and cut here: an approver clears the oldest first, and a list of thousands is not a
// to-do list. When more are waiting the reply says so (`capped`).
const CAP = 300;
const SHOWN = 200;

const DOCUMENT_STATUSES = ["DRAFT", "PENDING"];
const VOUCHER_STATUSES = ["pending", "draft"];
const VOUCHER_TYPES = ["receipt", "payment", "journal", "contra", "expense", "debit_note", "credit_note"];

const DOCUMENT_LABEL = { sales_order: "Sales order", sales_return: "Sales return", purchase_order: "Purchase order", purchase_return: "Purchase return" };
const VOUCHER_LABEL = { receipt: "Receipt", payment: "Payment", journal: "Journal", contra: "Contra", expense: "Expense", debit_note: "Debit note", credit_note: "Credit note" };
// the screen that lists each kind (a document's list opens narrowed to its number)
const DOCUMENT_PAGE = { sales_order: "/sales-order", sales_return: "/sales-return", purchase_order: "/purchase-order", purchase_return: "/purchase-return" };
const VOUCHER_PAGE = { receipt: "/receipt-voucher", payment: "/payment-voucher", journal: "/journal-voucher", contra: "/contra-voucher", expense: "/expense-voucher", debit_note: "/debit-credit-notes", credit_note: "/debit-credit-notes" };

const WAITING = "waiting";
const AWAITING_SECOND = "awaiting second approver";

const idString = (v) => (v === undefined || v === null ? "" : String(v));
const validIds = (list) => [...new Set(list.map(idString).filter((id) => mongoose.isValidObjectId(id)))];

/** Whole calendar days between two instants, as the organisation's calendar reads them (never negative). */
function ageInDays(createdAt, now = new Date()) {
  const zone = orgLocale.timezone();
  const from = tz.dayOf(createdAt, zone);
  const to = tz.todayIn(zone, now);
  if (!from || !to) return 0;
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000));
}

class ApprovalQueueService {
  /** The document types (by module permission) and whether vouchers, this person may approve. */
  static scopeOf(grants) {
    const documentTypes = Object.keys(DOCUMENT_LABEL).filter((t) => roles.can(grants, `${roles.moduleOfType(t)}.approve`));
    return { documentTypes, vouchers: roles.can(grants, "finance.approve") };
  }

  /**
   * -> { forYou: [row], others: [row], counts: { forYou, others }, capped }   (countOnly: { count, others, capped })
   * `req` is the request of the person asking (req.admin: who they are, their grants and their role's limit).
   */
  static async waiting(req, { countOnly = false, now = new Date() } = {}) {
    const grants = req.admin?.grants;
    const scope = this.scopeOf(grants);
    const empty = { forYou: [], others: [], counts: { forYou: 0, others: 0 }, capped: false };
    if (!scope.documentTypes.length && !scope.vouchers) return countOnly ? { count: 0, others: 0, capped: false } : empty;

    const actor = ApprovalPolicyService.actorOf(req);
    const policy = await ApprovalPolicyService.policy();
    const currency = orgLocale.baseCurrency();

    const lean = (q) => q.sort({ createdAt: 1 }).limit(CAP + 1).lean();
    const [documents, vouchers] = await Promise.all([
      scope.documentTypes.length
        ? lean(Transaction.find({ type: { $in: scope.documentTypes }, status: { $in: DOCUMENT_STATUSES }, isOpening: { $ne: true } })
            .select("type transactionNo partyId partyType totalAmount date createdAt createdBy approvals status branchId"))
        : [],
      scope.vouchers
        ? lean(Voucher.find({ status: { $in: VOUCHER_STATUSES }, voucherType: { $in: VOUCHER_TYPES } })
            .select("voucherNo voucherType partyId partyType partyName narration totalAmount date createdAt createdBy approvals status branchId"))
        : [],
    ]);
    const capped = documents.length > CAP || vouchers.length > CAP;
    const candidates = [
      ...documents.slice(0, CAP).map((d) => ({ kind: "document", doc: d, approvals: d.approvals, preparedBy: d.createdBy, type: d.type })),
      ...vouchers.slice(0, CAP).map((v) => ({ kind: "voucher", doc: v, approvals: v.approvals, preparedBy: v.createdBy, type: v.voucherType })),
    ];

    // Judge each one exactly as the approve route would.
    const judged = candidates.map((c) => ({
      ...c,
      verdict: rules.decide({ policy, amount: c.doc.totalAmount, preparedBy: c.preparedBy, approver: actor, approvals: c.approvals, currency }),
    }));
    const mine = judged.filter((j) => j.verdict.ok);
    const notMine = judged.filter((j) => !j.verdict.ok);
    if (countOnly) return { count: mine.length, others: notMine.length, capped };

    const oldest = (a, b) => new Date(a.doc.createdAt) - new Date(b.doc.createdAt);
    const shownMine = mine.sort(oldest).slice(0, SHOWN);
    const shownOthers = notMine.sort(oldest).slice(0, SHOWN);
    const names = await this.names([...shownMine, ...shownOthers]);
    const row = (j) => this.row(j, { policy, names, now });
    return {
      forYou: shownMine.map(row),
      others: shownOthers.map(row),
      counts: { forYou: mine.length, others: notMine.length },
      capped,
    };
  }

  /** The names the rows need - who prepared each one, and the customer or vendor - read in three queries, not one per row. */
  static async names(items) {
    const docs = items.filter((i) => i.kind === "document").map((i) => i.doc);
    const customerIds = validIds(docs.filter((d) => d.partyType !== "Vendor").map((d) => d.partyId));
    const vendorIds = validIds(docs.filter((d) => d.partyType === "Vendor").map((d) => d.partyId));
    const adminIds = validIds(items.map((i) => i.preparedBy));
    const [customers, vendors, admins] = await Promise.all([
      customerIds.length ? Customer.find({ _id: { $in: customerIds } }).select("customerName").lean() : [],
      vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select("vendorName").lean() : [],
      adminIds.length ? Admin.find({ _id: { $in: adminIds } }).select("name email").lean() : [],
    ]);
    return {
      customer: new Map(customers.map((c) => [String(c._id), c.customerName])),
      vendor: new Map(vendors.map((v) => [String(v._id), v.vendorName])),
      admin: new Map(admins.map((a) => [String(a._id), a.name || a.email])),
    };
  }

  static row(j, { policy, names, now }) {
    const { kind, doc, verdict } = j;
    const isDocument = kind === "document";
    const number = isDocument ? doc.transactionNo : doc.voucherNo;
    const given = (j.approvals || []).filter((a) => a && a.by !== undefined && a.by !== null);
    const awaitingSecond = given.length > 0 && rules.needsSecondApproval(policy, doc.totalAmount);
    const party = isDocument
      ? (doc.partyType === "Vendor" ? names.vendor : names.customer).get(String(doc.partyId)) || ""
      : doc.partyName || "";
    const page = isDocument ? DOCUMENT_PAGE[j.type] : VOUCHER_PAGE[j.type];
    return {
      id: String(doc._id),
      kind,
      type: j.type,
      typeLabel: (isDocument ? DOCUMENT_LABEL : VOUCHER_LABEL)[j.type] || j.type,
      number,
      party,
      narration: isDocument ? "" : doc.narration || "",
      amount: doc.totalAmount,
      date: doc.date,
      createdAt: doc.createdAt,
      branchId: doc.branchId || null,
      preparedBy: names.admin.get(idString(j.preparedBy)) || (mongoose.isValidObjectId(idString(j.preparedBy)) ? "" : idString(j.preparedBy)),
      preparedById: idString(j.preparedBy),
      ageDays: ageInDays(doc.createdAt, now),
      state: awaitingSecond ? AWAITING_SECOND : WAITING,
      given: given.length,
      firstApprovers: given.map((a) => a.name).filter(Boolean),
      // for a row that is theirs: will their approval be the first of two? (the server's own answer)
      step: verdict.ok ? verdict.step : null,
      of: verdict.ok ? verdict.of : null,
      reason: verdict.ok ? null : { code: verdict.code, message: verdict.message },
      link: page ? (isDocument ? `${page}?search=${encodeURIComponent(number)}` : page) : null,
    };
  }
}

ApprovalQueueService.WAITING = WAITING;
ApprovalQueueService.AWAITING_SECOND = AWAITING_SECOND;
ApprovalQueueService.ageInDays = ageInDays;

module.exports = ApprovalQueueService;
