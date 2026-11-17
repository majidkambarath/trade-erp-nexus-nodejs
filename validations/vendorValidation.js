const { body } = require("express-validator");

exports.vendorValidationRules = [
  body("vendorName").trim().notEmpty().withMessage("Vendor name is required"),
  // optional: a blank contact person is allowed; a typed one is still length-checked
  body("contactPerson").optional({ values: "falsy" }).trim().isLength({ min: 2, max: 100 }).withMessage("Contact person must be between 2 and 100 characters"),
  body("address").trim().notEmpty().withMessage("Address is required"),
  body("email").optional().isEmail().withMessage("Invalid email format"),
  body("phone")
    .optional()
    .matches(/^\+?\d{10,15}$/)
    .withMessage("Invalid phone number format"),
  // body("paymentTerms")
  //   .optional()
  //   .isIn(["30 days", "Net 30", "45 days", "Net 60", "60 days"])
  //   .withMessage("Invalid payment terms"),
  // body("status")
  //   .optional()
  //   .isIn(["Compliant", "Non-compliant", "Pending", "Expired"])
  //   .withMessage("Invalid status"),
];
