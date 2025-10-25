const mongoose = require("mongoose");
const Vendor = require("../../models/modules/vendorModel");
const AppError = require("../../utils/AppError");
const Sequence = require("../../models/modules/sequenceModel");

// Helper to get the next sequence number without saving it
const getNextSequenceNumber = async (year, type, session) => {
  try {
    let sequence = await Sequence.findOne({ year, type }).session(session);

    if (!sequence) {
      const [newSequence] = await Sequence.create(
        [{ year, type, usedNumbers: [], deletedNumbers: [] }],
        { session }
      );
      sequence = newSequence;
    }

    if (!sequence) {
      throw new AppError("Failed to initialize sequence document", 500);
    }

    if (sequence.deletedNumbers && sequence.deletedNumbers.length > 0) {
      return Math.min(...sequence.deletedNumbers);
    }

    return sequence.usedNumbers.length > 0
      ? Math.max(...sequence.usedNumbers) + 1
      : 1;
  } catch (error) {
    throw new AppError(
      `Sequence number generation failed: ${error.message}`,
      500
    );
  }
};

// Commit sequence number to usedNumbers after successful vendor creation
const commitSequenceNumber = async (year, type, sequenceNumber, session) => {
  try {
    await Sequence.findOneAndUpdate(
      { year, type },
      {
        $pull: { deletedNumbers: sequenceNumber },
        $addToSet: { usedNumbers: sequenceNumber },
      },
      { session }
    );
  } catch (error) {
    throw new AppError(
      `Failed to commit sequence number: ${error.message}`,
      500
    );
  }
};

// Release a sequence number to deletedNumbers on deletion
const releaseSequenceNumber = async (vendorId, session) => {
  try {
    const year = vendorId.slice(4, 8); // Extract year from VENDYYYYNNN
    const sequenceNumber = parseInt(vendorId.slice(8), 10); // Extract number
    await Sequence.findOneAndUpdate(
      { year, type: "vendor" },
      {
        $pull: { usedNumbers: sequenceNumber },
        $addToSet: { deletedNumbers: sequenceNumber },
      },
      { session }
    );
  } catch (error) {
    throw new AppError(
      `Failed to release sequence number: ${error.message}`,
      500
    );
  }
};

exports.createVendor = async (data) => {
  const {
    vendorName,
    contactPerson,
    email,
    phone,
    address,
    paymentTerms,
    status,
    trnNO,
  } = data;

  // Validate paymentTerms early to avoid sequence allocation
  const validPaymentTerms = [
    "30 days",
    "Net 30",
    "45 days",
    "Net 60",
    "60 days",
  ];
  if (paymentTerms && !validPaymentTerms.includes(paymentTerms)) {
    throw new AppError(
      `Invalid paymentTerms. Must be one of: ${validPaymentTerms.join(", ")}`,
      400
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const currentYear = new Date().getFullYear().toString();
    const sequenceNumber = await getNextSequenceNumber(
      currentYear,
      "vendor",
      session
    );
    const formattedNumber = sequenceNumber.toString().padStart(3, "0"); // Ensure 3 digits
    const newVendorId = `VEND${currentYear}${formattedNumber}`;

    const trimmedPhone = phone
      ? phone.toString().trim().replace(/\s+/g, "")
      : null;
    const trimmedContactPerson = contactPerson
      ? contactPerson.toString().trim().replace(/\s+/g, "")
      : null;

    const vendor = await Vendor.create(
      [
        {
          vendorId: newVendorId,
          vendorName,
          contactPerson: trimmedContactPerson,
          email,
          phone: trimmedPhone,
          address,
          paymentTerms: paymentTerms || "30 days", // Use default if not provided
          status,
          trnNO,
        },
      ],
      { session }
    )[0];

    await commitSequenceNumber(currentYear, "vendor", sequenceNumber, session);
    await session.commitTransaction();
    return vendor;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
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
  const validPaymentTerms = [
    "30 days",
    "Net 30",
    "45 days",
    "Net 60",
    "60 days",
  ];
  if (data.paymentTerms && !validPaymentTerms.includes(data.paymentTerms)) {
    throw new AppError(
      `Invalid paymentTerms. Must be one of: ${validPaymentTerms.join(", ")}`,
      400
    );
  }

  const vendor = await Vendor.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  });
  if (!vendor) throw new AppError("Vendor not found", 404);
  return vendor;
};

exports.deleteVendor = async (id) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const vendor = await Vendor.findByIdAndDelete(id, { session });
    if (!vendor) throw new AppError("Vendor not found", 404);

    await releaseSequenceNumber(vendor.vendorId, session);
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};
