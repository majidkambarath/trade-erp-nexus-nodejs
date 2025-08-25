// stockValidation.js
const { body, param } = require("express-validator");

exports.stockValidationRules = [
  body("sku").notEmpty().withMessage("SKU is required"),
  body("itemName").notEmpty().withMessage("Item name is required"),
  body("category").notEmpty().withMessage("Category is required"),
  body("unitOfMeasure").notEmpty().withMessage("Unit of measure is required"),
  body("currentStock")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Current stock must be a non-negative integer"),
  body("reorderLevel")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Reorder level must be a non-negative integer"),
  body("purchasePrice")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Purchase price must be a non-negative number"),
  body("salesPrice")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Sales price must be a non-negative number"),
];

exports.stockUpdateValidationRules = [
  body("sku").optional().notEmpty().withMessage("SKU cannot be empty"),
  body("itemName").optional().notEmpty().withMessage("Item name cannot be empty"),
  body("category").optional().notEmpty().withMessage("Category cannot be empty"),
  body("unitOfMeasure")
    .optional()
    .notEmpty()
    .withMessage("Unit of measure cannot be empty"),
  body("currentStock")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Current stock must be a non-negative integer"),
  body("reorderLevel")
    .optional()
    .isInt({ min: 0 })
    .withMessage("Reorder level must be a non-negative integer"),
  body("purchasePrice")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Purchase price must be a non-negative number"),
  body("salesPrice")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Sales price must be a non-negative number"),
];

// New validation for quantity update
exports.stockQuantityValidationRules = [
  param("id").isMongoId().withMessage("Invalid stock ID"),
  body("quantity")
    .isInt({ min: 0 })
    .withMessage("Quantity must be a non-negative integer"),
  body("reason").optional().isString().withMessage("Reason must be a string"),
];