const catchAsync = require("../../utils/catchAsync");
const YearArchiveService = require("../../services/financial/yearArchiveService");

const ok = (res, data) => res.status(200).json({ success: true, data });
const fileOf = (req) => req.file?.buffer;

// A closed year as one sealed file, downloaded as it is; who took it is in the audit log.
exports.download = catchAsync(async (req, res) => {
  const file = await YearArchiveService.archive(req, req.params.id);
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
  res.setHeader("X-Archive-Seal", file.seal);
  res.status(200).send(file.bytes);
});

exports.check = catchAsync(async (req, res) => ok(res, await YearArchiveService.check(req, fileOf(req))));
exports.restore = catchAsync(async (req, res) => ok(res, await YearArchiveService.restore(req, fileOf(req))));
