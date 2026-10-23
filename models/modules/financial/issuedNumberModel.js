const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// One row per document number ever given out, written in the same transaction as the allocation
// (services/core/numberSeriesService.js). Before this, a number that had been issued and then deleted
// left no trace at all: the counter had moved on, the sequence had a hole, and nothing in the product
// could say why. India's guidance is to keep records of cancelled and unused numbers rather than quietly
// close the gap, and this is that record.
//
// It does three jobs at once:
//   - the deleted-numbers register (status released / cancelled, with who, when and why)
//   - the free list for a type that allows re-use: the lowest `released` row, claimed by one atomic
//     compare-and-set, rather than a second copy of the same fact in an array on the counter
//   - the continuity report (utils/voucherTypes.js gapsOf)
//
// It also means a number never has to be PARSED to find out which counter minted it. Nothing in
// production code parses a document number today, and this keeps it that way.
const issuedNumberSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },

    // Which counter it came from. `label` is the printed middle segment and is the counter's identity
    // (see utils/voucherTypes.js labelOf) - the fiscal year's code, or "ALL" for a continuous series.
    series: { type: String, required: true, uppercase: true, trim: true },
    label: { type: String, required: true, trim: true },
    // null for a number typed outside this series' own format ("INV/OLD/77" carried over from a paper
    // book): it is recorded, but it belongs to no sequence and cannot be counted as a gap.
    seq: { type: Number, default: null, min: 1 },
    number: { type: String, required: true, trim: true },

    // What it was given to. Absent only while a caller allocated a number and never finished its write.
    docType: { type: String, default: null, trim: true },
    docId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // issued   - in use
    // released - the document was deleted and the number may be given out again
    // cancelled- the document was deleted and the number is retired, so the gap is permanent
    status: { type: String, required: true, enum: ["issued", "released", "cancelled"], default: "issued" },
    manual: { type: Boolean, default: false }, // somebody typed it rather than taking the next one
    reason: { type: String, default: null, trim: true, maxlength: 200 },

    at: { type: Date, default: Date.now },
    by: { type: String, default: null },
    endedAt: { type: Date, default: null }, // when it was released or cancelled
    endedBy: { type: String, default: null },
  },
  { timestamps: true }
);

// THE guarantee: a rendered number belongs to one row for good, whatever any counter believes. A
// re-issued number keeps its own row (the claim flips the status back), so this never stands in the way
// of re-use - only of two documents holding one number.
issuedNumberSchema.index({ companyId: 1, number: 1 }, { unique: true });
// The claim: lowest released seq for a series and label, in one indexed sort.
issuedNumberSchema.index({ companyId: 1, branchId: 1, series: 1, label: 1, status: 1, seq: 1 });
// Finding a document's number when it is deleted, and the register's own newest-first listing.
issuedNumberSchema.index({ companyId: 1, docId: 1 });
issuedNumberSchema.index({ companyId: 1, status: 1, endedAt: -1 });

issuedNumberSchema.plugin(tenantPlugin, { branchScoped: true });

module.exports = mongoose.models.IssuedNumber || mongoose.model("IssuedNumber", issuedNumberSchema);
