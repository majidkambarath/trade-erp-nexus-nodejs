const express = require("express");
const { requirePermission } = require("../../middleware/permissionGate");
const l = require("../../controllers/hr/leaveController");

// Mounted under /api/v1/hr. Every param here is its OWN name, never :id - the parent router
// (routes/hr/hrRoutes.js) keys router.param("id", branchOfDocument(Staff)), and a LeaveRequest is not a
// Staff document (the same collision already caught on contracts, statutory-rules and gratuity accruals).
const asId = (req, res, next) => { req.params.id = req.params.requestId; next(); };

// Submitting and reading one's own/the team's requests is hr.leave; deciding one is hr.approve (D13: a
// leave request is a third kind in the SAME approvals queue a trade document or a voucher already uses,
// so it is gated the same way - holding the approve action, not the leave action).
const router = express.Router();

router.get("/leave-requests", requirePermission("hr.leave"), l.list);
router.get("/leave-requests/balance", requirePermission("hr.leave"), l.balance);
router.get("/leave-requests/:requestId", requirePermission("hr.leave"), asId, l.get);
router.post("/leave-requests", requirePermission("hr.leave"), l.submit);
router.post("/leave-requests/:requestId/decide", requirePermission("hr.approve"), asId, l.decide);
router.post("/leave-requests/:requestId/cancel", requirePermission("hr.leave"), asId, l.cancel);

module.exports = router;
