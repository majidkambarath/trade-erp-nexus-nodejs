const mongoose = require("mongoose");
const Vendor = require("../../models/modules/vendorModel");
const AppError = require("../../utils/AppError");
const Sequence = require("../../models/modules/sequenceModel");
const PartyAccounts = require("../financial/partyAccounts");
const PartyMaster = require("../masters/partyMasterService");
const { searchRegex } = require("../../utils/regex");

const tidyName = (v) => (v ? v.toString().trim().replace(/\s+/g, " ") : null); // "Omar  Ali" -> "Omar Ali"

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

// `groupId` files the vendor's ledger account in that group instead of the posting-map one (the
// account form creates a vendor straight into a chosen Payables group).
exports.createVendor = async (data, { groupId } = {}) => {
  const {
    vendorName,
    contactPerson,
    email,
    phone,
    address,
    status,
    participantId,
  } = data;

  // Validate terms, VAT/TRN, contacts, bank accounts and documents early to avoid sequence allocation
  const master = await PartyMaster.prepare("vendor", data);

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

    // master carries vat / trnNO / paymentTerms / credit / contacts / bankAccounts / documents,
    // and the primary contact's name, email and phone when those were left blank
    const phoneText = phone || master.phone;
    const trimmedPhone = phoneText
      ? phoneText.toString().trim().replace(/\s+/g, "")
      : null;
    const trimmedContactPerson = tidyName(contactPerson || master.contactPerson);

    const [vendor] = await Vendor.create(
      [
        {
          vendorId: newVendorId,
          vendorName,
          contactPerson: trimmedContactPerson,
          email: email || master.email,
          phone: trimmedPhone,
          website: master.website,
          address,
          status,
          participantId: participantId ? String(participantId).trim() : undefined, // Peppol id (the model has always had it)
          vat: master.vat,
          trnNO: master.trnNO,
          paymentTerms: master.paymentTerms, // 30 days when not provided
          credit: master.credit,
          contacts: master.contacts,
          bankAccounts: master.bankAccounts,
          documents: master.documents,
        },
      ],
      { session }
    );

    await commitSequenceNumber(currentYear, "vendor", sequenceNumber, session);
    await session.commitTransaction();
    await PartyMaster.finish("vendor", vendor, master);
    await PartyAccounts.onPartyCreated("Vendor", vendor, { groupId, strict: Boolean(groupId) }); // its ledger account appears in the chart
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
      { vendorId: searchRegex(filters.search) },
      { vendorName: searchRegex(filters.search) },
      { contactPerson: searchRegex(filters.search) },
      { email: searchRegex(filters.search) },
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
  const existing = mongoose.isValidObjectId(id) ? await Vendor.findById(id).lean() : null;
  if (!existing) throw new AppError("Vendor not found", 404);
  // What an edit may not write: the vendor's code, the running balance and the record's own bookkeeping belong to the system.
  for (const key of ["_id", "__v", "companyId", "vendorId", "cashBalance", "enrollDate", "createdAt", "updatedAt"]) delete data[key];
  // VAT/TRN, terms, contacts, bank accounts and documents: checked and merged in with the legacy
  // fields kept in step (trnNO, paymentTerms)
  const master = await PartyMaster.prepare("vendor", data, { existing });
  delete data.vat;
  delete data.credit;
  Object.assign(data, master);

  const before = data.vendorName !== undefined ? { vendorName: existing.vendorName } : null;
  const vendor = await Vendor.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  });
  if (!vendor) throw new AppError("Vendor not found", 404);
  await PartyMaster.finish("vendor", vendor, master);
  if (before && before.vendorName !== vendor.vendorName) {
    await PartyAccounts.onPartyRenamed("Vendor", before.vendorName, vendor.vendorName);
  }
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
    await PartyAccounts.onPartyDeleted("Vendor", vendor.vendorName);
    await PartyMaster.discardFiles("vendor", vendor._id).catch((err) => console.error("[party-files] could not remove the vendor's files:", err.message));
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};
