const catchAsync = require("../../utils/catchAsync");
const AssistantService = require("../../services/assistant/assistantService");
const corpus = require("../../utils/helpCorpus");

exports.ask = catchAsync(async (req, res) => {
  const data = await AssistantService.ask(req.body || {}, req);
  res.status(200).json({ success: true, data });
});

exports.rate = catchAsync(async (req, res) => {
  const helpful = req.body?.helpful === null ? null : Boolean(req.body?.helpful);
  const data = await AssistantService.rate(req.params.id, helpful, req);
  res.status(200).json({ success: true, data });
});

exports.mine = catchAsync(async (req, res) => {
  const data = await AssistantService.mine(req, { limit: req.query.limit });
  res.status(200).json({ success: true, data });
});

// What this screen is about, so the panel can open with something useful before anything is asked.
exports.screenTip = catchAsync(async (req, res) => {
  const screen = String(req.query.screen || "");
  res.status(200).json({
    success: true,
    data: { screen, topics: corpus.forScreen(screen), suggestions: corpus.suggestionsFor(screen) },
  });
});

exports.getSettings = catchAsync(async (req, res) => {
  const data = await AssistantService.publicSettings(req.tenant.companyId);
  res.status(200).json({ success: true, data });
});

exports.putSettings = catchAsync(async (req, res) => {
  const data = await AssistantService.saveSettings(req.body || {}, req);
  res.status(200).json({ success: true, data });
});

exports.usage = catchAsync(async (req, res) => {
  const data = await AssistantService.usage(req, { from: req.query.from, to: req.query.to });
  res.status(200).json({ success: true, data });
});

exports.escalate = catchAsync(async (req, res) => {
  const data = await AssistantService.handOver(req.body || {}, req);
  res.status(201).json({ success: true, data });
});
