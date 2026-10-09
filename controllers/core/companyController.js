const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const CompanyProfileService = require("../../services/core/companyProfileService");
const AuditService = require("../../services/core/auditService");
const { deleteFromCloudinary } = require("../../middleware/upload");

// The organisation's letterhead (see services/core/companyProfileService.js). Anyone signed in reads it - it is printed on
// every document a person can see; changing it is changing the company's settings (settings.manage, decided by the route).

exports.profile = catchAsync(async (req, res) => {
  res.status(200).json({ success: true, data: await CompanyProfileService.get() });
});

// The screen sends what the old per-person form sent: a `companyInfo` JSON string beside an optional `companyLogo` file (a
// multipart form), or the same fields as plain JSON.
function readPatch(body = {}) {
  const raw = body.companyInfo !== undefined ? body.companyInfo : body;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { throw new AppError("The company details could not be read", 400, "INVALID_COMPANY_INFO"); }
  }
  return raw && typeof raw === "object" ? raw : {};
}

exports.updateProfile = catchAsync(async (req, res) => {
  const logo = req.files?.companyLogo?.[0] || null;
  try {
    const patch = readPatch(req.body);
    const out = await CompanyProfileService.update(patch, { logo });
    const what = [...Object.keys(patch).filter((k) => k !== "bankDetails"), ...Object.keys(patch.bankDetails || {}).map((k) => `bank ${k}`), ...(logo ? ["logo"] : [])];
    await AuditService.log({ req, action: "COMPANY_PROFILE_UPDATED", entity: "CompanySettings", summary: `Company profile changed: ${what.join(", ") || "nothing"}` });
    res.status(200).json({ success: true, data: out });
  } catch (error) {
    // A refusal must not leave the uploaded logo behind in storage.
    if (logo?.filename) await deleteFromCloudinary(logo.filename).catch(() => {});
    throw error;
  }
});
