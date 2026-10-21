// The queue of questions Zarvia AI could not answer, read across every organisation.
//
// Console-side, so it opens no organisation scope: SupportRequest is not tenant scoped, and reading
// one queue over all of them is the whole point. Nothing here reads a client's business data - a
// request carries the question, the screen, the refusal code and the few turns before it, which is
// what makes it answerable without going into their books.
const AppError = require("../../utils/appError");
const { SupportRequest, STATUSES } = require("../../models/platform/supportRequestModel");

const OPEN_STATES = ["NEW", "OPEN"];

class SupportQueueService {
  /** Newest first. `status=open` is the worklist: everything nobody has finished with. */
  static async list({ status = "", organisation = "", limit = 100 } = {}) {
    const q = {};
    if (status === "open") q.status = { $in: OPEN_STATES };
    else if (status && STATUSES.includes(status)) q.status = status;
    if (organisation) q.organisation = String(organisation).toLowerCase();
    const rows = await SupportRequest.find(q)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 300))
      .select("-transcript");
    const counts = await SupportRequest.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    return {
      rows,
      counts: counts.reduce((acc, c) => ({ ...acc, [c._id]: c.n }), {}),
      waiting: rows.filter((r) => OPEN_STATES.includes(r.status)).length,
    };
  }

  static async get(id) {
    const row = await SupportRequest.findById(id);
    if (!row) throw new AppError("That support request was not found.", 404, "NOT_FOUND");
    return row;
  }

  /**
   * Take it, answer it, or close it. The reply is recorded here and nothing sends it: there is no
   * route back into the person's assistant panel yet, so claiming to have replied would be a lie.
   * Answer them however you already do, and record what you said.
   */
  static async update(id, { status = "", assignedTo = "", reply = "" } = {}, by = "") {
    const row = await this.get(id);
    if (status) {
      if (!STATUSES.includes(status)) throw new AppError("That is not a status.", 400, "STATUS_INVALID");
      row.status = status;
    }
    if (assignedTo !== undefined && assignedTo !== "") row.assignedTo = String(assignedTo).slice(0, 200);
    if (reply) {
      row.reply = String(reply).slice(0, 4000);
      row.repliedAt = new Date();
      if (!status) row.status = "ANSWERED";
    }
    if (!row.assignedTo && by) row.assignedTo = by;
    await row.save();
    return row;
  }
}

module.exports = SupportQueueService;
