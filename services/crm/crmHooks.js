// The part of the CRM that nothing else can do: the pipeline moves itself, because the real documents moved.
//
// Called from the services that own those documents, exactly the way services/orderPurchase/deliveryNoteLinks.js
// already is - after the save, inside the caller's session, with `{ session }` as an options bag. Like that module it
// requires only models and the CRM's own services, never transactionService or quotationService, so there is no import
// cycle; and like that module it is told about the undo as well as the do, because a quotation rejected or an invoice
// deleted must take its move back rather than leaving a deal won for ever.
//
// Everything here is idempotent. The claim is a conditional updateOne on the deal, filtered on the move's key not
// being there yet, and only a `modifiedCount` of 1 counts as having made the move - the same compare-and-set as
// utils/migrations.js. That matters because every caller is inside `withTransactionSession`, which retries a transient
// write conflict on a FRESH session: the hook may genuinely run twice for one document, and the second run must do
// nothing. It is also why the hook never fails a caller: a CRM pipeline must not be able to stop an invoice being
// approved, so anything unexpected is swallowed and logged (see `quietly`).
const Opportunity = require("../../models/modules/crm/opportunityModel");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const rules = require("../../utils/crm");
const logger = require("../../utils/logger");
const { todayInOrg } = require("../../utils/documentExpiry");
const CrmSetupService = require("./crmSetupService");
const ActivityService = require("./activityService");

// The only trade document that is a sale of goods to a customer. A sales RETURN is a sale type too and must never read
// as a deal being won, which is why this is a single equality and not a "starts with sales" test.
const SALES_INVOICE = "sales_order";

/**
 * The CRM is never allowed to break the thing that told it - but only as far as it honestly can.
 *
 * A rule that cannot be applied (no pipeline, no stage for the event, a deal in a state nothing fits) is swallowed:
 * the invoice is approved, the deal simply does not move, and the reason is in the debug log. A DATABASE error is
 * re-thrown, because inside a transaction it has already aborted the caller's transaction - swallowing it would leave
 * the caller committing a transaction the server has thrown away, which surfaces as "Transaction has been aborted" at
 * commit, with nothing in the log to say why. (That is exactly how deleting an approved invoice once failed: a
 * duplicate key in a CRM follow-up, caught and hidden here.)
 */
const quietly = async (what, fn) => {
  try {
    return await fn();
  } catch (error) {
    const fromTheDatabase = typeof error?.name === "string" && error.name.startsWith("Mongo");
    logger.debug(`[crm] ${what} did not happen: ${error.message}`);
    if (fromTheDatabase) throw error;
    return null;
  }
};

/**
 * The deal a document belongs to. In order of certainty:
 *   1. a deal already linked to this very document;
 *   2. a deal linked to the quotation this invoice came from;
 *   3. the customer's one open deal - and ONLY when there is exactly one. A customer with two open deals is
 *      ambiguous, and guessing would move the wrong one; the person moves it by hand instead.
 */
async function dealFor({ quotationId = null, orderId = null, quoteRef = null, customerId = null }, session) {
  const byLink = async (field, value) => {
    if (!rules.isId(value)) return null;
    return Opportunity.findOne({ [field]: String(value) }).session(session || null);
  };

  const linked = (await byLink("links.quotationId", quotationId)) || (await byLink("links.orderId", orderId));
  if (linked) return linked;

  // `Transaction.quoteRef` is the quotation's NUMBER, not its id (quotationService sets `quoteRef: doc.quotationNo`),
  // so this is a match on the number the deal recorded when the offer was made.
  const ref = rules.text(quoteRef, 40);
  if (ref) {
    const fromQuote = await Opportunity.findOne({ "links.quotationNo": ref }).session(session || null);
    if (fromQuote) return fromQuote;
  }

  if (!rules.isId(customerId)) return null;
  const open = await Opportunity.find({ customerId: String(customerId), status: "OPEN" }).limit(2).session(session || null);
  return open.length === 1 ? open[0] : null;
}

/** Note on the deal which document it became, without moving it. */
async function link(deal, patch, session) {
  const set = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined && value !== null) set[`links.${key}`] = String(value);
  if (!Object.keys(set).length) return;
  await Opportunity.updateOne({ _id: deal._id }, { $set: set }, { session });
}

/**
 * Apply one event. The claim comes first; the stage, the probability and the status go with it in the same update, so a
 * deal can never be left half-moved. What follows the claim (the next follow-up, or cancelling what is owed on a deal
 * that has just closed) is the same work a person's own stage change does, through enterStage's two halves.
 */
async function advance({ deal, event, documentId, documentNo, value, session }) {
  const [stages, settings] = await Promise.all([CrmSetupService.stages({ session }), CrmSetupService.settings({ session })]);
  const plan = rules.planAdvance({ opportunity: deal.toObject ? deal.toObject() : deal, stages, event, documentId, settings });
  if (!plan) return null;

  const today = todayInOrg();
  const set = {
    stageKey: plan.stageKey,
    stageName: plan.stageName,
    probability: plan.probability,
    status: plan.status,
    stageSinceDay: today,
    closedDay: plan.status === "OPEN" ? null : today,
    updatedBy: "automation",
  };
  // An invoice says what the business was actually worth, which is better than anybody's estimate.
  if (plan.status === "WON" && rules.num(value) > 0) set.value = rules.round2(rules.num(value));
  if (documentNo) set[event === "invoice_approved" ? "links.orderNo" : "links.quotationNo"] = String(documentNo);
  if (documentId) set[event === "invoice_approved" ? "links.orderId" : "links.quotationId"] = String(documentId);

  const claimed = await Opportunity.updateOne(
    { _id: deal._id, "autoMoves.key": { $ne: plan.key } },
    {
      $set: set,
      $push: {
        autoMoves: { key: plan.key, event: plan.event, from: plan.from, to: plan.stageKey, at: new Date(), by: "automation", docId: documentId ? String(documentId) : null, docNo: documentNo ? String(documentNo) : "" },
      },
    },
    { session }
  );
  if (!claimed.modifiedCount) return null; // somebody else made this very move: nothing more to do

  const fresh = await Opportunity.findById(deal._id).session(session || null);
  const stage = rules.stageByKey(stages, plan.stageKey);
  if (stage && stage.type === "open") {
    await ActivityService.ensureAuto({ opportunity: fresh, stage, settings, today, session });
  } else {
    await CrmActivity.updateMany({ "regarding.id": fresh._id, status: "OPEN" }, { $set: { status: "CANCELLED" } }, { session });
    await ActivityService.touch("opportunity", fresh._id, session);
  }
  return { deal: fresh, move: plan };
}

/**
 * Take one event's move back. The deal returns to the stage it was on before that move - never to the beginning - and
 * only if it is still where that move put it; if something has since moved it on, the later truth wins and the move is
 * merely marked as undone. The claim is on the move not having been undone already.
 */
async function undo({ deal, event, documentId, session }) {
  const stages = await CrmSetupService.stages({ session });
  const plan = rules.planUndo({ opportunity: deal.toObject ? deal.toObject() : deal, stages, event, documentId });
  if (!plan) return null;

  const filter = { _id: deal._id, autoMoves: { $elemMatch: { key: plan.key, undoneAt: null } } };
  const set = { "autoMoves.$.undoneAt": new Date() };
  if (!plan.forget) {
    Object.assign(set, {
      stageKey: plan.stageKey,
      stageName: plan.stageName,
      probability: plan.probability,
      status: "OPEN",
      closedDay: null,
      updatedBy: "automation",
    });
  }
  const claimed = await Opportunity.updateOne(filter, { $set: set }, { session });
  if (!claimed.modifiedCount || plan.forget) return null;

  const fresh = await Opportunity.findById(deal._id).session(session || null);
  const stage = rules.stageByKey(stages, plan.stageKey);
  const settings = await CrmSetupService.settings({ session });
  if (stage) await ActivityService.ensureAuto({ opportunity: fresh, stage, settings, today: todayInOrg(), session });
  return { deal: fresh, move: plan };
}

class CrmHooks {
  /**
   * A quotation was created, sent, accepted, rejected, revised, converted or deleted.
   *
   * `event` is what happened, not the document's status, because the same status can be arrived at in more than one
   * way. Nothing here needs a request: QuotationService's methods are given a `createdBy` string and no `req`, so the
   * hook must never depend on one.
   */
  static async onQuotationChanged(quotation, { session, event } = {}) {
    if (!quotation) return null;
    return quietly(`quotation ${quotation.quotationNo || quotation._id} (${event})`, async () => {
      const deal = await dealFor(
        { quotationId: quotation._id, customerId: quotation.partyId },
        session
      );
      if (!deal) return null;

      if (event === "created") {
        // No stage move: a draft offer is not an offer the customer has seen. The deal simply learns which quotation
        // it is being made against, which is what lets "sent" and "accepted" find it later.
        await link(deal, { quotationId: quotation._id, quotationNo: quotation.quotationNo }, session);
        return null;
      }
      if (event === "sent") return advance({ deal, event: "quotation_sent", documentId: quotation._id, documentNo: quotation.quotationNo, session });
      if (event === "accepted") return advance({ deal, event: "quotation_accepted", documentId: quotation._id, documentNo: quotation.quotationNo, session });
      if (event === "rejected" || event === "deleted") {
        // Both moves this document may have caused come back, newest first.
        await undo({ deal, event: "quotation_accepted", documentId: quotation._id, session });
        const back = await Opportunity.findById(deal._id).session(session || null);
        return undo({ deal: back || deal, event: "quotation_sent", documentId: quotation._id, session });
      }
      if (event === "revised") {
        // The offer was replaced by a new revision. The deal is genuinely still at "quotation sent", so the stage does
        // not move; only the pointer follows, to the revision the customer will actually answer.
        await link(deal, { quotationId: quotation.supersededBy || quotation._id, quotationNo: quotation.revisionNo || quotation.quotationNo }, session);
        return null;
      }
      if (event === "converted") {
        await link(deal, { orderId: quotation.convertedTo?.id, orderNo: quotation.convertedTo?.no }, session);
        return null;
      }
      return null;
    });
  }

  /**
   * A sales invoice was approved, rejected or cancelled. Called from TransactionService.processTransaction after the
   * save, beside the delivery-note and goods-receipt links - which means it inherits that method's most important
   * property for free: when only the FIRST of two approvals has been recorded, processTransaction returns before this
   * line, so a deal is never won by a document that is still waiting for its second approver.
   */
  static async onSalesDocumentProcessed(transaction, { session } = {}) {
    if (!transaction || transaction.type !== SALES_INVOICE) return null;
    // An opening invoice is the go-live balance of a customer who was already trading: it is not a deal anybody won.
    if (transaction.isOpening) return null;

    return quietly(`sales invoice ${transaction.transactionNo || transaction._id} (${transaction.status})`, async () => {
      const deal = await dealFor(
        { orderId: transaction._id, quoteRef: transaction.quoteRef, customerId: transaction.partyId },
        session
      );
      if (!deal) return null;

      if (transaction.status === "APPROVED") {
        return advance({
          deal,
          event: "invoice_approved",
          documentId: transaction._id,
          documentNo: transaction.transactionNo,
          value: transaction.totalAmount,
          session,
        });
      }
      if (["REJECTED", "CANCELLED"].includes(transaction.status)) {
        return undo({ deal, event: "invoice_approved", documentId: transaction._id, session });
      }
      return null; // still a draft: nothing has happened to the deal
    });
  }

  /** The approved invoice was deleted, and with it everything it moved - including the deal it won. */
  static async onSalesDocumentReversed(transaction, { session } = {}) {
    if (!transaction || transaction.type !== SALES_INVOICE) return null;
    return quietly(`sales invoice ${transaction.transactionNo || transaction._id} (deleted)`, async () => {
      const deal = await dealFor({ orderId: transaction._id, quoteRef: transaction.quoteRef }, session);
      if (!deal) return null;
      return undo({ deal, event: "invoice_approved", documentId: transaction._id, session });
    });
  }
}

module.exports = CrmHooks;
module.exports.dealFor = dealFor;
