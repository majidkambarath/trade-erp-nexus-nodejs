// What the notification feed says about cheques. Pure: rows in, notices out - the service reads the rows, raises the
// notices and resolves the ones that stopped being true (services/core/notificationChecksService.js).
//
// A notice is { dedupeKey, severity, title, body }. Three things matter in how they are shaped:
//   - A cheque we HOLD (a customer's) and a cheque we ISSUED read differently. For the first the nudge is "deposit it";
//     for the second it is "keep the account funded" - the bank may honour it any time after its date.
//   - A change of STAGE changes the key (`<id>:soon` -> `<id>:overdue`), so a person who read "matures in 3 days" is told
//     again when it is past its date. Within a stage only the countdown changes, quietly, and a read notice stays read.
//   - Nothing here asserts a legal consequence. "Stale" is the bank's six-month practice the register already enforces.

const rules = require("./chequeRules");

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const money = (amount, currency) => `${currency ? `${currency} ` : ""}${Number(amount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const who = (c) => c.partyName || (c.direction === "receipt" ? "a customer" : "a supplier");
const mine = (c) => c.direction === "receipt"; // a cheque we hold, as against one we issued

// Cheques due, or past due, that have not gone to the bank. `cheques` are pending or on hold; each has chequeDay (a
// YYYY-MM-DD day). A held cheque is told too - it is easy to forget on purpose - but says it is on hold.
function maturing(cheques, today, { currency = "", soonDays = rules.SOON_DAYS } = {}) {
  const out = [];
  for (const c of cheques) {
    const { state, days } = rules.maturityOf(c.chequeDay, today, soonDays);
    if (state === "later") continue;
    const onHold = c.status === "hold";
    const amount = money(c.amount, currency);
    const hold = onHold ? `On hold${c.holdReason ? `: ${c.holdReason}` : ""}. ` : "";
    let title;
    let severity = "info";
    if (mine(c)) {
      if (state === "overdue") { title = `Cheque ${c.chequeNo} from ${who(c)} is ${plural(-days, "day")} past its date${onHold ? " and on hold" : " and not deposited"}`; severity = "warning"; }
      else if (state === "today") title = `Cheque ${c.chequeNo} from ${who(c)} can be ${onHold ? "taken off hold and " : ""}deposited today`;
      else title = `Cheque ${c.chequeNo} from ${who(c)} matures in ${plural(days, "day")}`;
    } else if (state === "overdue") {
      title = `Our cheque ${c.chequeNo} to ${who(c)} has been payable for ${plural(-days, "day")}: keep the account funded`; severity = "warning";
    } else if (state === "today") {
      title = `Our cheque ${c.chequeNo} to ${who(c)} can be paid from today: keep the account funded`;
    } else title = `Our cheque ${c.chequeNo} to ${who(c)} falls due in ${plural(days, "day")}`;
    out.push({ dedupeKey: `${c._id}:${state === "overdue" ? "overdue" : "soon"}`, severity, title, body: `${hold}${amount}, ${c.voucherNo}.` });
  }
  return out;
}

// Cheques taken to the bank that have not cleared. Banks take a few days; past that, somebody should ask.
function uncleared(cheques, today, { currency = "", afterDays = rules.UNCLEARED_AFTER_DAYS } = {}) {
  const out = [];
  for (const c of cheques) {
    if (!c.presentedDay) continue;
    const waiting = rules.daysBetween(c.presentedDay, today);
    if (waiting < afterDays) continue;
    out.push({
      dedupeKey: String(c._id), severity: "warning",
      title: `Cheque ${c.chequeNo} ${mine(c) ? "from" : "to"} ${who(c)} was deposited ${plural(waiting, "day")} ago and has not cleared`,
      body: `${money(c.amount, currency)}${c.depositSlipNo ? `, slip ${c.depositSlipNo}` : ""}. Ask the bank, or mark it bounced if it came back.`,
    });
  }
  return out;
}

// Cheques that are going stale, or have. Only ones still in hand (pending or on hold): one at the bank is the bank's now.
function expiring(cheques, today, validityDays, { currency = "", warnDays = rules.EXPIRY_WARN_DAYS } = {}) {
  const out = [];
  for (const c of cheques) {
    const { state, lastDay, daysLeft } = rules.expiryOf(c.chequeDay, today, validityDays, warnDays);
    if (state === "ok") continue;
    const amount = money(c.amount, currency);
    if (state === "expired") {
      out.push({
        dedupeKey: `${c._id}:expired`, severity: "critical",
        title: `Cheque ${c.chequeNo} ${mine(c) ? "from" : "to"} ${who(c)} has gone stale`,
        body: mine(c)
          ? `${amount}, dated ${c.chequeDay}. The bank may refuse it. Ask for a replacement, or hand it back.`
          : `${amount}, dated ${c.chequeDay}. The bank may refuse it. If it will not be presented, cancel it so the supplier is owed again.`,
      });
    } else {
      out.push({
        dedupeKey: `${c._id}:expiring`, severity: "warning",
        title: `Cheque ${c.chequeNo} ${mine(c) ? "from" : "to"} ${who(c)} goes stale ${daysLeft === 0 ? "after today" : `in ${plural(daysLeft, "day")}`}`,
        body: `${amount}, dated ${c.chequeDay}; last good day ${lastDay}. ${mine(c) ? "Deposit it before then, or ask for a replacement." : "It may be refused after then."}`,
      });
    }
  }
  return out;
}

module.exports = { maturing, uncleared, expiring };
