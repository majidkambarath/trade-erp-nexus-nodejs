const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const corpus = require("../../utils/helpCorpus");

// The help topics as a reader opens them (the Help screen), from the same client-only corpus Zarvia AI answers from.
// A topic marked anything but `audience: client` is never served (utils/helpCorpus.js reads no other).
exports.list = catchAsync(async (req, res) => {
  const topics = corpus.all().map((t) => ({ id: t.id, title: t.title, screens: t.screens, questions: t.questions }));
  topics.sort((a, b) => a.title.localeCompare(b.title));
  res.json({ success: true, data: topics });
});

exports.topic = catchAsync(async (req, res) => {
  const t = corpus.byId(String(req.params.id || ""));
  if (!t) throw new AppError("No help topic by that name", 404, "HELP_TOPIC_NOT_FOUND");
  res.json({ success: true, data: { id: t.id, title: t.title, screens: t.screens, body: t.body } });
});
