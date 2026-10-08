const MessagingService = require("../../services/messaging/messagingService");
const SettingsService = require("../../services/messaging/settingsService");
const ShareService = require("../../services/messaging/shareService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");
const { DOC_LABEL } = require("../../utils/emailTemplates");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const who = (rows) => (rows.length > 1 ? `${rows[0]} and ${rows.length - 1} more` : rows[0] || "");
// The audit row sits on the document that was sent, so it shows in that document's own activity.
const ENTITY = { Transaction: "Transaction", Quotation: "Quotation", DeliveryNote: "DeliveryNote", Customer: "Customer" };
const label = (row) => `${DOC_LABEL[row.docType] || "Document"} ${row.documentNo}`;

const logSend = (req, row, action, summary) =>
  AuditService.log({ req, action, entity: ENTITY[row.sourceType] || row.sourceType, entityId: row.sourceId, summary, after: { sendId: String(row._id), channel: row.channel, status: row.status, to: row.to, phone: row.phone, shareLinkId: row.shareLinkId ? String(row.shareLinkId) : null } });

exports.send = catchAsync(async (req, res) => {
  let r;
  try {
    r = await MessagingService.send(req.body, req.file || null, req);
  } catch (err) {
    // The row exists even though the provider refused it: say so in the document's own history.
    if (err.details?.sendId) {
      const row = await MessagingService.get(err.details.sendId, req).catch(() => null);
      if (row) await logSend(req, row, "DOCUMENT_SEND_FAILED", `${label(row)} could not be emailed to ${who(row.to)}: ${err.message}`);
    }
    throw err;
  }
  if (!r.duplicate) await logSend(req, r.send, "DOCUMENT_EMAILED", `${label(r.send)} emailed to ${who(r.send.to)}`);
  ok(res, r, r.duplicate ? 200 : 201);
});

exports.handoff = catchAsync(async (req, res) => {
  const r = await MessagingService.handoff(req.body, req);
  if (!r.duplicate) await logSend(req, r.send, "DOCUMENT_WHATSAPP_HANDOFF", `${label(r.send)} handed to WhatsApp for +${r.send.phone}`);
  ok(res, r, r.duplicate ? 200 : 201);
});

exports.retry = catchAsync(async (req, res) => {
  const row = await MessagingService.retry(req.params.id, req);
  await logSend(req, row, "DOCUMENT_SEND_RETRIED", `${label(row)} emailed to ${who(row.to)} on a retry`);
  ok(res, row);
});

exports.list = catchAsync(async (req, res) => ok(res, await MessagingService.list(req, req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await MessagingService.get(req.params.id, req)));

exports.shares = catchAsync(async (req, res) => ok(res, await ShareService.list(req, req.query)));
exports.revoke = catchAsync(async (req, res) => {
  const link = await ShareService.revoke(req.params.id, { by: String(req.admin?.id || ""), reason: req.body?.reason }, req);
  await AuditService.log({ req, action: "SHARE_LINK_WITHDRAWN", entity: ENTITY[link.sourceType] || link.sourceType, entityId: link.sourceId, summary: `The online link to ${link.documentNo} was withdrawn`, after: { shareLinkId: String(link._id) } });
  ok(res, { _id: link._id, revokedAt: link.revokedAt });
});

exports.getSettings = catchAsync(async (req, res) => ok(res, await SettingsService.get(req)));
exports.putSettings = catchAsync(async (req, res) => {
  const out = await SettingsService.update(req.body, req);
  // never log the key or the mailbox password themselves
  await AuditService.log({ req, action: "MESSAGING_SETTINGS_CHANGED", entity: "MessagingSettings", summary: Object.keys(req.body).join(", "), after: { ...req.body, apiKey: req.body.apiKey ? "(changed)" : undefined, smtpPassword: req.body.smtpPassword ? "(changed)" : undefined } });
  ok(res, out);
});
exports.readiness = catchAsync(async (req, res) => ok(res, await SettingsService.readiness(req)));
exports.test = catchAsync(async (req, res) => ok(res, await SettingsService.test(req.body, req)));
