const mongoose = require("mongoose");
const Staff = require("../../models/modules/staffModel");
const AppError = require("../../utils/AppError");
const { extractFileInfo, deleteFromCloudinary } = require("../../middleware/upload");
const { searchRegex } = require("../../utils/regex");
const NumberSeriesService = require("../core/numberSeriesService");
const UsageService = require("../core/usageService");

const Admin = require("../../models/core/adminModel");

class StaffService {
  /**
   * The optional link from an employee to the sign-in account they use. Most employees have none - they are
   * never Admin rows (that is what the `users` limit counts) - but a process order's step records its
   * assignee as an ACCOUNT id, so this is the bridge labour costing crosses to find a person's cost rate.
   *
   * Checked against THIS organisation: Admin carries companyId and is tenant-scoped, so a scoped lookup
   * cannot resolve a stranger's account, and an id that names one is refused rather than quietly stored.
   */
  static async assertAdminLink(adminId, session = null) {
    if (!adminId) return null;
    if (!mongoose.isValidObjectId(adminId)) throw new AppError("That sign-in account does not exist", 400, "ADMIN_NOT_FOUND");
    const q = Admin.findById(adminId).select("_id");
    const found = await (session ? q.session(session) : q);
    if (!found) throw new AppError("That sign-in account does not exist", 400, "ADMIN_NOT_FOUND");
    return found._id;
  }

  /** The structured department, if one was named - checked against the organisation's own master. */
  static async assertDepartment(departmentId, session = null) {
    if (!departmentId) return null;
    const Department = require("../../models/modules/hr/departmentModel");
    if (!mongoose.isValidObjectId(departmentId)) throw new AppError("That department does not exist", 400, "DEPARTMENT_NOT_FOUND");
    const q = Department.findById(departmentId).select("_id name");
    const found = await (session ? q.session(session) : q);
    if (!found) throw new AppError("That department does not exist", 400, "DEPARTMENT_NOT_FOUND");
    return found;
  }

  /** Who this person reports to - another employee, never themselves. */
  static async assertManager(managerId, selfId, session = null) {
    if (!managerId) return null;
    if (!mongoose.isValidObjectId(managerId)) throw new AppError("That manager does not exist", 400, "MANAGER_NOT_FOUND");
    if (selfId && String(managerId) === String(selfId)) throw new AppError("A person cannot report to themselves", 400, "MANAGER_IS_SELF");
    const q = Staff.findById(managerId).select("_id");
    const found = await (session ? q.session(session) : q);
    if (!found) throw new AppError("That manager does not exist", 400, "MANAGER_NOT_FOUND");
    return found._id;
  }

  static async createStaff(data, files, createdBy) {
    // HR's meter, before anything is written or uploaded. It sits HERE rather than on the route so that both
    // doors onto this collection are counted - the new /hr routes and the legacy /staff ones - and an
    // organisation cannot add its 51st employee through the older URL. It is a no-op for an organisation that
    // was never sold HR, which is every existing customer: see UsageService.assertEmployeeRoom.
    await UsageService.assertEmployeeRoom();

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
        department,
        email,
        nationality,
        adminId,
        departmentId,
        managerId,
      } = data;

      // what a staff record cannot be without (text, not an object or a missing field: that used to end in a 500)
      for (const [label, value] of [["Name", name], ["Designation", designation], ["Contact number", contactNo], ["ID/Passport number", idNo]]) {
        if (typeof value !== "string" || !value.trim()) throw new AppError(`${label} is required`, 400, "VALIDATION_ERROR");
      }

      await StaffService.assertAdminLink(adminId, session);
      const departmentRow = await StaffService.assertDepartment(departmentId, session);
      await StaffService.assertManager(managerId, null, session);

      // Check if idNo already exists
      const existingIdNo = await Staff.findOne({ idNo }).session(session);
      if (existingIdNo) {
        throw new AppError("ID/Passport number already exists", 400);
      }

      // The employee code, from the one engine in the product allowed to hand a number out (one atomic $inc
      // per series, inside this transaction, with the IssuedNumber register behind it).
      //
      // It replaced `STF${year}-${Math.floor(Math.random() * 1000) + 100}`. Against the unique index on
      // staffId, 900 possible suffixes gave a company of forty staff a better-than-even chance of a
      // collision it could do nothing about - and CLAUDE.md's rule is explicit that a number never comes
      // from Math.random() or a count. EMP counts continuously and prints no year: EMP-0001, EMP-0002.
      const staffId = await NumberSeriesService.allocate("EMP", new Date(), { session, docType: "Staff" });

      // Process file uploads
      // (a plain JSON request carries no files at all: req.files is then undefined)
      const idProofInfo = files?.idProof ? extractFileInfo(files.idProof) : null;
      const addressProofInfo = files?.addressProof ? extractFileInfo(files.addressProof) : null;

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
            // The structured department's own name is also written into the free-text field, so nothing
            // that already reads `department` as a string needs to change - unless the caller typed their
            // own text, which wins (an explicit choice over a derived one).
            department: typeof department === "string" && department.trim() ? department.trim() : departmentRow?.name,
            departmentId: departmentRow?._id || undefined,
            managerId: managerId || undefined,
            email: typeof email === "string" ? email.trim() : undefined,
            nationality: typeof nationality === "string" && nationality.trim() ? nationality.trim().toUpperCase() : undefined,
            adminId: adminId || undefined,
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

      if ("adminId" in data && data.adminId) await StaffService.assertAdminLink(data.adminId, session);
      let departmentRow = null;
      if ("departmentId" in data && data.departmentId) departmentRow = await StaffService.assertDepartment(data.departmentId, session);
      if ("managerId" in data && data.managerId) await StaffService.assertManager(data.managerId, id, session);

      // Process file uploads
      const idProofInfo = files?.idProof ? extractFileInfo(files.idProof) : null;
      const addressProofInfo = files?.addressProof ? extractFileInfo(files.addressProof) : null;

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

      // Prepare update data.
      //
      // A WHITELIST, NOT THE REQUEST BODY. This used to be `{ ...data, ... }`, which copied whatever arrived
      // straight onto the document: a caller could set `staffId` (the allocated employee code, and a unique
      // index), `branchId` (moving a person into a branch to be read by people who should not see them),
      // `createdBy`, `createdAt` - and, once HR arrived, `adminId`, which links an employee to a sign-in
      // account. That is the mass-assignment shape `utils/adminPermissions.js` withoutSystemFields exists to
      // refuse, and the transaction and voucher services were already swept for it.
      //
      // Fails closed: a field not named here cannot be written, so the next field added to the schema is not
      // editable by accident.
      const EDITABLE = ["name", "designation", "department", "email", "nationality", "status", "adminId"];
      const updateData = {
        ...Object.fromEntries(EDITABLE.filter((k) => k in data).map((k) => [k, data[k]])),
        // "" clears the link (a real ObjectId cast failure otherwise, the same explicit-null pattern
        // exitDate below already uses) - never left as an empty string for Mongoose to choke on.
        ...("departmentId" in data ? { departmentId: data.departmentId || null } : {}),
        ...("managerId" in data ? { managerId: data.managerId || null } : {}),
        // A structured department picked on this save also updates the free-text field, unless the
        // caller's OWN text was sent in the same request (an explicit choice over a derived one).
        ...(departmentRow && !(typeof data.department === "string" && data.department.trim()) ? { department: departmentRow.name } : {}),
        contactNo: data.contactNo ? data.contactNo.trim() : currentStaff.contactNo,
        idNo: data.idNo ? data.idNo.trim() : currentStaff.idNo,
        joiningDate: data.joiningDate ? new Date(data.joiningDate) : currentStaff.joiningDate,
        // The day somebody left. Explicitly nullable: "" or null clears it (they came back, or it was a
        // mistake), which a plain truthiness check would have silently ignored.
        exitDate: "exitDate" in data ? (data.exitDate ? new Date(data.exitDate) : null) : currentStaff.exitDate,
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
        { name: searchRegex(filters.search) },
        { designation: searchRegex(filters.search) },
        { idNo: searchRegex(filters.search) },
        { staffId: searchRegex(filters.search) },
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
    const staff = await Staff.findById(id).populate("managerId", "name").lean();
    if (!staff) throw new AppError("Staff member not found", 404);
    // `managerId` populated carries the reporting line's NAME for the page to show without a second
    // call; `managerId` itself stays the id a form needs to preselect it - both from one field, the
    // same way a trade document's populated party is read elsewhere in the app.
    if (staff.managerId && typeof staff.managerId === "object") {
      staff.managerName = staff.managerId.name;
      staff.managerId = String(staff.managerId._id);
    }
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