const mongoose = require("mongoose");
const { runInBranchOf } = require("../../utils/tenantContext");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const AccountConfigService = require("./accountConfigService");
const FinancialService = require("./financialService");
const AppError = require("../../utils/AppError");
const { TEMPLATES, figuresFor, buildEntries, round2 } = require("../../utils/postingTemplates");

// Ledger entries need an Admin ObjectId; order documents carry the creator as a free string.
const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdminId = (v) => (mongoose.Types.ObjectId.isValid(v) && String(v).length === 24 ? v : SYSTEM_USER);

class PostingService {
  // The customer / vendor ledger account for a document's party, created on first use and filed
  // under the configured receivable / payable group when one is mapped.
  static async partyAccount(transaction, session) {
    const isVendor = transaction.partyType === "Vendor";
    const Party = mongoose.model(isVendor ? "Vendor" : "Customer");
    const party = await Party.findById(transaction.partyId).session(session).lean();
    if (!party) throw new AppError(`${transaction.partyType} not found`, 404);

    const account = isVendor
      ? await FinancialService.getOrCreateVendorAccount(party._id, party.vendorName, session)
      : await FinancialService.getOrCreateCustomerAccount(party._id, party.customerName, session);

    if (!account.groupId) {
      try {
        const key = isVendor ? "account-payable-group" : "account-receivable-group";
        const groupId = await AccountConfigService.resolveGroup(key, { session });
        await LedgerAccount.updateOne({ _id: account._id }, { groupId }, { session });
      } catch (_) {
        // Filing under a group is a convenience; an unmapped group must not block the posting.
      }
    }
    return account._id;
  }

  // Posts the accounting entries for an approved order. No-op while ledger posting is off.
  // `stockUpdates` carries the cost each line moved, which gives the cost of goods sold.
  static async postTransaction(transaction, { stockUpdates = [], createdBy, session } = {}) {
    if (!(await AccountConfigService.isPostingEnabled({ session }))) return null;
    if (!TEMPLATES[transaction.type]) return null;
    if (transaction.isOpening) return null; // posted by Opening balances, never through the sales / purchase template

    const cogs = ["sales_order", "sales_return"].includes(transaction.type)
      ? stockUpdates.reduce((t, u) => t + (Number(u.cost) || 0), 0)
      : 0;
    const figures = figuresFor(transaction, cogs);

    // Resolve every account up front so a missing mapping fails before anything is written.
    const partyId = await this.partyAccount(transaction, session);
    const cache = new Map();
    for (const leg of TEMPLATES[transaction.type]) {
      if (!leg.account.key || cache.has(leg.account.key)) continue;
      if (!(figures[leg.amount] > 0)) continue; // a leg that carries nothing needs no account
      cache.set(leg.account.key, await AccountConfigService.resolveAccount(leg.account.key, { session }));
    }
    const entries = buildEntries(transaction.type, figures, (a) =>
      a.party ? partyId : cache.get(a.key)
    );

    const accounts = await LedgerAccount.find({ _id: { $in: entries.map((e) => e.accountId) } })
      .select("accountName accountCode accountType")
      .session(session)
      .lean();
    const byId = new Map(accounts.map((a) => [String(a._id), a]));

    const adminId = asAdminId(createdBy);
    const docs = entries.map((e) => {
      const acc = byId.get(String(e.accountId));
      return {
        voucherId: transaction._id, // the order itself is the source document
        voucherNo: transaction.transactionNo,
        voucherType: transaction.type,
        accountId: e.accountId,
        accountName: acc?.accountName || "",
        accountCode: acc?.accountCode || "",
        date: transaction.date || new Date(),
        debitAmount: e.debitAmount,
        creditAmount: e.creditAmount,
        narration: `${transaction.type.replace("_", " ")} ${transaction.transactionNo}`,
        partyId: transaction.partyId,
        partyType: transaction.partyType,
        referenceType: "order",
        referenceId: transaction._id,
        referenceNo: transaction.transactionNo,
        createdBy: adminId,
      };
    });
    await LedgerEntry.insertMany(docs, { session });
    await FinancialService.updateAccountBalances(docs, session);
    return { entries: docs.length, figures };
  }

  // After a recost, move a posted sale/return's cost-of-goods legs by `delta` (new cost - old).
  static async adjustCogs(transaction, delta, { session } = {}) {
    if (!delta || Math.abs(delta) < 0.005) return;
    if (!(await AccountConfigService.isPostingEnabled({ session }))) return;
    const cogsId = await AccountConfigService.resolveAccount("cogs", { session });
    const invId = await AccountConfigService.resolveAccount("inventory-asset", { session });

    // sale:         Dr cogs / Cr inventory      sales return: Dr inventory / Cr cogs
    const legs =
      transaction.type === "sales_order"
        ? [[cogsId, "debitAmount"], [invId, "creditAmount"]]
        : [[invId, "debitAmount"], [cogsId, "creditAmount"]];

    for (const [accountId, field] of legs) {
      const entry = await LedgerEntry.findOne({
        referenceId: transaction._id, accountId, isReversed: { $ne: true }, [field]: { $gt: 0 },
      }).session(session);
      if (entry) {
        entry[field] = round2(entry[field] + delta);
        await entry.save({ session });
      } else if (delta > 0) {
        const acc = await LedgerAccount.findById(accountId).select("accountName accountCode").session(session).lean();
        await LedgerEntry.create([{
          voucherId: transaction._id, voucherNo: transaction.transactionNo, voucherType: transaction.type,
          accountId, accountName: acc.accountName, accountCode: acc.accountCode,
          date: transaction.date || new Date(), [field]: round2(delta),
          narration: `Cost adjustment ${transaction.transactionNo}`, partyId: transaction.partyId,
          partyType: transaction.partyType, referenceType: "order", referenceId: transaction._id,
          referenceNo: transaction.transactionNo, createdBy: SYSTEM_USER,
        }], { session });
      }
      await FinancialService.updateAccountBalances(
        [{ accountId, debitAmount: field === "debitAmount" ? delta : 0, creditAmount: field === "creditAmount" ? delta : 0 }],
        session
      );
    }
  }

  // Dr one configured account / Cr another, for documents that are not orders (stock write-offs).
  static async postSimple({ debitKey, creditKey, amount, date, voucherId, voucherNo, voucherType, narration, adminId }, { session } = {}) {
    const value = round2(amount);
    if (!(value > 0)) return null;
    const [dr, cr] = await Promise.all([
      AccountConfigService.resolveAccount(debitKey, { session }),
      AccountConfigService.resolveAccount(creditKey, { session }),
    ]);
    const accounts = await LedgerAccount.find({ _id: { $in: [dr, cr] } }).select("accountName accountCode").session(session).lean();
    const byId = new Map(accounts.map((a) => [String(a._id), a]));
    const base = {
      voucherId, voucherNo, voucherType, date, narration, referenceType: "adjustment",
      referenceId: voucherId, referenceNo: voucherNo, createdBy: asAdminId(adminId),
    };
    const docs = [
      { ...base, accountId: dr, accountName: byId.get(String(dr)).accountName, accountCode: byId.get(String(dr)).accountCode, debitAmount: value, creditAmount: 0 },
      { ...base, accountId: cr, accountName: byId.get(String(cr)).accountName, accountCode: byId.get(String(cr)).accountCode, debitAmount: 0, creditAmount: value },
    ];
    await LedgerEntry.insertMany(docs, { session });
    await FinancialService.updateAccountBalances(docs, session);
    return docs.length;
  }

  // Gives every approved document that never reached the ledger its financial effect. Needed when
  // posting is switched on after documents were already approved. Safe to repeat: a document that
  // has any ledger entry is left alone. A document that cannot be posted (for example a deleted
  // party) is reported, not allowed to stop the rest.
  static async catchUp({ createdBy } = {}) {
    const Transaction = require("../../models/modules/transactionModel");
    const InventoryMovement = require("../../models/modules/inventoryMovementModel");
    const result = { posted: 0, skipped: 0, failed: [] };
    if (!(await AccountConfigService.isPostingEnabled())) return result;

    // Opening invoices (go-live) are posted against Opening Balance Equity when they are entered; the
    // sales / purchase templates would book revenue or stock for a document that has neither.
    const approved = await Transaction.find({ status: "APPROVED", type: { $in: Object.keys(TEMPLATES) }, isOpening: { $ne: true } }).sort({ date: 1, createdAt: 1 });
    for (const tx of approved) {
      if (await LedgerEntry.exists({ voucherId: tx._id })) { result.skipped += 1; continue; }
      const session = await mongoose.startSession();
      try {
        // posted to the document's own branch, whichever branch is being looked at
        await runInBranchOf(tx, () => session.withTransaction(async () => {
          // the cost the stock moved at gives the cost of goods sold on sales and returns
          const moves = await InventoryMovement.find({ referenceType: "Transaction", referenceId: tx._id, isReversed: { $ne: true } }).session(session).lean();
          const stockUpdates = moves.map((m) => ({ itemId: m.itemId, cost: Number(m.cogsAmount ?? Math.abs(m.totalValue ?? 0)) || 0 }));
          await this.postTransaction(tx, { stockUpdates, createdBy, session });
        }));
        result.posted += 1;
      } catch (err) {
        result.failed.push({ transactionNo: tx.transactionNo, reason: err.message });
      } finally {
        await session.endSession();
      }
    }
    // accounts created with an opening balance while posting was off carry it only as a stored figure
    const openings = await require("./chartOfAccountsService").postStoredOpenings({ adminId: createdBy });
    result.openingsPosted = openings.posted;
    result.failed.push(...openings.failed);
    return result;
  }

  // Undo an order's accounting entries (used when an approved order is deleted).
  static async reverseTransaction(transaction, { session } = {}) {
    const exists = await LedgerEntry.exists({ voucherId: transaction._id, isReversed: { $ne: true } }).session(
      session || null
    );
    if (!exists) return false;
    await FinancialService.reverseLedgerEntries(transaction._id, session);
    return true;
  }
}

module.exports = PostingService;
