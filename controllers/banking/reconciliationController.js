const catchAsync = require("../../utils/catchAsync");
const Rec = require("../../services/banking/reconciliationService");
const Posting = require("../../services/banking/reconciliationPosting");
const Card = require("../../services/banking/cardSettlementService");
const AuditService = require("../../services/core/auditService");
const { assertPermission } = require("../../middleware/permissionGate");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const by = (req) => req.admin?.id || req.admin?._id;
const money = (n) => Number(n || 0).toFixed(2);

// --- accounts and where reconciliation starts ---
exports.accounts = catchAsync(async (req, res) => ok(res, await Rec.accounts(req)));
exports.setupPreview = catchAsync(async (req, res) => ok(res, await Rec.setupPreview(req.query.accountId, req.query, req)));
exports.setupStatus = catchAsync(async (req, res) => ok(res, await Rec.setupStatus(req.query.accountId, req)));
exports.saveSetup = catchAsync(async (req, res) => {
  const out = await Rec.saveSetup(req.body.accountId, req.body, req, by(req));
  await AuditService.log({ req, action: "BANK_RECON_SETUP", entity: "LedgerAccount", entityId: req.body.accountId, summary: `Reconciliation starts ${out.startDay}, statement opening ${money(out.statementOpening)}`, after: { startDay: out.startDay, statementOpening: out.statementOpening, outstanding: out.outstandingCount } });
  ok(res, out);
});
exports.profile = catchAsync(async (req, res) => ok(res, await Rec.profile(req.query.accountId, req)));

// --- importing a statement ---
exports.previewImport = catchAsync(async (req, res) => ok(res, await Rec.preview(req.body.accountId, req.body, req)));
exports.importStatement = catchAsync(async (req, res) => {
  const out = await Rec.importStatement(req.body.accountId, req.body, req, by(req));
  await AuditService.log({ req, action: "BANK_STATEMENT_IMPORTED", entity: "BankStatementImport", entityId: out.import._id, summary: `${out.imported} lines imported${out.duplicates ? `, ${out.duplicates} already there` : ""} (${out.import.periodFrom} to ${out.import.periodTo})` });
  ok(res, out, 201);
});
exports.imports = catchAsync(async (req, res) => ok(res, await Rec.imports(req.query.accountId, req)));
exports.voidImport = catchAsync(async (req, res) => {
  const out = await Rec.voidImport(req.params.id, req, by(req));
  await AuditService.log({ req, action: "BANK_STATEMENT_VOIDED", entity: "BankStatementImport", entityId: req.params.id, summary: `${out.removed} lines removed` });
  ok(res, out);
});

// --- the worklist ---
exports.lines = catchAsync(async (req, res) => ok(res, await Rec.lines(req.query.accountId, req.query, req)));
exports.entries = catchAsync(async (req, res) => ok(res, await Rec.searchEntries(req.query.accountId, req.query, req)));
exports.allocation = catchAsync(async (req, res) => ok(res, await Posting.allocation(req.query.accountId, req.params.id, req.query, req)));

exports.match = catchAsync(async (req, res) => {
  const m = await Rec.match(req.body.accountId, req.body, req, by(req));
  await AuditService.log({ req, action: "BANK_LINES_MATCHED", entity: "BankMatch", entityId: m._id, summary: `${m.lineIds.length} statement line${m.lineIds.length === 1 ? "" : "s"} matched to ${m.entries.length} entr${m.entries.length === 1 ? "y" : "ies"}` });
  ok(res, m, 201);
});
exports.accept = catchAsync(async (req, res) => {
  const out = await Rec.acceptSuggestions(req.body.accountId, req.body, req, by(req));
  if (out.accepted) await AuditService.log({ req, action: "BANK_LINES_MATCHED", entity: "BankMatch", entityId: out.matchIds[0], summary: `${out.accepted} suggested match${out.accepted === 1 ? "" : "es"} accepted` });
  ok(res, out);
});
exports.unmatch = catchAsync(async (req, res) => {
  const deleteVouchers = req.body?.deleteVouchers === true || req.query.deleteVouchers === "true";
  // "and delete its entries" deletes APPROVED vouchers, which reverses them: the same right as deleting one by hand
  if (deleteVouchers) assertPermission(req, "finance.deletePosted");
  const out = await Rec.unmatch(req.params.id, { deleteVouchers }, req, by(req));
  await AuditService.log({ req, action: "BANK_LINES_UNMATCHED", entity: "BankMatch", entityId: req.params.id, summary: `Match undone${req.body?.deleteVouchers ? " and its entries deleted" : ""}` });
  ok(res, out);
});
exports.ignore = catchAsync(async (req, res) => {
  const line = await Rec.ignore(req.params.id, req.body.reason, req, by(req));
  await AuditService.log({ req, action: "BANK_LINE_IGNORED", entity: "BankStatementLine", entityId: line._id, summary: `${money(line.amount)} on ${line.day} ignored: ${line.ignoredReason}` });
  ok(res, line);
});
exports.unignore = catchAsync(async (req, res) => ok(res, await Rec.unignore(req.params.id, req)));
exports.createFromLine = catchAsync(async (req, res) => {
  const out = await Posting.createFromLine(req.body.accountId, req.params.id, req.body, req, by(req));
  await AuditService.log({ req, action: "BANK_LINE_POSTED", entity: "Voucher", entityId: out.voucher._id, summary: `${out.voucher.voucherNo} posted from a ${req.body.kind} statement line (${money(out.voucher.totalAmount)})` });
  ok(res, out, 201);
});

// --- the proof and the reconciliations ---
exports.proof = catchAsync(async (req, res) => ok(res, await Rec.proof(req.query.accountId, req.query, req)));
exports.finish = catchAsync(async (req, res) => {
  const rec = await Rec.finish(req.body.accountId, req.body, req, by(req));
  await AuditService.log({ req, action: "BANK_RECONCILIATION_COMPLETED", entity: "BankReconciliation", entityId: rec._id, summary: `${rec.number} ${rec.accountName} as of ${rec.asOf}, statement ${money(rec.statementBalance)}` });
  ok(res, rec, 201);
});
exports.reconciliations = catchAsync(async (req, res) => ok(res, await Rec.reconciliations(req.query.accountId, req)));
exports.reconciliation = catchAsync(async (req, res) => ok(res, await Rec.reconciliation(req.params.id, req)));
exports.reopen = catchAsync(async (req, res) => {
  const rec = await Rec.reopen(req.params.id, req.body, req, by(req));
  await AuditService.log({ req, action: "BANK_RECONCILIATION_REOPENED", entity: "BankReconciliation", entityId: rec._id, summary: `${rec.number} reopened${rec.reopenReason ? `: ${rec.reopenReason}` : ""}` });
  ok(res, rec);
});

// --- card settlement ---
exports.cardUnsettled = catchAsync(async (req, res) => ok(res, await Card.unsettled(req.query.accountId, req.query, req)));
exports.cardSettle = catchAsync(async (req, res) => {
  const out = await Card.settle(req.body.accountId, req.body, req, by(req));
  await AuditService.log({ req, action: "CARD_SETTLEMENT_RECORDED", entity: "CardSettlement", entityId: out.settlement._id, summary: `${out.settlement.receipts.length} card sales settled, received ${money(out.settlement.received)}, commission ${money(out.settlement.extraCommission)} + VAT ${money(out.settlement.vat)}` });
  ok(res, out, 201);
});
exports.cardSettlements = catchAsync(async (req, res) => ok(res, await Card.list(req.query.accountId, req.query, req)));
exports.cardVariance = catchAsync(async (req, res) => ok(res, await Card.variance(req.query.accountId, req.query, req)));
exports.cardAgeing = catchAsync(async (req, res) => ok(res, await Card.ageing(req.query.accountId, req.query, req)));
