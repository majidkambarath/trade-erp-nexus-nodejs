const mongoose = require("mongoose");
const Admin = require("../../models/core/adminModel");

// Who did something, as a name a person can read. Records name their author by account id (or a word such as
// "system", which is not looked up). One read for any number of ids, never one per row; an account since removed has
// no name and is simply absent from the map, so the screen shows nothing rather than an id.
const isAccountId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));

async function namesFor(values) {
  const ids = [...new Set((values || []).map((v) => String(v || "")).filter(isAccountId))];
  if (!ids.length) return new Map();
  const admins = await Admin.find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select("name email")
    .lean();
  return new Map(admins.map((a) => [String(a._id), a.name || a.email || null]));
}

module.exports = { namesFor, isAccountId };
