const { body } = require("express-validator");

const staffValidationRules = () => [
  body("name").trim().notEmpty().withMessage("Full name is required"),
  body("designation").trim().notEmpty().withMessage("Designation is required"),
  body("contactNo")
    .trim()
    .notEmpty()
    .withMessage("Contact number is required")
    .matches(/^\+?\d{10,15}$/)
    .withMessage("Invalid contact number format"),
  body("idNo")
    .trim()
    .notEmpty()
    .withMessage("ID/Passport number is required"),
  body("joiningDate")
    .notEmpty()
    .withMessage("Joining date is required")
    .isDate()
    .withMessage("Invalid date format"),
  body("status")
    .optional()
    .isIn(["Active", "Inactive"])
    .withMessage("Invalid status"),
];

const staffUpdateValidationRules = () => [
  body("name").optional().trim().notEmpty().withMessage("Full name cannot be empty"),
  body("designation").optional().trim().notEmpty().withMessage("Designation cannot be empty"),
  body("contactNo")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Contact number cannot be empty")
    .matches(/^\+?\d{10,15}$/)
    .withMessage("Invalid contact number format"),
  body("idNo")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("ID/Passport number cannot be empty"),
  body("joiningDate")
    .optional()
    .notEmpty()
    .withMessage("Joining date cannot be empty")
    .isDate()
    .withMessage("Invalid date format"),
  body("status")
    .optional()
    .isIn(["Active", "Inactive"])
    .withMessage("Invalid status"),
];

module.exports = {
  staffValidationRules,
  staffUpdateValidationRules,
};