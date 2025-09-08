const Category = require("../../models/modules/categoryModel");
const Stock = require("../../models/modules/stockModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");

class CategoryService {
  static async createCategory(data, createdBy) {
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
  }

  static async getAllCategories(filters) {
    const query = {};
    const page = Number(filters.page) || 1;
    const limit = Number(filters.limit) || 10;
    const skip = (page - 1) * limit;

    // Search functionality
    if (filters.search) {
      query.$or = [
        { name: new RegExp(filters.search, "i") },
        { description: new RegExp(filters.search, "i") },
      ];
      if (filters.search.toUpperCase().includes("STATUS:ACTIVE")) {
        query.status = "ACTIVE";
      } else if (filters.search.toUpperCase().includes("STATUS:INACTIVE")) {
        query.status = "INACTIVE";
      }
    }

    // Filter by status
    if (filters.status) {
      query.status = filters.status;
    }

    const categories = await Category.find(query)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });

    const totalCategories = await Category.countDocuments(query);
    const totalPages = Math.ceil(totalCategories / limit);

    return { categories, totalPages };
  }

  static async getCategoryById(id) {
    const category = await Category.findById(id);
    if (!category) throw new AppError("Category not found", 404);
    return category;
  }

  static async updateCategory(id, data, createdBy) {
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
  }

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
          activeCategories: {
            $sum: { $cond: [{ $eq: ["$status", "ACTIVE"] }, 1, 0] },
          },
          inactiveCategories: {
            $sum: { $cond: [{ $eq: ["$status", "INACTIVE"] }, 1, 0] },
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