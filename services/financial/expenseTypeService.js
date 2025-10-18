const ExpenseType = require("../../models/modules/financial/expenseTypeModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");

class ExpenseTypeService {
  static async createExpenseType(data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { name } = data;

      // Check if expense type name already exists
      const existingExpenseType = await ExpenseType.findOne({ name }).session(
        session
      );
      if (existingExpenseType) {
        throw new AppError("Expense type name already exists", 400);
      }

      const expenseType = await ExpenseType.create(
        [
          {
            name,
            createdBy,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      return expenseType[0];
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async getAllExpenseTypes(filters) {
    const query = {};
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || 10;
    const skip = (page - 1) * limit;

    // Search functionality
    if (filters.search) {
      query.name = new RegExp(filters.search, "i");
    }

    const expenseTypes = await ExpenseType.find(query)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const totalExpenseTypes = await ExpenseType.countDocuments(query);
    const totalPages = Math.ceil(totalExpenseTypes / limit);

    return { expenseTypes, totalPages };
  }

  static async getExpenseTypeById(id) {
    const expenseType = await ExpenseType.findById(id);
    if (!expenseType) throw new AppError("Expense type not found", 404);
    return expenseType;
  }

  static async updateExpenseType(id, data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const expenseType = await ExpenseType.findById(id).session(session);
      if (!expenseType) {
        throw new AppError("Expense type not found", 404);
      }

      // Check if new name already exists
      if (data.name && data.name !== expenseType.name) {
        const existingExpenseType = await ExpenseType.findOne({
          name: data.name,
          _id: { $ne: id },
        }).session(session);
        if (existingExpenseType) {
          throw new AppError("Expense type name already exists", 400);
        }
      }

      const updatedExpenseType = await ExpenseType.findByIdAndUpdate(
        id,
        { ...data, updatedBy: createdBy },
        {
          new: true,
          runValidators: true,
          session,
        }
      );

      await session.commitTransaction();
      return updatedExpenseType;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async deleteExpenseType(id) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const expenseType = await ExpenseType.findById(id).session(session);
      if (!expenseType) {
        throw new AppError("Expense type not found", 404);
      }

      await ExpenseType.findByIdAndDelete(id).session(session);
      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }
}

module.exports = ExpenseTypeService;
