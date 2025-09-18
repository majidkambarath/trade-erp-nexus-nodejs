const VendorService = require("../../services/vendor/vendorService");
const catchAsync = require("../../utils/catchAsync");

exports.createVendor = catchAsync(async (req, res) => {
  const vendor = await VendorService.createVendor(req.body);
  res.status(201).json({ success: true, data: vendor });
});

exports.getAllVendors = catchAsync(async (req, res) => {
  const { search, status, paymentTerms } = req.query;
  const vendors = await VendorService.getAllVendors({
    search,
    status,
    paymentTerms,
  });
  res.json({ success: true, data: vendors });
});

exports.getVendorById = catchAsync(async (req, res) => {
  const vendor = await VendorService.getVendorById(req.params.id);
  res.json({ success: true, data: vendor });
});

exports.updateVendor = catchAsync(async (req, res) => {
  const vendor = await VendorService.updateVendor(req.params.id, req.body);
  res.json({ success: true, data: vendor });
});

exports.deleteVendor = catchAsync(async (req, res) => {
  await VendorService.deleteVendor(req.params.id);
  res.json({ success: true, message: "Vendor deleted successfully" });
});
