const catchAsync = require("../../utils/catchAsync");
const NotificationService = require("../../services/core/notificationService");

const flag = (v) => ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());

exports.list = catchAsync(async (req, res) => {
  const data = await NotificationService.forPerson(req, { unreadOnly: flag(req.query.unreadOnly) });
  res.status(200).json({ success: true, data });
});

exports.unreadCount = catchAsync(async (req, res) => {
  const data = await NotificationService.unreadCount(req);
  res.status(200).json({ success: true, data });
});

exports.markRead = catchAsync(async (req, res) => {
  const data = await NotificationService.markRead(req, req.params.id);
  res.status(200).json({ success: true, data });
});

exports.markAllRead = catchAsync(async (req, res) => {
  const data = await NotificationService.markAllRead(req);
  res.status(200).json({ success: true, data });
});
