// services/financial/expenseCategoryService.js
const { ExpenseCategory } = require("../../models/modules/financial/financialModels");
const AppError = require("../../utils/AppError");

class ExpenseCategoryService {
  // Create expense category
  static async createCategory(data, createdBy) {
    const { categoryName, categoryCode, parentCategoryId, description, monthlyBudget, yearlyBudget } = data;

    // Check if category code already exists
    const existingCategory = await ExpenseCategory.findOne({
      $or: [{ categoryCode }, { categoryName }]
    });

    if (existingCategory) {
      throw new AppError('Category code or name already exists', 400);
    }

    // Determine level based on parent
    let level = 0;
    if (parentCategoryId) {
      const parentCategory = await ExpenseCategory.findById(parentCategoryId);
      if (!parentCategory) {
        throw new AppError('Parent category not found', 404);
      }
      level = parentCategory.level + 1;
    }

    const categoryData = {
      categoryName,
      categoryCode,
      parentCategoryId,
      level,
      description,
      monthlyBudget: monthlyBudget || 0,
      yearlyBudget: yearlyBudget || 0,
      createdBy
    };

    const category = await ExpenseCategory.create(categoryData);
    return category;
  }

  // Get all categories
  static async getAllCategories(filters = {}) {
    const query = {};
    
    if (filters.isActive !== undefined) query.isActive = filters.isActive;
    if (filters.level !== undefined) query.level = filters.level;

    const categories = await ExpenseCategory.find(query)
      .populate('parentCategoryId', 'categoryName categoryCode')
      .sort({ categoryCode: 1 });

    return categories;
  }

  // Get category by ID
  static async getCategoryById(id) {
    const category = await ExpenseCategory.findById(id)
      .populate('parentCategoryId', 'categoryName categoryCode')
      .populate('defaultAccountId', 'accountName accountCode');

    if (!category) {
      throw new AppError('Category not found', 404);
    }

    return category;
  }

  // Update category
  static async updateCategory(id, data) {
    const category = await ExpenseCategory.findByIdAndUpdate(
      id,
      { ...data, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );

    if (!category) {
      throw new AppError('Category not found', 404);
    }

    return category;
  }

  // Delete category
  static async deleteCategory(id) {
    // Check if category has child categories
    const hasChildren = await ExpenseCategory.findOne({ parentCategoryId: id });
    
    if (hasChildren) {
      throw new AppError('Cannot delete category with child categories', 400);
    }

    const category = await ExpenseCategory.findByIdAndDelete(id);
    
    if (!category) {
      throw new AppError('Category not found', 404);
    }

    return { message: 'Category deleted successfully' };
  }
}

module.exports = ExpenseCategoryService;