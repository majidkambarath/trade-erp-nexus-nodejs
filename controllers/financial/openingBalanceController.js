const catchAsync = require("../../utils/catchAsync");
const OpeningBalanceService = require("../../services/financial/openingBalanceService");
const DefaultChartService = require("../../services/financial/defaultChartService");
const AuditService = require("../../services/core/auditService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const adminOf = (req) => ({ adminId: req.admin?.id });

// A company opening this screen for the first time starts from the default chart (Opening Balance
// Equity, Inventory...) with ledger posting on, as it does when the chart is opened.
const prepare = async (req) => {
  await DefaultChartService.ensure(req);
  await DefaultChartService.onOpenThrottled(req);
};
const read = (fn) => catchAsync(async (req, res) => { await prepare(req); ok(res, await fn(req)); });
const write = (fn, { status = 200, audit } = {}) =>
  catchAsync(async (req, res) => {
    await prepare(req);
    const result = await fn(req);
    if (audit) await AuditService.log({ req, ...audit(req, result) });
    ok(res, result, status);
  });

// --- go-live date and summary ---
exports.summary = read((req) => OpeningBalanceService.summary(req));
exports.setGoLive = write((req) => OpeningBalanceService.setGoLiveDate(req.body?.date), {
  audit: (req, r) => ({ action: "GO_LIVE_DATE_SET", entity: "CompanySettings", summary: `Go-live date ${r.date.toISOString().slice(0, 10)}` }),
});

// --- account balances ---
exports.listAccounts = read((req) => OpeningBalanceService.listAccounts(req));
exports.postAccounts = write((req) => OpeningBalanceService.postAccounts(req.body || {}, adminOf(req)), {
  status: 201,
  audit: (req, r) => ({ action: "OPENING_ACCOUNTS_POSTED", entity: "OpeningBalanceVoucher", entityId: r._id, summary: `${r.voucherNo}: ${r.lines} accounts, debit ${r.totalDebit} credit ${r.totalCredit}` }),
});
exports.reverseAccounts = write((req) => OpeningBalanceService.reverseAccounts(req.params.id, adminOf(req)), {
  audit: (req, r) => ({ action: "OPENING_ACCOUNTS_REVERSED", entity: "OpeningBalanceVoucher", entityId: r._id, summary: `${r.voucherNo} reversed` }),
});

// --- customer and vendor opening invoices ---
exports.listParties = read((req) => OpeningBalanceService.listParties(req.query.type));
exports.postParties = write((req) => OpeningBalanceService.postParties(req.body || {}, adminOf(req)), {
  status: 201,
  audit: (req, r) => ({ action: "OPENING_INVOICES_POSTED", entity: "Transaction", summary: `${r.count} opening ${r.type} invoice(s), total ${r.total}` }),
});
exports.reverseParty = write((req) => OpeningBalanceService.reverseParty(req.params.id, adminOf(req)), {
  audit: (req, r) => ({ action: "OPENING_INVOICE_REMOVED", entity: "Transaction", entityId: r._id, summary: `${r.transactionNo} removed` }),
});

// --- stock ---
exports.listStock = read(() => OpeningBalanceService.listStock());
exports.postStock = write((req) => OpeningBalanceService.postStock(req.body || {}, adminOf(req)), {
  status: 201,
  audit: (req, r) => ({ action: "OPENING_STOCK_POSTED", entity: "OpeningBalanceVoucher", entityId: r._id, summary: `${r.voucherNo}: ${r.rows} rows, value ${r.totalValue}` }),
});
exports.reverseStock = write((req) => OpeningBalanceService.reverseStock(req.params.id, adminOf(req)), {
  audit: (req, r) => ({ action: "OPENING_STOCK_REVERSED", entity: "OpeningBalanceVoucher", entityId: r._id, summary: `${r.voucherNo} reversed` }),
});
