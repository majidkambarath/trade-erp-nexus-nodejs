const { body } = require("express-validator");

exports.stockValidationRules = [
  body("sku")
    .notEmpty()
    .withMessage("SKU is required")
    .isLength({ min: 3, max: 50 })
    .withMessage("SKU must be between 3 and 50 characters"),

  body("itemName")
    .notEmpty()
    .withMessage("Item name is required")
    .isLength({ min: 2, max: 100 })
    .withMessage("Item name must be between 2 and 100 characters"),

  body("category")
    .notEmpty()
    .withMessage("Category is required")
    .isLength({ min: 2, max: 50 })
    .withMessage("Category must be between 2 and 50 characters"),

  body("unitOfMeasure")
    .notEmpty()
    .withMessage("Unit of measure is required")
    .isIn(["Piece", "Kg", "Liter", "Meter", "Box", "Carton"])
    .withMessage("Invalid unit of measure"),

  body("reorderLevel")
    .optional()
    .isNumeric()
    .withMessage("Reorder level must be a number")
    .isFloat({ min: 0 })
    .withMessage("Reorder level must be positive"),

  body("purchasePrice")
    .optional()
    .isNumeric()
    .withMessage("Purchase price must be a number")
    .isFloat({ min: 0 })
    .withMessage("Purchase price must be positive"),

  body("salesPrice")
    .optional()
    .isNumeric()
    .withMessage("Sales price must be a number")
    .isFloat({ min: 0 })
    .withMessage("Sales price must be positive"),

  body("currentStock")
    .optional()
    .isNumeric()
    .withMessage("Current stock must be a number")
    .isFloat({ min: 0 })
    .withMessage("Current stock must be positive"),

  body("status")
    .optional()
    .isIn(["Active", "Inactive"])
    .withMessage("Status must be either Active or Inactive"),

  body("expiryDate")
    .optional()
    .isISO8601()
    .withMessage("Expiry date must be a valid date"),

  body("barcodeQrCode")
    .optional()
    .isLength({ min: 3, max: 50 })
    .withMessage("Barcode/QR code must be between 3 and 50 characters"),
];

exports.stockUpdateValidationRules = [
  body("sku")
    .optional()
    .isLength({ min: 3, max: 50 })
    .withMessage("SKU must be between 3 and 50 characters"),

  body("itemName")
    .optional()
    .isLength({ min: 2, max: 100 })
    .withMessage("Item name must be between 2 and 100 characters"),

  body("category")
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage("Category must be between 2 and 50 characters"),

  body("unitOfMeasure")
    .optional()
    .isIn(["Piece", "Kg", "Liter", "Meter", "Box", "Carton"])
    .withMessage("Invalid unit of measure"),

  body("reorderLevel")
    .optional()
    .isNumeric()
    .withMessage("Reorder level must be a number")
    .isFloat({ min: 0 })
    .withMessage("Reorder level must be positive"),

  body("purchasePrice")
    .optional()
    .isNumeric()
    .withMessage("Purchase price must be a number")
    .isFloat({ min: 0 })
    .withMessage("Purchase price must be positive"),

  body("salesPrice")
    .optional()
    .isNumeric()
    .withMessage("Sales price must be a number")
    .isFloat({ min: 0 })
    .withMessage("Sales price must be positive"),

  body("currentStock")
    .optional()
    .isNumeric()
    .withMessage("Current stock must be a number")
    .isFloat({ min: 0 })
    .withMessage("Current stock must be positive"),

  body("status")
    .optional()
    .isIn(["Active", "Inactive"])
    .withMessage("Status must be either Active or Inactive"),

  body("expiryDate")
    .optional()
    .isISO8601()
    .withMessage("Expiry date must be a valid date"),

  body("barcodeQrCode")
    .optional()
    .isLength({ min: 3, max: 50 })
    .withMessage("Barcode/QR code must be between 3 and 50 characters"),
];
