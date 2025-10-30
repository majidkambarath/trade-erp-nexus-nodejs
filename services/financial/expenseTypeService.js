const ExpenseCategory = require("../../models/modules/financial/expenseTypeModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");

class ExpenseCategoryService {
  /* --------------------------------------------------------------
     CREATE – Main or Sub-Category
     -------------------------------------------------------------- */
  static async create(data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { name, parentCategoryId } = data;
      if (!name?.trim()) throw new AppError("Category name is required", 400);

      const trimmedName = name.trim();
      const parent = parentCategoryId ?? null;

      // ---- Uniqueness (handled by index, but we give a nice message) ----
      const existing = await ExpenseCategory.findOne(
        {
          name: trimmedName,
          parentCategory: parent,
        },
        null,
        { session, collation: { locale: "en", strength: 2 } }
      );

      if (existing) {
        throw new AppError(
          parent
            ? `Sub-category "${trimmedName}" already exists under this parent.`
            : `Main category "${trimmedName}" already exists.`,
          400
        );
      }

      const [category] = await ExpenseCategory.create(
        [
          {
            name: trimmedName,
            parentCategory: parent,
            createdBy,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      return category;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  /* --------------------------------------------------------------
     GET ALL – Hierarchical Tree (paginated)
     -------------------------------------------------------------- */
  static async getAll(filters = {}) {
    const { page = 1, limit = 10, search } = filters;
    const skip = (page - 1) * limit;

    const match = {};
    if (search) match.name = new RegExp(search.trim(), "i");

    const [result] = await ExpenseCategory.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },

      // Only root (main) categories for the tree
      { $match: { parentCategory: null } },

      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: Number(limit) },

            // Populate sub-categories in one shot
            {
              $lookup: {
                from: "expensecategories", // <-- matches collection name
                localField: "_id",
                foreignField: "parentCategory",
                as: "subCategories",
              },
            },

            {
              $project: {
                _id: 1,
                name: 1,
                createdAt: 1,
                updatedAt: 1,
                createdBy: 1,
                updatedBy: 1,
                subCategories: {
                  _id: 1,
                  name: 1,
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
            },
          ],
          meta: [{ $count: "total" }],
        },
      },
    ]);

    const total = result.meta[0]?.total || 0;
    return {
      categories: result.data,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /* --------------------------------------------------------------
     GET BY ID (with sub-categories)
     -------------------------------------------------------------- */
  static async getById(id) {
    const cat = await ExpenseCategory.findById(id)
      .populate("subCategories", "name createdAt")
      .lean();

    if (!cat) throw new AppError("Category not found", 404);
    return cat;
  }

  /* --------------------------------------------------------------
     UPDATE
     -------------------------------------------------------------- */
  static async update(id, data, updatedBy) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const cat = await ExpenseCategory.findById(id).session(session);
      if (!cat) throw new AppError("Category not found", 404);

      const { name, parentCategoryId } = data;
      const newName = name?.trim();
      const newParent =
        parentCategoryId !== undefined ? (parentCategoryId || null) : cat.parentCategory;

      // ---- Name change → uniqueness check (exclude self) ----
      if (newName && newName !== cat.name) {
        const conflict = await ExpenseCategory.findOne(
          {
            name: newName,
            parentCategory: newParent,
            _id: { $ne: id },
          },
          null,
          { session, collation: { locale: "en", strength: 2 } }
        );

        if (conflict) {
          throw new AppError(
            newParent
              ? `Sub-category "${newName}" already exists under this parent.`
              : `Main category "${newName}" already exists.`,
            400
          );
        }
      }

      const updateObj = { updatedBy };
      if (newName) updateObj.name = newName;
      if (parentCategoryId !== undefined) updateObj.parentCategory = newParent;

      const updated = await ExpenseCategory.findByIdAndUpdate(id, updateObj, {
        new: true,
        runValidators: true,
        session,
      });

      await session.commitTransaction();
      return updated;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  /* --------------------------------------------------------------
     DELETE – cascade + voucher check
     -------------------------------------------------------------- */
  static async delete(id) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const cat = await ExpenseCategory.findById(id).session(session);
      if (!cat) throw new AppError("Category not found", 404);

      // ---- Check if any voucher references this category ----
      const Voucher = mongoose.model("Voucher");
      const used = await Voucher.countDocuments(
        {
          $or: [
            { expenseCategoryId: id },
            { mainExpenseCategoryId: id },
          ],
        },
        { session }
      );

      if (used > 0) {
        throw new AppError(`Cannot delete – ${used} voucher(s) use this category.`, 400);
      }

      // Delete sub-categories first
      await ExpenseCategory.deleteMany({ parentCategory: id }).session(session);
      await ExpenseCategory.findByIdAndDelete(id).session(session);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }
}

module.exports = ExpenseCategoryService;