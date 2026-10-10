const Category = require("../../models/modules/categoryModel");
const Stock = require("../../models/modules/stockModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");
const { searchRegex, escapeRegex } = require("../../utils/regex");
const { retryTransientTransaction } = require("../../utils/withTransactionSession");

class CategoryService {
  static createCategory = retryTransientTransaction(async (data, createdBy) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { name, description, status } = data;

      // Check if category name already exists
      const existingCategory = await Category.findOne({ name }).session(session);
      if (existingCategory) {
        throw new AppError("Category name already exists", 400);
      }

      const category = await Category.create(
        [
          {
            name,
            description,
            status,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      return category[0];
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  });

  static async getAllCategories(filters) {
    const query = {};
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || 10;
    const skip = (page - 1) * limit;

    // Search functionality. "status:active" / "status:inactive" in the text is a filter, not words to look for in a name
    // (the whole text used to be searched as a name too, so the shortcut found nothing).
    let status = filters.status ? String(filters.status) : "";
    let text = typeof filters.search === "string" ? filters.search : "";
    const shortcut = text.match(/\bstatus:(inactive|active)\b/i);
    if (shortcut) {
      status = status || shortcut[1];
      text = text.replace(shortcut[0], " ");
    }
    text = text.trim();
    if (text) {
      query.$or = [{ name: searchRegex(text) }, { description: searchRegex(text) }];
    }

    // Filter by status. The model keeps "Active" / "Inactive" as the form writes them; older rows may be upper case, so the
    // comparison ignores case (it was an exact "ACTIVE", which matched nothing the screen ever wrote).
    if (status) {
      query.status = new RegExp(`^${escapeRegex(status.trim())}$`, "i");
    }

    const [categories, total] = await Promise.all([
      Category.find(query).skip(skip).limit(limit).sort({ createdAt: -1, _id: -1 }),
      Category.countDocuments(query),
    ]);
    const totalPages = Math.ceil(total / limit);

    return { categories, totalPages, total };
  }

  static async getCategoryById(id) {
    const category = await Category.findById(id);
    if (!category) throw new AppError("Category not found", 404);
    return category;
  }

  static updateCategory = retryTransientTransaction(async (id, data, createdBy) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const category = await Category.findById(id).session(session);
      if (!category) {
        throw new AppError("Category not found", 404);
      }

      // Check if new name already exists
      if (data.name && data.name !== category.name) {
        const existingCategory = await Category.findOne({
          name: data.name,
          _id: { $ne: id },
        }).session(session);
        if (existingCategory) {
          throw new AppError("Category name already exists", 400);
        }
      }

      const updatedCategory = await Category.findByIdAndUpdate(id, data, {
        new: true,
        runValidators: true,
        session,
      });

      await session.commitTransaction();
      return updatedCategory;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  });

  static async deleteCategory(id) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const category = await Category.findById(id).session(session);
      if (!category) {
        throw new AppError("Category not found", 404);
      }

      // Check if category is used in any stock items
      const stockItems = await Stock.find({ category: id }).session(session);
      if (stockItems.length > 0) {
        throw new AppError("Cannot delete category with associated stock items", 400);
      }

      await Category.findByIdAndDelete(id).session(session);
      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async getCategoryStats() {
    const stats = await Category.aggregate([
      {
        $group: {
          _id: null,
          totalCategories: { $sum: 1 },
          // "Active" is what the model and the form write; the comparison ignores case so an older "ACTIVE" counts too
          activeCategories: {
            $sum: { $cond: [{ $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "ACTIVE"] }, 1, 0] },
          },
          inactiveCategories: {
            $sum: { $cond: [{ $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "INACTIVE"] }, 1, 0] },
          },
        },
      },
    ]);

    return (
      stats[0] || {
        totalCategories: 0,
        activeCategories: 0,
        inactiveCategories: 0,
      }
    );
  }
}

module.exports = CategoryService;