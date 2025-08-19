const Vendor = require("../../models/modules/vendorModel");
const AppError = require("../../utils/AppError");

exports.createVendor = async (data) => {
  const { vendorId, vendorName, contactPerson, email, phone, address, paymentTerms, status } = data;
  const newVendorId =
    vendorId ||
    `VEND${new Date().toISOString().slice(0, 5).replace(/-/g, "")}-${Math.floor(Math.random() * 1000) + 100}`;

  const vendor = await Vendor.create({
    vendorId: newVendorId,
    vendorName,
    contactPerson,
    email,
    phone,
    address,
    paymentTerms,
    status,
  });

  return vendor;
};

exports.getAllVendors = async (filters) => {
  const query = {};
  if (filters.search) {
    query.$or = [
      { vendorId: new RegExp(filters.search, "i") },
      { vendorName: new RegExp(filters.search, "i") },
      { contactPerson: new RegExp(filters.search, "i") },
      { email: new RegExp(filters.search, "i") },
    ];
  }
  if (filters.status) query.status = filters.status;
  if (filters.paymentTerms) query.paymentTerms = filters.paymentTerms;

  return Vendor.find(query).sort({ createdAt: -1 });
};

exports.getVendorById = async (id) => {
  const vendor = await Vendor.findById(id);
  if (!vendor) throw new AppError("Vendor not found", 404);
  return vendor;
};

exports.updateVendor = async (id, data) => {
  const vendor = await Vendor.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!vendor) throw new AppError("Vendor not found", 404);
  return vendor;
};

exports.deleteVendor = async (id) => {
  const vendor = await Vendor.findByIdAndDelete(id);
  if (!vendor) throw new AppError("Vendor not found", 404);
};
