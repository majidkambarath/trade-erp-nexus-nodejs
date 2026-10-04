const mongoose = require("mongoose");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class AccountGroupService {
  static async list(req) {
    const { companyId } = getTenant(req);
    return AccountGroup.find({ companyId }).sort({ category: 1, name: 1 }).lean();
  }

  // Every id in the subtree under `groupId`, itself included. Reports use it for
  // "everything under Receivables".
  static async collectDescendantIds(groupId, companyId) {
    const all = await AccountGroup.find({ companyId }).select("_id parentGroup").lean();
    const children = new Map();
    for (const g of all) {
      const p = g.parentGroup ? String(g.parentGroup) : null;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(String(g._id));
    }
    const out = [];
    const stack = [String(groupId)];
    while (stack.length) {
      const id = stack.pop();
      out.push(id);
      stack.push(...(children.get(id) || []));
    }
    return out;
  }

  // A parent is valid when it exists, belongs to the same company, shares the category, and is
  // not the group itself or one of its own descendants (that would make a cycle).
  static async validateParent(parentId, { companyId, category, selfId }) {
    if (!parentId) return null;
    const parent = await AccountGroup.findOne({ _id: parentId, companyId }).lean();
    if (!parent) throw new AppError("Parent group not found", 400, "PARENT_NOT_FOUND");
    if (parent.category !== category) {
      throw new AppError("A group and its parent must share a category", 400, "CATEGORY_MISMATCH");
    }
    if (selfId) {
      const subtree = await this.collectDescendantIds(selfId, companyId);
      if (subtree.includes(String(parentId))) {
        throw new AppError("A group cannot be moved under itself or its own descendant", 400, "CIRCULAR_PARENT");
      }
    }
    return parent;
  }

  static async create(data, req) {
    const { companyId } = getTenant(req);
    await this.validateParent(data.parentGroup, { companyId, category: data.category });
    return AccountGroup.create({
      companyId,
      name: data.name,
      prefix: data.prefix,
      category: data.category,
      parentGroup: data.parentGroup || null,
    });
  }

  static async update(id, data, req) {
    const { companyId } = getTenant(req);
    const group = await AccountGroup.findOne({ _id: id, companyId });
    if (!group) throw new AppError("Account group not found", 404);

    const category = data.category || group.category;
    const parent = data.parentGroup === undefined ? group.parentGroup : data.parentGroup;
    await this.validateParent(parent, { companyId, category, selfId: group._id });

    if (data.name !== undefined) group.name = data.name;
    if (data.isActive !== undefined) group.isActive = data.isActive;
    group.parentGroup = parent || null;

    // The prefix is baked into every minted code, so it is frozen once accounts exist.
    if (data.prefix && data.prefix.toUpperCase() !== group.prefix) {
      if (await LedgerAccount.exists({ groupId: group._id })) {
        throw new AppError("Prefix cannot change once accounts exist in the group", 409, "PREFIX_LOCKED");
      }
      group.prefix = data.prefix;
    }
    if (category !== group.category) {
      group.category = category;
      await group.save();
      // Accounts carry a denormalised accountType for query speed; keep it in step.
      const type = category.toLowerCase();
      await LedgerAccount.updateMany({ groupId: group._id }, { accountType: type });
      return group;
    }
    return group.save();
  }

  // Mints the next account code for a group: PREFIX + 4 digits (e.g. AR0026).
  //
  // Concurrency-safe AND floored against codes created outside this path: the counter is set
  // to max(lastAccountSeq, highest existing code) + 1 in ONE aggregation-pipeline update, so
  // an import or manual edit that already used AR0100 makes the next mint AR0101, and parallel
  // callers each receive a distinct number.
  // Reserves `count` consecutive codes for a group in one go (the same floor-and-increment as
  // generateNextAccountCode, but one counter update for all of them). Used when many accounts are
  // created together, such as the default chart.
  static async reserveAccountCodes(groupId, count, { session } = {}) {
    if (!(count > 0)) return [];
    const group = await AccountGroup.findById(groupId).session(session || null).lean();
    if (!group) throw new AppError("Account group not found", 404);
    const re = new RegExp(`^${escapeRegex(group.prefix)}[0-9]{4}$`);
    const last = await LedgerAccount.findOne({ accountCode: re }).sort({ accountCode: -1 }).select("accountCode").session(session || null).lean();
    const highest = last ? parseInt(last.accountCode.slice(group.prefix.length), 10) : 0;
    const updated = await AccountGroup.findOneAndUpdate(
      { _id: groupId },
      [{ $set: { lastAccountSeq: { $add: [{ $max: [{ $ifNull: ["$lastAccountSeq", 0] }, highest] }, count] } } }],
      { new: true, session }
    );
    const end = updated.lastAccountSeq;
    return Array.from({ length: count }, (_, i) => `${group.prefix}${String(end - count + 1 + i).padStart(4, "0")}`);
  }

  static async generateNextAccountCode(groupId, { session } = {}) {
    const group = await AccountGroup.findById(groupId).session(session || null).lean();
    if (!group) throw new AppError("Account group not found", 404);

    // Uppercase-only, anchored regex so the accountCode index stays usable.
    const re = new RegExp(`^${escapeRegex(group.prefix)}[0-9]{4}$`);
    const last = await LedgerAccount.findOne({ accountCode: re })
      .sort({ accountCode: -1 })
      .select("accountCode")
      .session(session || null)
      .lean();
    const highest = last ? parseInt(last.accountCode.slice(group.prefix.length), 10) : 0;

    const updated = await AccountGroup.findOneAndUpdate(
      { _id: groupId },
      [{ $set: { lastAccountSeq: { $add: [{ $max: [{ $ifNull: ["$lastAccountSeq", 0] }, highest] }, 1] } } }],
      { new: true, session }
    );
    return `${group.prefix}${String(updated.lastAccountSeq).padStart(4, "0")}`;
  }
}

module.exports = AccountGroupService;
