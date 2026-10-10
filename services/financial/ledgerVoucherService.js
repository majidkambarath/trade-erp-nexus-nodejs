const mongoose = require("mongoose");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const TaxCode = require("../../models/modules/financial/taxCodeModel");
const Transaction = require("../../models/modules/transactionModel");
const TaxCodeService = require("./taxCodeService");
const AccountConfigService = require("./accountConfigService");
const { ensurePartyAccount } = require("./partyAccounts");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");

// Journal, contra, expense, debit-note and credit-note vouchers posted to the CHART OF ACCOUNTS
// (ledger accounts), so they show up in the Trial Balance, the account ledgers and the statements
// together with everything else. Each `process*` returns the fields to store on the voucher, with
// the balanced ledger `entries`; FinancialService saves it and posts it.

const EPS = 0.005;
const num = (v) => round2(Number(v) || 0);

// Accounts the user picked, checked for being usable: they exist, are active and accept postings.
async function postableAccounts(ids, { session, label = "account" } = {}) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  for (const id of unique) {
    if (!mongoose.isValidObjectId(id)) throw new AppError(`Choose a valid ${label}`, 400, "INVALID_ACCOUNT");
  }
  const q = LedgerAccount.find({ _id: { $in: unique } }).select("accountCode accountName accountType groupId isActive allowDirectPosting");
  const found = await (session ? q.session(session) : q);
  const byId = new Map(found.map((a) => [String(a._id), a]));
  for (const id of unique) {
    const a = byId.get(id);
    if (!a) throw new AppError(`Account not found: ${id}`, 404, "ACCOUNT_NOT_FOUND");
    if (!a.isActive) throw new AppError(`${a.accountName} is inactive`, 400, "ACCOUNT_INACTIVE");
    if (a.allowDirectPosting === false) {
      throw new AppError(`Direct posting is not allowed to ${a.accountName} (${a.accountCode})`, 400, "DIRECT_POSTING_NOT_ALLOWED");
    }
  }
  return byId;
}

const entryFor = (account, { debit = 0, credit = 0, description }) => ({
  accountId: account._id,
  accountName: account.accountName,
  accountCode: account.accountCode,
  debitAmount: round2(debit),
  creditAmount: round2(credit),
  description,
});

class LedgerVoucherService {
  // ---------------------------------------------------------------- journal
  // lines: [{ accountId, debit, credit, narration }]. A line is one side only; the lines together
  // must balance. Any number of lines, so a three-way split is one voucher, not three.
  static async processJournal(data, session) {
    const { date = new Date(), narration } = data;
    const raw = Array.isArray(data.lines) ? data.lines : [];
    const lines = raw
      .map((l, i) => ({ i, accountId: l.accountId, debit: num(l.debit), credit: num(l.credit), narration: String(l.narration || "").trim() }))
      .filter((l) => l.accountId || l.debit || l.credit); // a blank spare row is not an error
    if (lines.length < 2) throw new AppError("A journal needs at least two lines", 400, "TOO_FEW_LINES");

    for (const l of lines) {
      const n = l.i + 1;
      if (!l.accountId) throw new AppError(`Line ${n}: choose an account`, 400, "ACCOUNT_REQUIRED");
      if (l.debit < 0 || l.credit < 0) throw new AppError(`Line ${n}: amounts cannot be negative`, 400, "NEGATIVE_AMOUNT");
      if (l.debit > 0 && l.credit > 0) throw new AppError(`Line ${n}: enter a debit or a credit, not both`, 400, "BOTH_SIDES");
      if (!(l.debit > 0) && !(l.credit > 0)) throw new AppError(`Line ${n}: enter an amount`, 400, "AMOUNT_REQUIRED");
    }
    const debit = round2(lines.reduce((t, l) => t + l.debit, 0));
    const credit = round2(lines.reduce((t, l) => t + l.credit, 0));
    if (Math.abs(debit - credit) > EPS) {
      throw new AppError(`The journal does not balance: debits ${debit.toFixed(2)}, credits ${credit.toFixed(2)} (difference ${Math.abs(debit - credit).toFixed(2)})`, 400, "UNBALANCED");
    }
    if (!(debit > 0)) throw new AppError("A journal must move an amount", 400, "AMOUNT_REQUIRED");

    const accounts = await postableAccounts(lines.map((l) => l.accountId), { session });
    const entries = lines.map((l) => entryFor(accounts.get(String(l.accountId)), { debit: l.debit, credit: l.credit, description: l.narration || narration || "Journal entry" }));
    return { date, totalAmount: debit, narration, entries, status: "approved", ledgerBased: true };
  }

  // ----------------------------------------------------------------- contra
  // Cash and bank moving between themselves: a deposit, a withdrawal, a bank-to-bank transfer.
  static async processContra(data, session, { groupIds, req } = {}) {
    const { date = new Date(), fromAccountId, toAccountId, narration } = data;
    const amount = num(data.totalAmount);
    if (!fromAccountId || !toAccountId) throw new AppError("Choose the account the money leaves and the account it goes to", 400, "ACCOUNT_REQUIRED");
    if (String(fromAccountId) === String(toAccountId)) throw new AppError("The two accounts must be different", 400, "SAME_ACCOUNT");
    if (!(amount > 0)) throw new AppError("Enter the amount", 400, "AMOUNT_REQUIRED");

    const accounts = await postableAccounts([fromAccountId, toAccountId], { session });
    const [from, to] = [accounts.get(String(fromAccountId)), accounts.get(String(toAccountId))];
    const { cashIds, bankIds } = groupIds || (await cashAndBankGroupIds(req));
    for (const a of [from, to]) {
      const g = String(a.groupId);
      if (!cashIds.includes(g) && !bankIds.includes(g)) {
        throw new AppError(`${a.accountName} is not a cash or bank account. Use a journal for other accounts.`, 400, "NOT_CASH_OR_BANK");
      }
    }
    // Cash cannot go below zero (a bank account may overdraw).
    if (cashIds.includes(String(from.groupId))) {
      const fresh = await LedgerAccount.findById(from._id).select("currentBalance").session(session || null);
      if (round2(fresh?.currentBalance || 0) + EPS < amount) {
        throw new AppError(`There is only ${round2(fresh?.currentBalance || 0).toFixed(2)} in ${from.accountName}`, 409, "CASH_INSUFFICIENT");
      }
    }
    const text = narration || `Transfer from ${from.accountName} to ${to.accountName}`;
    return {
      date, totalAmount: amount, narration: text, fromAccountId: from._id, toAccountId: to._id,
      notes: `From: ${from.accountCode} | To: ${to.accountCode}`,
      entries: [
        entryFor(to, { debit: amount, description: `Transfer from ${from.accountName}` }),
        entryFor(from, { credit: amount, description: `Transfer to ${to.accountName}` }),
      ],
      status: "approved", ledgerBased: true,
    };
  }

  // ---------------------------------------------------------------- expense
  // amount is before VAT. Dr expense (+ Dr input VAT) / Cr cash, bank, cheque or card. How it was
  // paid is a payment mode like any other voucher, so a cheque waits in the cheques account.
  static async processExpense(data, session, { req, PaymentModeService } = {}) {
    const { date = new Date(), expenseAccountId, description, paymentMode = "cash" } = data;
    const net = num(data.amount ?? data.totalAmount);
    // The VAT as printed on the invoice, when it is not simply net x rate: a bank's tax invoice fixes
    // the gross, and a rate applied to the net can be a fils out. Within a fils of the rate, it is used.
    const vatGiven = data.vatAmount === undefined || data.vatAmount === null || data.vatAmount === "" ? null : num(data.vatAmount);
    // VAT only: tax on an amount that was booked earlier (a card commission booked at the sale), so
    // there is nothing to debit to an expense account, only the input VAT.
    const vatOnly = !(net > 0) && vatGiven > 0;
    if (!vatOnly && !expenseAccountId) throw new AppError("Choose the expense account", 400, "ACCOUNT_REQUIRED");
    if (!vatOnly && !(net > 0)) throw new AppError("Enter the amount", 400, "AMOUNT_REQUIRED");
    if (!String(description || "").trim()) throw new AppError("Describe the expense", 400, "DESCRIPTION_REQUIRED");

    let expense = null;
    if (!vatOnly) {
      const accounts = await postableAccounts([expenseAccountId], { session, label: "expense account" });
      expense = accounts.get(String(expenseAccountId));
      if (expense.accountType !== "expense") throw new AppError(`${expense.accountName} is not an expense account`, 400, "NOT_AN_EXPENSE_ACCOUNT");
    }

    let { vatPercent, vatAmount, taxCodeId } = await vatFor(data.taxCodeId, net, date, { session, req });
    if (vatGiven !== null) {
      if (!taxCodeId) throw new AppError("Choose the tax code the VAT is for", 400, "TAX_CODE_REQUIRED");
      // `vatCoversEarlierAmount`: the VAT also covers an amount booked before (the acquirer's VAT on a
      // commission whose fee went in at the sale), so it is not net x rate and is taken as given
      if (!vatOnly && !data.vatCoversEarlierAmount && Math.abs(vatGiven - vatAmount) > 0.02 + 1e-9) {
        throw new AppError(`VAT on ${net.toFixed(2)} should be about ${vatAmount.toFixed(2)}, not ${vatGiven.toFixed(2)}`, 400, "VAT_MISMATCH");
      }
      vatAmount = vatGiven;
    }
    const total = round2(net + vatAmount);

    const money = await PaymentModeService.resolve({
      direction: "payment", mode: paymentMode, details: data.paymentDetails || {}, amount: total, date,
      description: `Expense - ${description.trim()}`, session, req,
    });

    const entries = vatOnly ? [] : [entryFor(expense, { debit: net, description: description.trim() })];
    if (vatAmount > 0) {
      const vatId = await AccountConfigService.resolveAccount("vat-purchase", { session });
      const vat = await LedgerAccount.findById(vatId).select("accountCode accountName").session(session || null);
      entries.push(entryFor(vat, { debit: vatAmount, description: `Input VAT - ${description.trim()}` }));
    }
    entries.push(...money.legs);

    return {
      date, totalAmount: total, subtotal: net, vatTotal: vatAmount, taxCodeId, description: description.trim(),
      narration: data.narration || description.trim(), expenseAccountId: expense?._id, expenseAccountName: expense?.accountName,
      expenseTypeName: expense?.accountName || "VAT on a charge booked earlier", paymentMode: money.mode, paymentDetails: money.details,
      partyId: data.vendorId || undefined, partyType: data.vendorId ? "Vendor" : null, partyName: data.partyName || undefined,
      entries, status: "approved", ledgerBased: true, _cheque: money.cheque, _vatPercent: vatPercent,
    };
  }

  // ------------------------------------------------------------------ notes
  // Debit note: the party is DEBITED (they owe more / we owe less); the lines are credited.
  // Credit note: the party is CREDITED; the lines are debited.
  // VAT follows the lines: output VAT for a customer, input VAT for a vendor. A note that reduces
  // what the party owes can be set against one of their open invoices.
  static async processNote(data, session, { voucherType, req } = {}) {
    const isDebit = voucherType === "debit_note";
    const { date = new Date(), partyId, narration } = data;
    const partyType = data.partyType === "Vendor" ? "Vendor" : "Customer";
    if (!partyId || !mongoose.isValidObjectId(partyId)) throw new AppError(`Choose the ${partyType.toLowerCase()}`, 400, "PARTY_REQUIRED");
    const Party = mongoose.model(partyType);
    const party = await Party.findById(partyId).select(partyType === "Vendor" ? "vendorName" : "customerName").session(session || null);
    if (!party) throw new AppError(`${partyType} not found`, 404);
    const partyName = partyType === "Vendor" ? party.vendorName : party.customerName;

    const rawLines = (Array.isArray(data.lines) ? data.lines : []).filter((l) => l && (l.accountId || num(l.amount)));
    if (!rawLines.length) throw new AppError("Add at least one line", 400, "LINES_REQUIRED");
    const accounts = await postableAccounts(rawLines.map((l) => l.accountId), { session });

    const noteLines = [];
    for (const [i, l] of rawLines.entries()) {
      const n = i + 1;
      if (!l.accountId) throw new AppError(`Line ${n}: choose an account`, 400, "ACCOUNT_REQUIRED");
      const amount = num(l.amount);
      if (!(amount > 0)) throw new AppError(`Line ${n}: enter an amount`, 400, "AMOUNT_REQUIRED");
      const acc = accounts.get(String(l.accountId));
      const v = await vatFor(l.taxCodeId, amount, date, { session, req });
      noteLines.push({
        accountId: acc._id, accountName: acc.accountName, accountCode: acc.accountCode,
        description: String(l.description || "").trim(), amount, taxCodeId: v.taxCodeId, vatPercent: v.vatPercent, vatAmount: v.vatAmount,
      });
    }
    const subtotal = round2(noteLines.reduce((t, l) => t + l.amount, 0));
    const vatTotal = round2(noteLines.reduce((t, l) => t + l.vatAmount, 0));
    const total = round2(subtotal + vatTotal);

    const partyAccount = await ensurePartyAccount(partyType === "Vendor" ? "vendor" : "customer", party._id, partyName, { session });
    const label = isDebit ? "Debit note" : "Credit note";
    const entries = [entryFor(partyAccount, { [isDebit ? "debit" : "credit"]: total, description: `${label} - ${partyName}` })];
    for (const l of noteLines) {
      entries.push({
        accountId: l.accountId, accountName: l.accountName, accountCode: l.accountCode,
        debitAmount: isDebit ? 0 : l.amount, creditAmount: isDebit ? l.amount : 0,
        description: l.description || `${label} - ${partyName}`,
      });
    }
    if (vatTotal > 0) {
      const vatId = await AccountConfigService.resolveAccount(partyType === "Vendor" ? "vat-purchase" : "vat-sales", { session });
      const vat = await LedgerAccount.findById(vatId).select("accountCode accountName").session(session || null);
      entries.push(entryFor(vat, { [isDebit ? "credit" : "debit"]: vatTotal, description: `${partyType === "Vendor" ? "Input" : "Output"} VAT - ${label.toLowerCase()}` }));
    }

    // A note that lowers what the party owes (customer credit note, vendor debit note) can settle
    // an open invoice, exactly as a receipt or payment does.
    const reduces = (partyType === "Customer" && !isDebit) || (partyType === "Vendor" && isDebit);
    let linkedInvoices = [];
    let reference = {};
    if (data.referenceInvoiceId) {
      if (!reduces) {
        throw new AppError(`A ${label.toLowerCase()} to a ${partyType.toLowerCase()} adds to what they owe, so it cannot be set against an invoice`, 400, "NOTE_CANNOT_SETTLE");
      }
      const invoice = await Transaction.findById(data.referenceInvoiceId).session(session || null);
      const wantType = partyType === "Vendor" ? "purchase_order" : "sales_order";
      if (!invoice || invoice.type !== wantType || String(invoice.partyId) !== String(partyId) || invoice.status !== "APPROVED") {
        throw new AppError(`Choose an approved ${partyType === "Vendor" ? "purchase" : "sales"} invoice of ${partyName}`, 400, "INVALID_INVOICE");
      }
      if (total > invoice.outstandingAmount + EPS) {
        throw new AppError(`This ${label.toLowerCase()} (${total.toFixed(2)}) is more than the ${round2(invoice.outstandingAmount).toFixed(2)} still open on ${invoice.transactionNo}`, 409, "NOTE_EXCEEDS_INVOICE");
      }
      const before = round2(invoice.outstandingAmount);
      invoice.paidAmount = round2((invoice.paidAmount || 0) + total);
      invoice.outstandingAmount = round2(Math.max(0, before - total));
      await invoice.save({ session });
      linkedInvoices = [{ invoiceId: invoice._id, allocatedAmount: total, previousBalance: before, newBalance: invoice.outstandingAmount }];
      reference = { referenceInvoiceId: invoice._id, referenceInvoiceNo: invoice.transactionNo };
    }

    return {
      date, partyId: party._id, partyType, partyName, totalAmount: total, subtotal, vatTotal,
      narration: narration || `${label} - ${partyName}`, noteLines, entries, linkedInvoices, ...reference,
      status: "approved", ledgerBased: true,
    };
  }
}

// The VAT on an amount for a tax code, at the rate in force on the document date.
async function vatFor(taxCodeId, net, date, { session, req } = {}) {
  if (!taxCodeId) return { taxCodeId: undefined, vatPercent: 0, vatAmount: 0 };
  const { companyId } = getTenant(req);
  const q = TaxCode.findOne({ _id: taxCodeId, companyId });
  const code = await (session ? q.session(session) : q);
  if (!code || !code.isActive) throw new AppError("Tax code not found or inactive", 400, "INVALID_TAX_CODE");
  // Reverse charge is assessed on a purchase document (utils/pricing.js): the supplier's invoice has no VAT, the buyer works it out and posts
  // Dr Input VAT / Cr Reverse-charge VAT beside what it pays. An expense or a debit / credit note takes the VAT as the supplier charged it, so
  // this code here would book VAT nobody was paid and leave it out of the return. Refused until these vouchers assess it themselves.
  if (code.kind === "reverse_charge") {
    throw new AppError("A reverse-charge tax code belongs on a purchase invoice, where the VAT is assessed and posted. Record this as a purchase of a service item, or choose another tax code.", 400, "REVERSE_CHARGE_NOT_SUPPORTED");
  }
  const pct = TaxCodeService.rateOn(code, date);
  return { taxCodeId: code._id, vatPercent: pct, vatAmount: round2((net * pct) / 100) };
}

async function cashAndBankGroupIds(req) {
  const { groupFamily } = require("../banking/cardService");
  const [cash, bank] = await Promise.all([groupFamily("cash-account-group", req), groupFamily("bank-account-group", req)]);
  return { cashIds: cash.ids, bankIds: bank.ids };
}

module.exports = LedgerVoucherService;
