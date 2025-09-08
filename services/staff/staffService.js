const mongoose = require("mongoose");
const Staff = require("../../models/modules/staffModel");
const AppError = require("../../utils/AppError");
const { extractFileInfo, deleteFromCloudinary } = require("../../middleware/upload");

class StaffService {
  static async createStaff(data, files, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        name,
        designation,
        contactNo,
        idNo,
        joiningDate,
        status,
      } = data;

      // Check if idNo already exists
      const existingIdNo = await Staff.findOne({ idNo }).session(session);
      if (existingIdNo) {
        throw new AppError("ID/Passport number already exists", 400);
      }

      // Generate unique staffId
      const staffId = `STF${new Date().toISOString().slice(0, 4).replace(/-/g, "")}-${Math.floor(Math.random() * 1000) + 100}`;

      // Process file uploads
      const idProofInfo = files.idProof ? extractFileInfo(files.idProof) : null;
      const addressProofInfo = files.addressProof ? extractFileInfo(files.addressProof) : null;

      // Create staff record
      const staff = await Staff.create(
        [
          {
            staffId,
            name,
            designation,
            contactNo: contactNo.trim(),
            idNo: idNo.trim(),
            joiningDate: new Date(joiningDate),
            idProof: idProofInfo?.publicId,
            idProofUrl: idProofInfo?.url,
            addressProof: addressProofInfo?.publicId,
            addressProofUrl: addressProofInfo?.url,
            status: status || "Active",
            createdBy,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      return staff[0];
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async updateStaff(id, data, files, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const currentStaff = await Staff.findById(id).session(session);
      if (!currentStaff) {
        throw new AppError("Staff member not found", 404);
      }

      // Check idNo uniqueness if updating
      if (data.idNo && data.idNo !== currentStaff.idNo) {
        const existingIdNo = await Staff.findOne({
          idNo: data.idNo,
          _id: { $ne: id },
        }).session(session);
        if (existingIdNo) {
          throw new AppError("ID/Passport number already exists", 400);
        }
      }

      // Process file uploads
      const idProofInfo = files.idProof ? extractFileInfo(files.idProof) : null;
      const addressProofInfo = files.addressProof ? extractFileInfo(files.addressProof) : null;

      // Delete old files from Cloudinary if new files are uploaded
      const filesToDelete = [];
      if (idProofInfo && currentStaff.idProof) {
        filesToDelete.push(currentStaff.idProof);
      }
      if (addressProofInfo && currentStaff.addressProof) {
        filesToDelete.push(currentStaff.addressProof);
      }
      if (filesToDelete.length > 0) {
        await deleteFromCloudinary(filesToDelete);
      }

      // Prepare update data
      const updateData = {
        ...data,
        contactNo: data.contactNo ? data.contactNo.trim() : currentStaff.contactNo,
        idNo: data.idNo ? data.idNo.trim() : currentStaff.idNo,
        joiningDate: data.joiningDate ? new Date(data.joiningDate) : currentStaff.joiningDate,
        idProof: idProofInfo ? idProofInfo.publicId : currentStaff.idProof,
        idProofUrl: idProofInfo ? idProofInfo.url : currentStaff.idProofUrl,
        addressProof: addressProofInfo ? addressProofInfo.publicId : currentStaff.addressProof,
        addressProofUrl: addressProofInfo ? addressProofInfo.url : currentStaff.addressProofUrl,
        updatedAt: new Date(),
      };

      const updatedStaff = await Staff.findByIdAndUpdate(id, updateData, {
        new: true,
        runValidators: true,
        session,
      });

      await session.commitTransaction();
      return updatedStaff;
    } catch (error) {
      await session.abortTransaction();
      console.error(`Error updating staff (ID: ${id}):`, error.message);
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async deleteStaff(id) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const staff = await Staff.findById(id).session(session);
      if (!staff) {
        throw new AppError("Staff member not found", 404);
      }

      // Delete associated files from Cloudinary
      const filesToDelete = [];
      if (staff.idProof) filesToDelete.push(staff.idProof);
      if (staff.addressProof) filesToDelete.push(staff.addressProof);
      if (filesToDelete.length > 0) {
        await deleteFromCloudinary(filesToDelete);
      }

      await Staff.findByIdAndDelete(id).session(session);

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async getAllStaff(filters) {
    const query = {};

    if (filters.search) {
      query.$or = [
        { name: new RegExp(filters.search, "i") },
        { designation: new RegExp(filters.search, "i") },
        { idNo: new RegExp(filters.search, "i") },
        { staffId: new RegExp(filters.search, "i") },
      ];
    }

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.designation) {
      query.designation = filters.designation;
    }

    return Staff.find(query).sort({ createdAt: -1 });
  }

  static async getStaffById(id) {
    const staff = await Staff.findById(id);
    if (!staff) throw new AppError("Staff member not found", 404);
    return staff;
  }

  static async getStaffByStaffId(staffId) {
    const staff = await Staff.findOne({ staffId });
    if (!staff) throw new AppError("Staff member not found", 404);
    return staff;
  }

  static async getStaffStats() {
    const stats = await Staff.aggregate([
      {
        $group: {
          _id: null,
          totalStaff: { $sum: 1 },
          activeStaff: {
            $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] },
          },
          inactiveStaff: {
            $sum: { $cond: [{ $eq: ["$status", "Inactive"] }, 1, 0] },
          },
        },
      },
    ]);

    return (
      stats[0] || {
        totalStaff: 0,
        activeStaff: 0,
        inactiveStaff: 0,
      }
    );
  }
}

module.exports = StaffService;