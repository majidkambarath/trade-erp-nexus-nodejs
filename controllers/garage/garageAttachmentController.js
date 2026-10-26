// Files on a job card, a vehicle or a claim - the check-in photos above all. The same four handlers for all
// three, which differ only in the id parameter and the words in the audit row; follows crmController.js's
// filesOf() shape exactly.
const GarageAttachmentService = require("../../services/garage/garageAttachmentService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const OWNERS = {
  jobcard: { param: "id", entity: "JobCard" },
  vehicle: { param: "vehicleId", entity: "Vehicle" },
  claim: { param: "claimId", entity: "InsuranceClaim" },
};

const filesOf = (kind) => ({
  list: catchAsync(async (req, res) => ok(res, await GarageAttachmentService.list(kind, req.params[OWNERS[kind].param], req))),
  add: catchAsync(async (req, res) => {
    const file = await GarageAttachmentService.add(kind, req.params[OWNERS[kind].param], req.file, { by: by(req), label: req.body?.label, req });
    await AuditService.log({
      req,
      action: "GARAGE_ATTACHMENT_ADDED",
      entity: OWNERS[kind].entity,
      entityId: req.params[OWNERS[kind].param],
      summary: `${file.fileName} was attached`,
      after: { fileName: file.fileName, fileSize: file.fileSize },
    });
    ok(res, file, 201);
  }),
});

exports.jobCardFiles = filesOf("jobcard");
exports.vehicleFiles = filesOf("vehicle");
exports.claimFiles = filesOf("claim");

exports.downloadFile = catchAsync(async (req, res) => {
  const { attachment: a, stream } = await GarageAttachmentService.open(req.params.attachmentId, req);
  res.setHeader("Content-Type", a.mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.originalName)}`);
  stream.pipe(res);
});

exports.removeFile = catchAsync(async (req, res) => {
  const gone = await GarageAttachmentService.remove(req.params.attachmentId, req);
  await AuditService.log({
    req,
    action: "GARAGE_ATTACHMENT_REMOVED",
    entity: OWNERS[gone.ownerType].entity,
    entityId: gone.ownerId,
    summary: `${gone.fileName} was removed`,
    after: { fileName: gone.fileName },
  });
  ok(res, { removed: true });
});
