const { body } = require("express-validator");

exports.uomValidationRules = [
  body("unitName")
    .notEmpty()
    .withMessage("Unit name is required")
    .isLength({ min: 2, max: 50 })
    .withMessage("Unit name must be between 2-50 characters")
    .matches(/^[a-zA-Z\s]+$/)
    .withMessage("Unit name can only contain letters and spaces"),
    
  body("shortCode")
    .notEmpty()
    .withMessage("Short code is required")
    .isLength({ min: 1, max: 10 })
    .withMessage("Short code must be between 1-10 characters")
    .matches(/^[a-zA-Z0-9]+$/)
    .withMessage("Short code can only contain letters and numbers"),
    
  body("type")
    .isIn(["Base", "Derived"])
    .withMessage("Type must be either Base or Derived"),
    
  body("category")
    .isIn(["Weight", "Volume", "Quantity", "Packaging", "Length", "Area"])
    .withMessage("Invalid category"),
    
  body("status")
    .optional()
    .isIn(["Active", "Inactive"])
    .withMessage("Status must be either Active or Inactive"),
];

exports.uomConversionValidationRules = [
  body("fromUOM")
    .notEmpty()
    .withMessage("From UOM is required")
    .isMongoId()
    .withMessage("Invalid From UOM ID"),
    
  body("toUOM")
    .notEmpty()
    .withMessage("To UOM is required")
    .isMongoId()
    .withMessage("Invalid To UOM ID"),
    
  body("conversionRatio")
    .isFloat({ min: 0.001 })
    .withMessage("Conversion ratio must be a positive number greater than 0.001"),
    
  body("category")
    .optional()
    .isIn(["Weight", "Volume", "Quantity", "Packaging", "Length", "Area"])
    .withMessage("Invalid category"),
    
  body("status")
    .optional()
    .isIn(["Active", "Inactive"])
    .withMessage("Status must be either Active or Inactive"),
];