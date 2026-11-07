// Authenticates a request to the employee self-service portal (D15). Mirrors middleware/platformAuth.js's
// shape, in the opposite direction: that identity opens no organisation scope because it belongs to none;
// this one is bound to exactly one, so every downstream call runs inside it (runWithTenant), the same way
// authMiddleware.js wraps the rest of the chain in the signed-in Admin's own tenant.
const EmployeeAuthService = require("../services/hr/employeeAuthService");
const Staff = require("../models/modules/staffModel");
const { runWithTenant } = require("../utils/tenantContext");

const authenticateEmployee = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: "Access token is required", errorCode: "MISSING_TOKEN" });
    const user = await EmployeeAuthService.authenticate(token);
    // The branch is read from the Staff row itself, never trusted from the token - the same "the account's
    // database row decides, not the token" rule authenticateToken holds Admin to.
    const staff = await runWithTenant({ companyId: user.companyId }, () => Staff.findById(user.staffId).select("branchId status").lean());
    if (!staff || staff.status !== "Active") {
      return res.status(401).json({ success: false, message: "This employee record is not active", errorCode: "STAFF_INACTIVE" });
    }
    req.employeeUser = user;
    req.employeeStaffId = String(user.staffId);
    return runWithTenant({ companyId: user.companyId, branchId: staff.branchId || "main" }, next);
  } catch (error) {
    res.status(error.statusCode || 401).json({ success: false, message: error.message || "Invalid token", errorCode: error.code || "INVALID_TOKEN" });
  }
};

module.exports = { authenticateEmployee };
