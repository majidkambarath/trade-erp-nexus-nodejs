// What a refusal means, in words a person can act on. Pure.
//
// The API already answers every refusal with a structured errorCode (utils/errorHandler.js and the
// AppError third argument). "It will not let me" is the commonest support question there is, and it
// is the one question that does not need a model to answer well: the code says exactly what
// happened. Zarvia AI reads the code the person just hit and explains THIS table, so the answer is
// the same every time and cannot be invented.
//
// Each entry says:
//   label   one line naming what happened, as the person experienced it
//   why     why the system refused, without blaming them
//   fix     what to do next - the first concrete step, not a list of options
//   who     who can actually resolve it: "self" | "administrator" | "support"
//   screens where to go, if anywhere (an app path, checked against the router by a test)
//   asked   how a person phrases it when they ask us, so retrieval can find the topic too
//
// A code that is not here is not an error in this file: the assistant falls back to the server's own
// message, which is already written for a person. Add an entry when a refusal starts costing support
// time, not for completeness.

// ---- what the organisation bought, and what the role may do -------------------------------------
const PLAN = {
  PERMISSION_DENIED: {
    label: "Your role does not include this",
    why: "Permissions are set per role, and this action is not one your role holds. It is not a fault and nothing is wrong with the record.",
    fix: "Ask whoever administers your Zarvia account to add it to your role, or to do this step for you. Users and roles is where it is changed.",
    who: "administrator",
    screens: ["/users"],
    asked: ["why can I not do this", "it says permission denied", "I do not have access"],
  },
  MODULE_NOT_IN_PLAN: {
    label: "Your organisation does not have this module",
    why: "Zarvia is sold in modules. This one was not included for your organisation, so it is switched off for everybody here, your administrator included.",
    fix: "Nobody inside your organisation can switch it on. Contact us and we will tell you what it covers and what it costs.",
    who: "support",
    asked: ["why is Finance missing", "why can I not see the books", "module not in plan"],
  },
  FEATURE_NOT_IN_PLAN: {
    label: "This screen is not included in your plan",
    why: "Some parts of Zarvia are optional extras rather than whole modules, and this one is not switched on for your organisation.",
    fix: "Contact us to have it switched on. It is one setting on our side, not a change to your data.",
    who: "support",
    asked: ["not included in your plan", "how do I get quotations", "how do I turn this on"],
  },
  FEATURE_NOT_FOR_COUNTRY: {
    label: "This one is only for organisations in the UAE",
    why: "The VAT return and e-invoicing are built to the UAE's own rules, so they are offered only to organisations registered there.",
    fix: "If you need the equivalent for your country, tell us which return or format you file and we will look at it.",
    who: "support",
    asked: ["where is the VAT return", "why no e-invoicing", "GST return"],
  },
  LIMIT_REACHED: {
    label: "You have reached what your plan allows",
    why: "Your plan includes a number of users, branches, or documents a month. This would go past it. The refusal names which one and how many you have used.",
    fix: "Remove or switch off one you no longer need, or contact us to raise the limit.",
    who: "support",
    asked: ["cannot add another user", "limit reached", "too many documents"],
  },
  ORGANISATION_READ_ONLY: {
    label: "Your subscription has lapsed, so Zarvia is read-only",
    why: "Everything can still be read, printed and exported - your records are intact and nothing has been deleted - but nothing new can be saved until the subscription is renewed.",
    fix: "Contact us to renew. The moment it is renewed, saving works again with no further step.",
    who: "support",
    asked: ["why can I not save", "read only", "subscription expired"],
  },
  ORGANISATION_SUSPENDED: {
    label: "This account is suspended",
    why: "Zarvia is suspended for your organisation, so no screen will load data.",
    fix: "Contact us. Your data is untouched.",
    who: "support",
    asked: ["account suspended", "nothing loads", "everyone here is locked out"],
  },
};

// ---- dates, periods and the posting map ---------------------------------------------------------
const PERIOD = {
  PERIOD_CLOSED: {
    label: "The date falls in a closed period",
    why: "Once a month or a year is closed, nothing dated inside it can be posted, changed or deleted - that is what closing is for, so the figures you reported cannot move afterwards. The message names the day posting is closed up to.",
    fix: "If the entry belongs in an open period, change its date. If it genuinely belongs in the closed one, an administrator must reopen that month, make the entry, and close it again.",
    who: "administrator",
    screens: ["/accounting-setup"],
    asked: ["posting is closed", "why can I not save this date", "how do I reopen a month", "fiscal year is closed"],
  },
  NO_FISCAL_YEAR: {
    label: "There is no fiscal year covering that date",
    why: "Every posting has to fall inside a defined financial year, and this date falls outside all of them.",
    fix: "Add the year that covers the date in Accounting setup, Fiscal years. Check the date first - a mistyped year is the usual cause.",
    who: "administrator",
    screens: ["/accounting-setup"],
    asked: ["no fiscal year", "add a financial year", "date outside the year"],
  },
  ACCOUNT_NOT_CONFIGURED: {
    label: "An account has not been mapped yet",
    why: "Zarvia posts to the accounts named in the posting map, and deliberately has no fallback account: posting to the wrong place silently is worse than refusing. The message names the key that is missing.",
    fix: "Map that key in Accounting setup, Account configuration. There is a default chart, so usually the right account already exists and only needs choosing.",
    who: "administrator",
    screens: ["/accounting-setup"],
    asked: ["account not configured", "posting key missing", "which account does this use"],
  },
  ALL_BRANCHES_REQUIRED: {
    label: "Switch to all branches first",
    why: "Closing a period, and some whole-organisation actions, cover every branch at once, so they cannot be done while you are looking at one branch.",
    fix: "Use the branch switcher at the top and choose all branches, then try again.",
    who: "self",
    asked: ["all branches required", "why do I have to switch branch"],
  },
  STOCK_NOT_RECONCILED: {
    label: "Stock does not agree with the Inventory account",
    why: "This is a warning, not a refusal. The stock you hold and what the Inventory account says differ at that date, usually because a quantity was typed on an item directly or changed while ledger posting was off.",
    fix: "Open Stock reports and read the reconciliation, which names the biggest differences. You can still go ahead by ticking the warning, and nothing is lost either way.",
    who: "self",
    screens: ["/stock-reports"],
    asked: ["stock does not match", "inventory account differs", "stock not reconciled"],
  },
  WRITE_CONFLICT: {
    label: "Someone else was saving the same record",
    why: "Two people changed the same record at the same moment, so Zarvia refused rather than let one quietly overwrite the other. Nothing was saved.",
    fix: "Try again. It almost always succeeds the second time.",
    who: "self",
    asked: ["write conflict", "try again error", "someone else was saving"],
  },
};

// ---- approvals ----------------------------------------------------------------------------------
const APPROVALS = {
  APPROVAL_LIMIT_EXCEEDED: {
    label: "This is above the amount your role may approve",
    why: "Roles can carry an approval limit, and this document is worth more than yours. The refusal names both figures.",
    fix: "Ask someone whose role has a higher limit to approve it. It stays exactly as it is until they do.",
    who: "administrator",
    screens: ["/approvals"],
    asked: ["above my approval limit", "who can approve this", "cannot approve"],
  },
  SELF_APPROVAL_NOT_ALLOWED: {
    label: "Whoever prepared it cannot approve it",
    why: "Your organisation has asked for a separate approver, so the person who entered a document is never the person who approves it. It is a control against mistakes and against fraud.",
    fix: "Ask a colleague who holds approval to look at it. It is already waiting for them in Approvals.",
    who: "administrator",
    screens: ["/approvals"],
    asked: ["cannot approve my own", "separate approver", "why can I not approve this"],
  },
  SECOND_APPROVER_REQUIRED: {
    label: "A second person has to approve this",
    why: "Above an amount your organisation set, two different people must approve. Your approval is recorded; the document has not posted and has not moved stock.",
    fix: "Ask another approver to open it. Their approval completes it.",
    who: "administrator",
    screens: ["/approvals"],
    asked: ["waiting for second approval", "two approvers", "it says awaiting second"],
  },
  STATUS_REQUIRES_PROCESS: {
    label: "Approving is its own step",
    why: "A document is saved as a draft first. Choosing Approved in the form does not approve it, because approving is what moves stock and posts the books, and that has to be a deliberate act.",
    fix: "Save the draft, then press Approve on it.",
    who: "self",
    asked: ["how do I approve", "it saved as draft", "choosing approved did nothing"],
  },
};

// ---- documents and stock ------------------------------------------------------------------------
const DOCUMENTS = {
  INSUFFICIENT_STOCK: {
    label: "There is not enough stock",
    why: "A production issue and a few other actions will not take stock below nothing. An ordinary sale is different: it warns but lets you go ahead.",
    fix: "Receive the stock first, or reduce the quantity. Stock reports shows what is on hand and what is already promised.",
    who: "self",
    screens: ["/stock", "/stock-reports"],
    asked: ["not enough stock", "insufficient stock", "stock is short"],
  },
  SERVICE_HAS_NO_STOCK: {
    label: "That item is a service, so it has no stock",
    why: "A service - consulting, delivery, installation - is sold and bought but never counted. It has no quantity, no batch and no cost of its own.",
    fix: "If it should be counted, change the item to Goods on its own screen. That is only possible while nothing has been built on it yet.",
    who: "self",
    screens: ["/stock"],
    asked: ["service has no stock", "why can I not set a quantity", "item is a service"],
  },
  ITEM_TYPE_LOCKED: {
    label: "This item can no longer change between goods and service",
    why: "Once an item has been bought, sold, moved or counted, changing what kind of thing it is would make its own history untrue. The refusal names how many documents and movements it has.",
    fix: "Create a new item of the right kind and stop using this one.",
    who: "self",
    screens: ["/stock"],
    asked: ["cannot change item type", "goods to service", "item type locked"],
  },
  ORDER_LINE_HAS_DELIVERIES: {
    label: "A delivery note already covers that line",
    why: "The line has been delivered, in whole or in part, so removing it or changing its item would leave a delivery note pointing at nothing.",
    fix: "Cancel the delivery note first if it was wrong, or leave the line and change the rest of the order.",
    who: "self",
    screens: ["/delivery-notes"],
    asked: ["cannot edit the order", "line has deliveries", "already delivered"],
  },
  ORDER_CLOSED_SHORT: {
    label: "That order was closed short",
    why: "Somebody recorded that the customer will not take the rest of this order, so nothing further can be delivered against it.",
    fix: "Reopen it if that was wrong, or raise a new order for the remaining goods.",
    who: "self",
    asked: ["order closed short", "cannot deliver any more", "reopen an order"],
  },
  BANK_MATCHED: {
    label: "This entry is matched to a bank statement line",
    why: "Changing or deleting it would break a reconciliation you have already proved, so Zarvia refuses while the match stands.",
    fix: "Unmatch it on the bank reconciliation screen, make the change, then match it again.",
    who: "self",
    screens: ["/bank-reconciliation"],
    asked: ["cannot delete this voucher", "bank matched", "it is reconciled"],
  },
  REVERSE_CHARGE_NOT_SUPPORTED: {
    label: "Reverse charge cannot be used on this kind of voucher",
    why: "An expense voucher and a debit or credit note record VAT as the supplier charged it. A reverse-charge code would book tax nobody was paid and leave it out of the return.",
    fix: "Record an imported service as a purchase of a service item instead, where reverse charge works properly.",
    who: "self",
    asked: ["reverse charge on an expense", "RCM not allowed", "imported service"],
  },
};

// ---- signing in ---------------------------------------------------------------------------------
const SIGN_IN = {
  PASSWORD_CHANGE_REQUIRED: {
    label: "You have to choose your own password first",
    why: "Somebody else set the password you signed in with, so until you replace it nothing else in Zarvia will open. It means no one but you knows the password you end up using.",
    fix: "Set a new one on the screen in front of you. Eight characters or more, and it cannot be the one you just used.",
    who: "self",
    asked: ["it wants a new password", "must change password", "cannot get past the password screen"],
  },
  TWO_FACTOR_ENROLMENT_REQUIRED: {
    label: "Your organisation requires two-factor sign-in",
    why: "Your organisation has made an authenticator code compulsory, so Zarvia will not open until yours is set up.",
    fix: "Follow the screen: scan the square with an authenticator app, then type the six digits it shows. Keep the recovery codes somewhere safe - they are the way back in if you lose the phone.",
    who: "self",
    screens: ["/settings"],
    asked: ["set up two factor", "it wants a code", "authenticator app"],
  },
  SESSION_REVOKED: {
    label: "You were signed out",
    why: "The session ended - usually because the password was changed, an administrator switched something, or the same sign-in was used somewhere else.",
    fix: "Sign in again. Nothing you had saved is lost; anything you were half way through typing is.",
    who: "self",
    asked: ["why was I signed out", "session ended", "it logged me out"],
  },
  TOO_MANY_ATTEMPTS: {
    label: "Too many tries - wait a few minutes",
    why: "Repeated failures from one place are slowed down deliberately, so that nobody can guess their way into an account.",
    fix: "Wait for the time the message gives and try again. If you have forgotten the password, use Forgot password rather than guessing.",
    who: "self",
    asked: ["too many attempts", "locked out", "it will not let me try again"],
  },
  BRANCH_NOT_ALLOWED: {
    label: "You do not work in that branch",
    why: "People are given a branch, and some are given a role in more than one. This is not one of yours.",
    fix: "Switch back to your own branch. If you genuinely need another, an administrator can add it to you.",
    who: "administrator",
    screens: ["/users"],
    asked: ["cannot switch branch", "branch not allowed", "wrong branch"],
  },
};

const CODES = { ...PLAN, ...PERIOD, ...APPROVALS, ...DOCUMENTS, ...SIGN_IN };

// Who can actually resolve it. The assistant must be straight about this: telling somebody to ask
// their administrator for something only we can switch on wastes a day, and the reverse makes us
// answer a question their own administrator could have.
const WHO = {
  self: "You can resolve this yourself.",
  administrator: "Whoever administers Zarvia for your organisation can resolve this.",
  support: "Only we can resolve this - nobody inside your organisation can switch it on.",
};

const isKnown = (code) => typeof code === "string" && Object.hasOwn(CODES, code);

/**
 * What to tell somebody who just hit `code`. `serverMessage` is the message the API itself
 * returned: it often carries the specifics (which day posting is closed up to, which key is
 * unmapped, which limit was reached), so it is passed through rather than paraphrased.
 */
function explain(code, { serverMessage = "" } = {}) {
  const entry = isKnown(code) ? CODES[code] : null;
  if (!entry) {
    // Not a failure: every refusal already carries a message written for a person. The assistant
    // leans on that and does not guess at a code it does not know.
    return { code: code || null, known: false, serverMessage: String(serverMessage || "") };
  }
  return {
    code,
    known: true,
    label: entry.label,
    why: entry.why,
    fix: entry.fix,
    who: entry.who,
    whoText: WHO[entry.who],
    screens: entry.screens || [],
    serverMessage: String(serverMessage || ""),
  };
}

/** One line for the prompt, so the model wraps a fixed explanation instead of inventing one. */
function summary(code) {
  const e = isKnown(code) ? CODES[code] : null;
  return e ? `${code}: ${e.label}. ${e.why} ${e.fix} ${WHO[e.who]}` : "";
}

/** [{ code, question }] - how people phrase each refusal, so retrieval can reach the topic too. */
function allQuestions() {
  const out = [];
  for (const [code, e] of Object.entries(CODES)) {
    for (const q of e.asked || []) out.push({ code, question: q });
  }
  return out;
}

/** Every app path any entry points at, for the test that checks they are real routes. */
const screensNamed = () => [...new Set(Object.values(CODES).flatMap((e) => e.screens || []))].sort();

module.exports = { CODES, WHO, isKnown, explain, summary, allQuestions, screensNamed };
