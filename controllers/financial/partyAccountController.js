const catchAsync = require("../../utils/catchAsync");
const PartyAccountService = require("../../services/financial/partyAccountService");
const AuditService = require("../../services/core/auditService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// POST /accounting/accounts/party: a customer / vendor and its ledger account, in the chosen group
exports.create = catchAsync(async (req, res) => {
  const { account, party } = await PartyAccountService.create(req.body, req, req.admin?.id);
  await AuditService.log({ req, action: "ACCOUNT_CREATED", entity: "LedgerAccount", entityId: account._id,
    summary: `${account.accountCode} ${account.accountName}`, after: { groupId: account.groupId, openingBalance: account.openingBalance, openingSide: account.openingSide, partyId: party._id } });
  ok(res, { account, party }, 201);
});

// GET /accounting/accounts/:id/party: the customer / vendor behind an account ({ kind, party }; party null when none)
exports.get = catchAsync(async (req, res) => ok(res, await PartyAccountService.get(req.params.id, req)));

// PUT /accounting/accounts/:id/party: change the party's details and the account's own settings together
exports.update = catchAsync(async (req, res) => {
  const { account, party } = await PartyAccountService.update(req.params.id, req.body, req);
  await AuditService.log({ req, action: "ACCOUNT_UPDATED", entity: "LedgerAccount", entityId: account._id,
    summary: `${account.accountCode} ${account.accountName}`, after: Object.keys(req.body.party || {}) });
  ok(res, { account, party });
});
