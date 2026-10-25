// How a balance sheet account is CLASSIFIED and ORDERED, with nothing from the database in it.
//
// Both balance sheets ask the same three questions - is this account current or non-current, which
// group does it belong under, and in what order do the lines read - so the answers live here once.
// services/reports/ifrsReportsService.js (Statement of financial position) and
// services/financial/financialService.js getBalanceSheet (Reports -> Statements -> Balance sheet)
// both import from here. Two copies of this rule would be two balance sheets that disagree, and the
// whole point of reading both from one ledger is that they cannot.
//
// It is a NEW module on purpose: zarvia-platform mirrors utils/plans.js and utils/permissions.js and
// its parity suites deep-equal their exports, so adding rules to one of those would need the mirror
// changed in the same commit. Nothing here is mirrored.

// An asset or liability is NON-CURRENT when its own group, or any group above it in the tree, is
// named like one. Everything else is current - so every account lands on exactly one side and
// nothing is left unclassified. Named groups, not account names: "Office equipment" bought as a
// one-off expense should not become a fixed asset because of the word in its name.
const NON_CURRENT_RX = /fixed|non.?current|property|plant|equipment|intangible|long.?term/i;

// Ordering within a section (IAS 1): stock first, then receivables, then the rest, cash LAST.
const INVENTORY_RX = /inventor|stock/i;
const RECEIVABLE_RX = /receivable|debtor/i;
const PAYABLE_RX = /payable|creditor/i;
const RETAINED_RX = /retained|accumulated|earnings|profit/i;
const SHARE_CAPITAL_RX = /capital|share/i;
// Money the owners have taken out. It is a debit inside equity, so it is shown as a deduction under
// capital rather than as a negative line sitting among the positives.
const DRAWINGS_RX = /drawing|withdrawal|withdrawn/i;

const matches = (rx, ...texts) => texts.some((t) => rx.test(String(t || "")));

/** True when any group name on the path from the top of the tree down to the account says non-current. */
const isNonCurrent = (path = []) => path.some((name) => NON_CURRENT_RX.test(String(name || "")));

/**
 * Group names from the top of the tree down to the group itself, memoised.
 * `groups` is the whole AccountGroup list ({ _id, name, parentGroup }); the returned function takes a
 * group id. A cycle in the tree would otherwise loop for ever, so each walk remembers where it has been.
 */
function pathBuilder(groups = []) {
  const byId = new Map(groups.map((g) => [String(g._id), g]));
  const cache = new Map();
  return function pathNames(id) {
    if (!id) return [];
    const key = String(id);
    if (cache.has(key)) return cache.get(key);
    const names = [];
    const seen = new Set();
    let g = byId.get(key);
    while (g && !seen.has(String(g._id))) {
      seen.add(String(g._id));
      names.unshift(g.name);
      g = g.parentGroup ? byId.get(String(g.parentGroup)) : null;
    }
    cache.set(key, names);
    return names;
  };
}

/** Lower sorts first. `row` carries category, accountName, path[] and isCash. */
function presentationRank(row) {
  const text = [row.accountName, ...(row.path || [])];
  if (row.category === "ASSET") {
    if (row.isCash) return 9;
    if (matches(INVENTORY_RX, ...text)) return 1;
    if (matches(RECEIVABLE_RX, ...text)) return 2;
    return 5;
  }
  if (row.category === "LIABILITY") return matches(PAYABLE_RX, ...text) ? 1 : 5;
  if (row.category === "EQUITY") {
    if (matches(DRAWINGS_RX, row.accountName)) return 8; // under the capital it reduces
    if (matches(SHARE_CAPITAL_RX, ...text)) return 1;
    if (matches(RETAINED_RX, ...text)) return 2;
    return 3;
  }
  return 5;
}

const isDrawings = (row) => matches(DRAWINGS_RX, row?.accountName);

module.exports = {
  NON_CURRENT_RX, INVENTORY_RX, RECEIVABLE_RX, PAYABLE_RX, RETAINED_RX, SHARE_CAPITAL_RX, DRAWINGS_RX,
  matches, isNonCurrent, pathBuilder, presentationRank, isDrawings,
};
