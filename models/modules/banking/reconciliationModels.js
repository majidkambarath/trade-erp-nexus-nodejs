const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");
const { Schema } = mongoose;

// ---------------------------------------------------------------------------------------------
// Bank and card reconciliation.
//
// The ledger already knows what the books say about a bank account. These collections hold what the
// BANK says (imported statement lines) and how the two were brought together. They never change a
// posted entry: a statement line is matched to the entries the books already have, or an entry is
// posted for it through the ordinary voucher code, and the match is recorded here.
//
// Amounts on a line and on a match entry are signed from the BANK ACCOUNT's side: money in is
// positive, money out is negative. Days are "YYYY-MM-DD" strings (Dubai calendar days).
// ---------------------------------------------------------------------------------------------

const tenant = { companyId: { type: String, required: true }, branchId: { type: String, default: "main" } };
const day = { type: String, match: /^\d{4}-\d{2}-\d{2}$/ };

// One uploaded file (or pasted MT940) for one bank account.
const importSchema = new Schema(
  {
    ...tenant,
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    fileName: { type: String, trim: true, default: "" },
    fileHash: { type: String, default: "" },
    format: { type: String, enum: ["grid", "mt940"], default: "grid" },
    mapping: { type: Schema.Types.Mixed, default: null },
    periodFrom: day,
    periodTo: day,
    openingBalance: { type: Number, default: null },
    closingBalance: { type: Number, default: null },
    lineCount: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "voided"], default: "active" },
    createdBy: { type: String, default: null },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: String, default: null },
  },
  { timestamps: true }
);
importSchema.index({ companyId: 1, accountId: 1, createdAt: -1 });
importSchema.index({ companyId: 1, accountId: 1, fileHash: 1 });

// One line of a statement.
//   open        nothing done with it yet
//   matched     tied to book entries (editable: it can be unmatched)
//   reconciled  matched, and locked into a completed reconciliation
//   ignored     deliberately left out, with a reason (a duplicate in the bank's own file, a bank error)
const lineSchema = new Schema(
  {
    ...tenant,
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    importId: { type: Schema.Types.ObjectId, ref: "BankStatementImport", required: true },
    lineNo: { type: Number, default: 0 },
    day: { ...day, required: true },
    valueDay: { ...day, default: null },
    description: { type: String, trim: true, default: "", maxlength: 600 },
    reference: { type: String, trim: true, default: "", maxlength: 200 },
    chequeNo: { type: String, trim: true, default: "" },
    amount: { type: Number, required: true },
    balance: { type: Number, default: null },
    fingerprint: { type: String, required: true },
    occurrence: { type: Number, default: 1 },
    state: { type: String, enum: ["open", "matched", "reconciled", "ignored"], default: "open" },
    matchId: { type: Schema.Types.ObjectId, ref: "BankMatch", default: null },
    reconciliationId: { type: Schema.Types.ObjectId, ref: "BankReconciliation", default: null },
    ignoredReason: { type: String, trim: true, default: "", maxlength: 250 },
    ignoredBy: { type: String, default: null },
    ignoredAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// the same line can never be imported twice; two identical lines on one day are told apart by occurrence
lineSchema.index({ companyId: 1, accountId: 1, fingerprint: 1, occurrence: 1 }, { unique: true });
lineSchema.index({ companyId: 1, accountId: 1, state: 1, day: 1 });
lineSchema.index({ importId: 1 });
lineSchema.index({ matchId: 1 });

// A group of statement lines tied to a group of book entries. The invariant is exact: the lines add
// up to the entries (to the fils), so a difference is never hidden inside a match - it is posted as
// an entry of its own (a bank fee, a card commission) and that entry is part of the group.
//   match    ordinary: lines <-> existing entries
//   created  an entry was posted for the line (fee, interest, transfer, receipt...)
//   card     a card settlement: many card receipts + the commission entry <-> one bank credit
//   offset   lines that cancel each other (a cheque deposited and returned): no entries, lines add to zero
const entryRef = new Schema(
  {
    type: { type: String, enum: ["ledger", "cheque"], default: "ledger" },
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry" },
    voucherId: { type: Schema.Types.ObjectId },
    voucherNo: { type: String, default: "" },
    voucherType: { type: String, default: "" },
    chequeId: { type: Schema.Types.ObjectId, ref: "Cheque", default: null },
    day: day,
    amount: { type: Number, required: true },
    narration: { type: String, default: "" },
    clearedByMatch: { type: Boolean, default: false },
  },
  { _id: false }
);
const matchSchema = new Schema(
  {
    ...tenant,
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    kind: { type: String, enum: ["match", "created", "card", "offset"], default: "match" },
    method: { type: String, enum: ["auto", "manual", "created", "card"], default: "manual" },
    lineIds: [{ type: Schema.Types.ObjectId, ref: "BankStatementLine" }],
    entries: [entryRef],
    // vouchers posted FOR this match (a fee, interest, a card commission); undoing the match can delete them
    createdVouchers: [{ voucherId: Schema.Types.ObjectId, voucherNo: String, kind: String, _id: false }],
    note: { type: String, trim: true, default: "", maxlength: 250 },
    status: { type: String, enum: ["active", "undone"], default: "active" },
    reconciliationId: { type: Schema.Types.ObjectId, ref: "BankReconciliation", default: null },
    matchedBy: { type: String, default: null },
    undoneBy: { type: String, default: null },
    undoneAt: { type: Date, default: null },
  },
  { timestamps: true }
);
matchSchema.index({ companyId: 1, accountId: 1, status: 1 });
matchSchema.index({ companyId: 1, "entries.voucherId": 1, status: 1 });
// a book entry and a statement line each belong to at most one active match
matchSchema.index(
  { companyId: 1, "entries.ledgerEntryId": 1 },
  { unique: true, partialFilterExpression: { status: "active", "entries.ledgerEntryId": { $exists: true } } }
);
matchSchema.index({ companyId: 1, lineIds: 1 }, { unique: true, partialFilterExpression: { status: "active" } });

// A completed reconciliation of a bank account as of a date, with the proof as it stood then.
const reconciliationSchema = new Schema(
  {
    ...tenant,
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    number: { type: String, required: true },
    asOf: { ...day, required: true },
    statementBalance: { type: Number, required: true },
    bookBalance: { type: Number, required: true },
    proof: { type: Schema.Types.Mixed, default: null },
    lineCount: { type: Number, default: 0 },
    matchIds: [{ type: Schema.Types.ObjectId, ref: "BankMatch" }],
    note: { type: String, trim: true, default: "", maxlength: 250 },
    status: { type: String, enum: ["completed", "reopened"], default: "completed" },
    completedBy: { type: String, default: null },
    reopenedBy: { type: String, default: null },
    reopenedAt: { type: Date, default: null },
    reopenReason: { type: String, default: "" },
  },
  { timestamps: true }
);
reconciliationSchema.index({ companyId: 1, accountId: 1, asOf: -1 });
reconciliationSchema.index({ companyId: 1, number: 1 }, { unique: true });

// What the acquirer paid for a set of card sales: the card receipts it settles, the commission the
// books already carried, what the bank actually received, and the entry posted for the difference.
const settlementReceipt = new Schema(
  {
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry" },
    voucherId: { type: Schema.Types.ObjectId },
    voucherNo: { type: String, default: "" },
    day: day,
    cardId: { type: Schema.Types.ObjectId, ref: "CardMaster", default: null },
    cardLabel: { type: String, default: "" },
    gross: { type: Number, default: 0 },
    feeBooked: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
  },
  { _id: false }
);
const cardSettlementSchema = new Schema(
  {
    ...tenant,
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    matchId: { type: Schema.Types.ObjectId, ref: "BankMatch", required: true },
    lineId: { type: Schema.Types.ObjectId, ref: "BankStatementLine", required: true },
    settlementRef: { type: String, trim: true, default: "" },
    settlementDate: { ...day, required: true },
    receipts: [settlementReceipt],
    gross: { type: Number, default: 0 },
    feeBooked: { type: Number, default: 0 },
    expectedNet: { type: Number, default: 0 },
    received: { type: Number, default: 0 },
    difference: { type: Number, default: 0 },
    extraCommission: { type: Number, default: 0 },
    vat: { type: Number, default: 0 },
    adjustmentVoucherId: { type: Schema.Types.ObjectId, default: null },
    adjustmentVoucherNo: { type: String, default: "" },
    status: { type: String, enum: ["active", "undone"], default: "active" },
    createdBy: { type: String, default: null },
    undoneAt: { type: Date, default: null },
  },
  { timestamps: true }
);
cardSettlementSchema.index({ companyId: 1, accountId: 1, settlementDate: -1 });
cardSettlementSchema.index({ companyId: 1, matchId: 1 });

// How this account's statement is laid out, remembered from the last import.
const profileSchema = new Schema(
  {
    ...tenant,
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    mapping: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);
profileSchema.index({ companyId: 1, accountId: 1 }, { unique: true });

// Where reconciliation of an account starts. Before startDay the books are taken as reconciled
// outside the system, except the entries listed as still outstanding (cheques and deposits that had
// not reached the statement yet). statementOpening is the bank's balance the day before startDay.
const setupSchema = new Schema(
  {
    ...tenant,
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    startDay: { ...day, required: true },
    statementOpening: { type: Number, required: true },
    outstandingEntryIds: [{ type: Schema.Types.ObjectId, ref: "LedgerEntry" }],
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);
setupSchema.index({ companyId: 1, accountId: 1 }, { unique: true });

const m = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
importSchema.plugin(tenantPlugin);
lineSchema.plugin(tenantPlugin);
matchSchema.plugin(tenantPlugin);
reconciliationSchema.plugin(tenantPlugin);
cardSettlementSchema.plugin(tenantPlugin);
profileSchema.plugin(tenantPlugin);
setupSchema.plugin(tenantPlugin);

module.exports = {
  BankStatementImport: m("BankStatementImport", importSchema),
  BankStatementLine: m("BankStatementLine", lineSchema),
  BankMatch: m("BankMatch", matchSchema),
  BankReconciliation: m("BankReconciliation", reconciliationSchema),
  CardSettlement: m("CardSettlement", cardSettlementSchema),
  BankStatementProfile: m("BankStatementProfile", profileSchema),
  BankReconSetup: m("BankReconSetup", setupSchema),
};
