// Finding a vendor or a customer by the name a person typed, for the assistant's tools. Shared by the tools that
// PREPARE documents (actionTools.js) and the ones that LOOK THINGS UP (dataTools.js), so both read a name the same
// way: one match is the party, several are CHOICES for the person (never a guess), none is a plain sentence.
const rules = require("../../utils/assistantProposals");
const vendorService = require("../vendor/vendorService");
const customerService = require("../customer/customerService");

/** Leaves out a party switched off or blocked: nobody pays, invoices or asks after one of those by name. */
const live = (rows, statusField = "status") => (rows || []).filter((r) => !/inactive|blocked/i.test(String(r[statusField] || "")));

/** "Which vendor do you mean? Al Noor Steel, Al Noor Trading." The answer when a name fits several things. */
const choiceReply = (question, names, more = 0, close = "Tell me which one and I will prepare it.") =>
  `${question} ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}. ${close}`;

/** -> { party: { id, name } } | { choices: [name], more } | { error } */
async function findParty(kind, query) {
  const search = String(query || "").trim();
  if (!search) return { error: `Who is the ${kind}?` };
  const rows = live(await (kind === "vendor" ? vendorService.getAllVendors({ search }) : customerService.getAllCustomers({ search })));
  const nameField = kind === "vendor" ? "vendorName" : "customerName";
  const r = rules.rankByName(rows, search, (x) => x[nameField]);
  if (r.match) return { party: { id: String(r.match._id), name: r.match[nameField] } };
  if (r.choices) return { choices: r.choices.map((c) => c.name), more: r.more };
  return { error: `I could not find a ${kind} called "${search}". Tell me the name as it appears in Zarvia, or part of it.` };
}

/** Parties already called something like this, switched off or not: -> { exact: name | null, similar: [name] } */
async function sameName(kind, query) {
  const search = String(query || "").trim();
  const rows = await (kind === "vendor" ? vendorService.getAllVendors({ search }) : customerService.getAllCustomers({ search }));
  const nameField = kind === "vendor" ? "vendorName" : "customerName";
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
  const names = (rows || []).map((r) => r[nameField]).filter(Boolean);
  const exact = names.find((n) => norm(n) === norm(search)) || null;
  return { exact, similar: names.filter((n) => n !== exact).sort().slice(0, 3) };
}

module.exports = { live, choiceReply, findParty, sameName };
