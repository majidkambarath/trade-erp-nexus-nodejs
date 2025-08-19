const express = require("express");
const {
  customerValidationRules,
} = require("../../validations/customerValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const CustomerController = require("../../controllers/customer/customerController");

const router = express.Router();

router.use(authenticateToken);


router.get("/stats", CustomerController.getCustomerStats);
router.get("/search", CustomerController.searchCustomers);
router.get("/status/:status", CustomerController.getCustomersByStatus);
router.get("/customer-id/:customerId", CustomerController.getCustomerByCustomerId);

router.get("/customers", CustomerController.getAllCustomers);
router.post(
  "/",
  validate(customerValidationRules),
  CustomerController.createCustomer
);

router.get("/:id", CustomerController.getCustomerById);
router.put(
  "/:id",
  validate(customerValidationRules),
  CustomerController.updateCustomer
);
router.patch("/:id/stats", CustomerController.updateCustomerStats);
router.delete("/:id", CustomerController.deleteCustomer);

module.exports = router;
