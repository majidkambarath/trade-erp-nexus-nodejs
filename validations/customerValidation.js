const { body } = require("express-validator");

exports.customerValidationRules = [
  body("customerName")
    .notEmpty()
    .withMessage("Customer name is required")
    .isLength({ min: 2, max: 100 })
    .withMessage("Customer name must be between 2 and 100 characters")
    .trim(),

  body("contactPerson")
    .notEmpty()
    .withMessage("Contact person is required")
    .isLength({ min: 2, max: 100 })
    .withMessage("Contact person must be between 2 and 100 characters")
    .trim(),

  body("email")
    .optional()
    .isEmail()
    .withMessage("Please provide a valid email address")
    .normalizeEmail(),

  body("phone")
    .optional()
    .matches(/^\+?\d{10,15}$/)
    .withMessage("Phone number must be 10-15 digits and can start with +"),

//   body("billingAddress")
//     .notEmpty()
//     .withMessage("Billing address is required")
//     .isLength({ min: 10, max: 500 })
//     .withMessage("Billing address must be between 10 and 500 characters")
//     .trim(),

//   body("shippingAddress")
//     .optional()
//     .isLength({ max: 500 })
//     .withMessage("Shipping address cannot exceed 500 characters")
//     .trim(),

  body("creditLimit")
    .optional()
    .isNumeric()
    .withMessage("Credit limit must be a number")
    .custom((value) => {
      if (value < 0) {
        throw new Error("Credit limit cannot be negative");
      }
      return true;
    }),

//   body("paymentTerms")
//     .optional()
//     .isIn(["Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid"])
//     .withMessage("Payment terms must be one of: Net 30, Net 45, Net 60, Cash on Delivery, Prepaid"),

  body("status")
    .optional()
    .isIn(["Active", "Inactive"])
    .withMessage("Status must be either Active or Inactive"),

  body("customerId")
    .optional()
    .matches(/^CUST\d{8}-\d{3}$/)
    .withMessage("Customer ID must follow format: CUST20250101-001"),
];