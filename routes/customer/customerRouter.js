const express = require("express");
const {
  customerValidationRules,
} = require("../../validations/customerValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const CustomerController = require("../../controllers/customer/customerController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

router.use(authenticateToken);

router.get("/stats", requirePermission(["sales.view","accounts.view"]), CustomerController.getCustomerStats);
router.get("/search", requirePermission(["sales.view","accounts.view"]), CustomerController.searchCustomers);
router.get("/status/:status", requirePermission(["sales.view","accounts.view"]), CustomerController.getCustomersByStatus);
router.get(
  "/customer-id/:customerId", requirePermission(["sales.view","accounts.view"]),
  CustomerController.getCustomerByCustomerId
);

router.get("/customers", requirePermission(["sales.view","accounts.view"]), CustomerController.getAllCustomers);
router.post("/", requirePermission("sales.create"), CustomerController.createCustomer);

router.get("/:id", requirePermission(["sales.view","accounts.view"]), CustomerController.getCustomerById);
router.put("/:id", requirePermission("sales.edit"), CustomerController.updateCustomer);
router.patch("/:id/stats", requirePermission("accounts.manage"), CustomerController.updateCustomerStats);
router.delete("/:id", requirePermission("sales.delete"), CustomerController.deleteCustomer);

module.exports = router;
