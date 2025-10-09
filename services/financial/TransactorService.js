const mongoose = require("mongoose");
const Transactor = require("../../models/modules/financial/transactorModel");
const AppError = require("../../utils/AppError");

class TransactorService {
  // Create a new transactor
  static async createTransactor(data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { accountName, openingBalance, accountType, status } = data;

      if (!accountName || !accountType) {
        throw new AppError("Account name and type are required", 400);
      }

      // Normalize accountType to lowercase
      const normalizedAccountType = accountType.toLowerCase();
      if (
        !["asset", "liability", "equity", "income", "expense"].includes(
          normalizedAccountType
        )
      ) {
        throw new AppError(`Invalid account type: ${accountType}`, 400);
      }

      // Validate openingBalance
      const validatedOpeningBalance =
        openingBalance !== undefined ? openingBalance : 0;
      if (
        typeof validatedOpeningBalance !== "number" ||
        validatedOpeningBalance < 0
      ) {
        throw new AppError(
          "Opening balance must be a non-negative number",
          400
        );
      }

      const generateAccountCode = async (accountName) => {
        // Validate accountName
        if (!accountName || typeof accountName !== "string") {
          throw new Error("Account name is required for code generation");
        }

        // Generate 3-letter prefix from accountName
        const prefix = accountName
          .replace(/[^a-zA-Z]/g, "") // Remove non-letters
          .slice(0, 3) // Take first 3 letters
          .toUpperCase()
          .padEnd(3, "X"); // Pad with 'X' if less than 3 letters

        if (!/^[A-Z]{3}$/.test(prefix)) {
          throw new Error("Invalid account name for code generation");
        }

        // Find the highest sequence number for this prefix
        const regex = new RegExp(`^${prefix}\\d{3}$`);
        const lastTransactor = await Transactor.findOne({ accountCode: regex })
          .sort({ accountCode: -1 })
          .session(session)
          .exec();

        let sequence = 1;
        if (lastTransactor) {
          const lastSequence = parseInt(lastTransactor.accountCode.slice(-3));
          sequence = lastSequence + 1;
        }
        if (sequence > 999) {
          throw new Error(
            `Maximum accounts (999) reached for prefix ${prefix}`
          );
        }

        return `${prefix}${sequence.toString().padStart(3, "0")}`;
      };

      const transactorDoc = {
        accountCode: await generateAccountCode(accountName),
        accountName,
        accountType: normalizedAccountType,
        openingBalance: validatedOpeningBalance,
        currentBalance: validatedOpeningBalance, // Initialize currentBalance with openingBalance
        isActive: status ? status === "Active" : true,
        createdBy,
      };

      const transactor = await Transactor.create([transactorDoc], { session });
      await session.commitTransaction();
      return this.formatTransactorResponse(transactor[0]);
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Get all transactors with filters and pagination
  static async getAllTransactors(filters = {}) {
    const query = { isActive: { $ne: false } }; // Exclude soft-deleted transactors

    if (filters.accountType) {
      query.accountType = filters.accountType.toLowerCase();
    }
    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [{ accountName: regex }, { accountCode: regex }];
    }

    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 20;
    const skip = (page - 1) * limit;

    const transactors = await Transactor.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("createdBy", "name username");

    const total = await Transactor.countDocuments(query);

    return {
      transactors: transactors.map(this.formatTransactorResponse),
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    };
  }

  // Get transactor by ID
  static async getTransactorById(id) {
    const transactor = await Transactor.findOne({
      _id: id,
      isActive: { $ne: false },
    }).populate("createdBy", "name username");

    if (!transactor) {
      throw new AppError("Transactor not found or deleted", 404);
    }

    return this.formatTransactorResponse(transactor);
  }

  // Update transactor
  static async updateTransactor(id, data, updatedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transactor = await Transactor.findOne({
        _id: id,
        isActive: { $ne: false },
      }).session(session);
      if (!transactor) {
        throw new AppError("Transactor not found or deleted", 404);
      }

      const {
        accountName,
        openingBalance,
        currentBalance,
        accountType,
        status,
      } = data;

      if (accountName) transactor.accountName = accountName;
      if (accountType) {
        const normalizedAccountType = accountType.toLowerCase();
        if (
          !["asset", "liability", "equity", "income", "expense"].includes(
            normalizedAccountType
          )
        ) {
          throw new AppError(`Invalid account type: ${accountType}`, 400);
        }
        transactor.accountType = normalizedAccountType;
      }
      // Allow updating openingBalance with validation
      if (openingBalance !== undefined) {
        if (typeof openingBalance !== "number" || openingBalance < 0) {
          throw new AppError(
            "Opening balance must be a non-negative number",
            400
          );
        }
        transactor.openingBalance = openingBalance;
      }
      // Allow updating currentBalance with validation
      if (currentBalance !== undefined) {
        if (typeof currentBalance !== "number" || currentBalance < 0) {
          throw new AppError(
            "Current balance must be a non-negative number",
            400
          );
        }
        transactor.currentBalance = currentBalance;
      }
      if (status !== undefined)
        transactor.isActive = status === "Active" || status === true;
      transactor.updatedBy = updatedBy;

      await transactor.save({ session });
      await session.commitTransaction();
      return this.formatTransactorResponse(transactor);
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Soft delete transactor
  static async deleteTransactor(id, deletedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transactor = await Transactor.findOne({
        _id: id,
        isActive: { $ne: false },
      }).session(session);
      if (!transactor) {
        throw new AppError("Transactor not found or already deleted", 404);
      }

      // Check if transactor has non-zero current balance
      if (transactor.currentBalance !== 0) {
        throw new AppError(
          "Cannot delete transactor with non-zero balance",
          400
        );
      }

      // Check if transactor is used in any active vouchers
      const voucherCount = await mongoose.model("Voucher").countDocuments({
        $or: [
          { partyId: id },
          { fromAccountId: id },
          { toAccountId: id },
          { "entries.accountId": id },
        ],
        status: { $nin: ["cancelled", "rejected"] },
      });

      if (voucherCount > 0) {
        throw new AppError(
          "Cannot delete transactor with active vouchers",
          400
        );
      }

      transactor.isActive = false;
      transactor.deletedBy = deletedBy;
      transactor.deletedAt = new Date();
      await transactor.save({ session });

      await session.commitTransaction();
      return { message: "Transactor deleted successfully" };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Format transactor for frontend response
  static formatTransactorResponse(transactor) {
    return {
      _id: transactor._id,
      accountCode: transactor.accountCode,
      accountName: transactor.accountName,
      type: transactor.accountType,
      openingBalance: transactor.openingBalance,
      currentBalance: transactor.currentBalance,
      accountType: transactor.accountType,
      status: transactor.isActive ? "Active" : "Inactive",
    };
  }
}

module.exports = TransactorService;
