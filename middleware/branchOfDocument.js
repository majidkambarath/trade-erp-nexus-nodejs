// router.param("id", branchOfDocument(Model)): a head office looking at EVERY branch may approve, change or delete a
// document that belongs to another branch. What that posts (ledger entries, stock movements) must carry the
// DOCUMENT'S branch, not the head office's, so the rest of the request runs writing to the document's own branch.
// A person working in one branch can only reach that branch's documents anyway, so nothing changes for them.
const mongoose = require("mongoose");
const { ambientTenant, runInBranchOf } = require("../utils/tenantContext");

const branchOfDocument = (Model) => async (req, res, next, id) => {
  try {
    const tenant = ambientTenant();
    if (!tenant || tenant.branchView || !mongoose.isValidObjectId(id)) return next();
    const doc = await Model.findById(id).select("branchId").lean();
    return runInBranchOf(doc, () => next());
  } catch (error) {
    return next(error);
  }
};

module.exports = { branchOfDocument };
