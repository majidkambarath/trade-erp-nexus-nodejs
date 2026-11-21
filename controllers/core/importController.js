// The three spreadsheet imports of an organisation going live: customers, vendors and items. Each is mounted in its OWN module's router, under
// that module's own permission, because making a record is making it: a person who may not add a customer may not add forty from a file.
//
//   POST /customers/import             sales.create
//   POST /vendors/vendors/import       purchase.create
//   POST /stock/stock/import           inventory.create
//
// The body is { rows: [{ line, ...named fields }], dryRun, fileName, options }. ONLY `dryRun: false` writes - anything else is the preview, so an
// import is never done by accident. At most 200 rows are previewed and 50 written in one call; the screen sends a bigger file in lots.
const catchAsync = require("../../utils/catchAsync");
const AuditService = require("../../services/core/auditService");
const PartyImportService = require("../../services/masters/partyImportService");
const ItemImportService = require("../../services/stock/itemImportService");
const { mayViewCost } = require("../../utils/costVisibility");
const { text } = require("../../utils/crm");

const ok = (res, data) => res.status(200).json({ success: true, data });

// A written import is one audit row: how many, and the file's name. NEVER the rows - a spreadsheet of customers is names, numbers and bank
// details, and the audit log is read by people who may not see them (the CRM's imports are audited the same way).
function audited(req, action, entity, noun, result, fileName) {
  if (result.dryRun) return null;
  const s = result.summary;
  return AuditService.log({
    req, action, entity, entityId: null,
    summary: `${s.created} ${noun} were imported${s.duplicate ? `, ${s.duplicate} already held` : ""}${s.invalid + s.failed ? `, ${s.invalid + s.failed} could not be` : ""}`,
    after: { fileName: text(fileName, 120), created: s.created, duplicate: s.duplicate, invalid: s.invalid, failed: s.failed },
  });
}

exports.customers = catchAsync(async (req, res) => {
  const b = req.body || {};
  const result = await PartyImportService.run("customer", b.rows, { dryRun: b.dryRun !== false });
  await audited(req, "CUSTOMERS_IMPORTED", "Customer", "customers", result, b.fileName);
  ok(res, result);
});

exports.vendors = catchAsync(async (req, res) => {
  const b = req.body || {};
  const result = await PartyImportService.run("vendor", b.rows, { dryRun: b.dryRun !== false });
  await audited(req, "VENDORS_IMPORTED", "Vendor", "vendors", result, b.fileName);
  ok(res, result);
});

exports.items = catchAsync(async (req, res) => {
  const b = req.body || {};
  const result = await ItemImportService.run(b.rows, {
    dryRun: b.dryRun !== false,
    addCategories: b.options?.addCategories !== false,
    canSeeCost: mayViewCost(req.admin), // a person who may not see what items cost may not set it: the Purchase price column is left out
    by: req.admin?.id || "system",
  });
  await audited(req, "ITEMS_IMPORTED", "Stock", "items", result, b.fileName);
  ok(res, result);
});
