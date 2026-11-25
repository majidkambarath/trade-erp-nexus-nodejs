// Credit and re-issue (EInvoiceService.reissue, services/orderPurchase/reissueLinks.js): the credit note it drafts is a CORRECTION of the
// invoice it cancels, not goods coming back. The books take it off Sales revenue (not Sales Returns), and every analysis reads it as less
// sold, so neither gross sales nor returns are overstated by an invoice that was only issued again. Pure.

const isCorrection = (tx) => tx?.type === "sales_return" && tx?.reissue?.role === "credit";

// the posting key a leg of this document uses
const postingKey = (tx, key) => (key === "sales-returns" && isCorrection(tx) ? "sales-revenue" : key);

// aggregation expression over a transaction row: is it such a credit note (only a sales return ever carries that role)
const IS_CORRECTION = { $eq: ["$reissue.role", "credit"] };

// find filter for those credit notes
const CORRECTIONS = { type: "sales_return", "reissue.role": "credit" };

// What such a credit note is called wherever a document's kind is named (day book, statements, the audit trail). `CORRECTION_KIND` is the key
// it is counted under where documents are totted up by kind, so it is never added into "Sales return"; a row keeps its real voucherType.
const CORRECTION_LABEL = "Credit note (re-issue)";
const CORRECTION_KIND = "reissue_credit";

// the words its ledger rows carry
const correctionNarration = (tx) => `Credit note (re-issue) ${tx.transactionNo}${tx.reissue?.originalNo ? `, cancels ${tx.reissue.originalNo}` : ""}`;

module.exports = { isCorrection, postingKey, IS_CORRECTION, CORRECTIONS, CORRECTION_LABEL, CORRECTION_KIND, correctionNarration };
