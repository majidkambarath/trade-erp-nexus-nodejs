const catchAsync = require("../../utils/catchAsync");
const BankMasterService = require("../../services/banking/bankMasterService");
const { CardTypeService, CardService } = require("../../services/banking/cardService");
const ChequeService = require("../../services/banking/chequeService");
const PaymentModeService = require("../../services/banking/paymentModeService");
const AuditService = require("../../services/core/auditService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// --- what the receipt / payment forms offer ---
exports.paymentOptions = catchAsync(async (req, res) => ok(res, await PaymentModeService.options(req)));

// --- banks ---
exports.listBanks = catchAsync(async (req, res) => ok(res, await BankMasterService.list(req, req.query)));
exports.createBank = catchAsync(async (req, res) => {
  const bank = await BankMasterService.create(req.body, req);
  await AuditService.log({ req, action: "BANK_CREATED", entity: "BankMaster", entityId: bank._id, summary: `${bank.bankCode} ${bank.bankName}` });
  ok(res, bank, 201);
});
exports.updateBank = catchAsync(async (req, res) => {
  const bank = await BankMasterService.update(req.params.id, req.body, req);
  await AuditService.log({ req, action: "BANK_UPDATED", entity: "BankMaster", entityId: bank._id, summary: `${bank.bankCode} ${bank.bankName}`, after: req.body });
  ok(res, bank);
});

// --- card types ---
exports.listCardTypes = catchAsync(async (req, res) => ok(res, await CardTypeService.list(req, { active: req.query.active === "true" })));
exports.createCardType = catchAsync(async (req, res) => {
  const type = await CardTypeService.create(req.body, req);
  await AuditService.log({ req, action: "CARD_TYPE_CREATED", entity: "CardType", entityId: type._id, summary: type.name });
  ok(res, type, 201);
});
exports.updateCardType = catchAsync(async (req, res) => {
  const type = await CardTypeService.update(req.params.id, req.body, req);
  await AuditService.log({ req, action: "CARD_TYPE_UPDATED", entity: "CardType", entityId: type._id, summary: type.name, after: req.body });
  ok(res, type);
});

// --- cards ---
exports.listCards = catchAsync(async (req, res) => ok(res, await CardService.list(req, { kind: req.query.kind, active: req.query.active === "true" })));
exports.createCard = catchAsync(async (req, res) => {
  const card = await CardService.create(req.body, req, req.admin?.id);
  await AuditService.log({ req, action: "CARD_CREATED", entity: "CardMaster", entityId: card._id, summary: `${card.label} (${card.kind})` });
  ok(res, card, 201);
});
exports.updateCard = catchAsync(async (req, res) => {
  const card = await CardService.update(req.params.id, req.body, req);
  await AuditService.log({ req, action: "CARD_UPDATED", entity: "CardMaster", entityId: card._id, summary: card.label, after: req.body });
  ok(res, card);
});

// --- cheques ---
exports.listCheques = catchAsync(async (req, res) => ok(res, await ChequeService.list(req, req.query)));
exports.clearCheque = catchAsync(async (req, res) => {
  const c = await ChequeService.clear(req.params.id, req.body, req, req.admin?.id);
  await AuditService.log({ req, action: "CHEQUE_CLEARED", entity: "Cheque", entityId: c._id, summary: `${c.chequeNo} ${c.amount}` });
  ok(res, c);
});
exports.bounceCheque = catchAsync(async (req, res) => {
  const c = await ChequeService.bounce(req.params.id, req.body, req, req.admin?.id);
  await AuditService.log({ req, action: "CHEQUE_BOUNCED", entity: "Cheque", entityId: c._id, summary: `${c.chequeNo}: ${c.reason}` });
  ok(res, c);
});
exports.cancelCheque = catchAsync(async (req, res) => {
  const c = await ChequeService.cancel(req.params.id, req.body, req, req.admin?.id);
  await AuditService.log({ req, action: "CHEQUE_CANCELLED", entity: "Cheque", entityId: c._id, summary: c.chequeNo });
  ok(res, c);
});
