const mongoose = require("mongoose");

const expenseCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Category name is required"],
      trim: true,
      maxlength: [100, "Category name cannot exceed 100 characters"],
    },
    parentCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExpenseCategory",
      default: null,
      // **Parent must be a main category**
      validate: {
        validator: async function (v) {
          if (!v) return true;                       // no parent → OK
          const doc = await this.constructor.findOne({
            _id: v,
            parentCategory: null,
          });
          return !!doc;
        },
        message: "Parent must be a main category",
      },
    },
    isMainCategory: {
      type: Boolean,
      default: function () {
        return this.parentCategory === null;
      },
    },
    createdBy: { type: String, required: true },
    updatedBy: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    // **Collection name must match the one used elsewhere**
    collection: "expensecategories",
  }
);

/* -------------------------------------------------
   Virtual – sub-categories
   ------------------------------------------------- */
expenseCategorySchema.virtual("subCategories", {
  ref: "ExpenseCategory",
  localField: "_id",
  foreignField: "parentCategory",
  justOne: false,
});

/* -------------------------------------------------
   Keep isMainCategory in sync
   ------------------------------------------------- */
expenseCategorySchema.pre("save", function (next) {
  this.isMainCategory = this.parentCategory === null;
  next();
});

/* -------------------------------------------------
   Unique compound index (case-insensitive)
   – name + parentCategory
   – allows many documents with parentCategory: null
     as long as the name is different
   ------------------------------------------------- */
expenseCategorySchema.index(
  { name: 1, parentCategory: 1 },
  {
    unique: true,
    collation: { locale: "en", strength: 2 }, // case-insensitive
    background: true,
  }
);

module.exports = mongoose.model("ExpenseCategory", expenseCategorySchema);