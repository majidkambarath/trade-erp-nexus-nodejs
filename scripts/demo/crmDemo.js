// A small, believable CRM for a demo: seven enquiries, a few of them qualified into real customers and deals, and
// the calls and visits that go with them.
//
// It goes through the REAL services, not through raw inserts. So every row here is one the product itself would have
// written: the round robin picks the owner, the lead is scored, qualifying creates a true Customer with its ledger
// account, and entering a stage leaves exactly one follow-up behind it. A demo built by hand would look right and
// behave wrong; this one cannot.
//
//   node scripts/demo/crmDemo.js --org=brivox-production
//   node scripts/demo/crmDemo.js --org=brivox-production --undo
//
// `--undo` removes the CRM rows it made. It deliberately does NOT remove the customers that qualifying created:
// those are real master data with ledger accounts behind them, and deleting them belongs to a person, not a script.
require("dotenv").config();
const mongoose = require("mongoose");
const { runWithTenant } = require("../../utils/tenantContext");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const ORG = arg("org");
const UNDO = process.argv.includes("--undo");
const MARK = "crm-demo"; // what every row this script writes is stamped with, so --undo is exact

// Seven enquiries a fabrication and coating business would actually take, in the order they came in.
const ENQUIRIES = [
  { name: "Ramesh Iyer", company: "Sundaram Engineering Works", city: "Coimbatore", phone: "9842011234", email: "ramesh@sundaramworks.in",
    source: "referral", sourceNote: "Sent by Kumar at Precision Tools", interest: "Powder coating, 500 brackets a month", expectedValue: 185000 },
  { name: "Priya Nair", company: "Nair Metal Fabricators", city: "Kochi", phone: "9847022345", email: "priya@nairmetal.in",
    source: "website", interest: "MS sheet cutting and bending, one-off", expectedValue: 92000 },
  { name: "Arjun Mehta", company: "Mehta Auto Components", city: "Pune", phone: "9822033456", email: "arjun@mehtaauto.in",
    source: "exhibition", sourceNote: "Met at IMTEX", interest: "Trial run on the coating line", expectedValue: 240000 },
  { name: "Fatima Sheikh", company: "Deccan Steel Traders", city: "Hyderabad", phone: "9849044567", email: "fatima@deccansteel.in",
    source: "walk_in", interest: "Angles and channels, bulk", expectedValue: 310000 },
  { name: "Vikram Rao", company: "Rao Industrial Supplies", city: "Chennai", phone: "9840055678", email: "vikram@raoindustrial.in",
    source: "repeat", sourceNote: "Bought from us two years ago", interest: "Annual coating contract", expectedValue: 450000 },
  { name: "Sneha Pillai", company: "Pillai Kitchen Equipment", city: "Kozhikode", phone: "9846066789", email: "sneha@pillaikitchen.in",
    source: "phone", interest: "Stainless fabrication for commercial kitchens", expectedValue: 128000 },
  { name: "Imran Qureshi", company: "Qureshi Engineering", city: "Bengaluru", phone: "9845077890", email: "imran@qureshieng.in",
    source: "whatsapp", interest: "Job work, small batches", expectedValue: 76000 },
];

const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function wipe(M) {
  const made = { leads: 0, deals: 0, activities: 0, contacts: 0 };
  made.activities = (await M.Act.deleteMany({ createdBy: MARK })).deletedCount;
  made.deals = (await M.Opp.deleteMany({ createdBy: MARK })).deletedCount;
  made.leads = (await M.Lead.deleteMany({ createdBy: MARK })).deletedCount;
  made.contacts = (await M.Contact.deleteMany({ createdBy: MARK })).deletedCount;
  const Quotation = require("../../models/modules/quotationModel");
  made.quotations = (await Quotation.deleteMany({ createdBy: MARK })).deletedCount;
  return made;
}

async function seed(M) {
  const existing = await M.Lead.countDocuments({ createdBy: MARK });
  if (existing) {
    console.log(`${existing} demo enquiries are already here. Run with --undo first if you want them again.`);
    return;
  }
  // The pipeline seeds itself on first read, so there is nothing to set up before this.
  const stages = await M.Setup.stages();
  console.log(`pipeline: ${stages.map((s) => s.name).join(" -> ")}`);

  const leads = [];
  for (const e of ENQUIRIES) {
    const lead = await M.Lead_.create(e, MARK);
    leads.push(lead);
    console.log(`  enquiry ${lead.leadNo}  ${lead.name.padEnd(16)} ${lead.company.padEnd(28)} ${lead.band} (${lead.score})`);
  }

  // Three of them are worth a real deal. Qualifying makes a true Customer - with its ledger account and, since
  // wave 2, the person who actually enquired as a contact of it.
  const deals = [];
  const Customer = require("../../models/modules/customerModel");
  for (const [i, value, close] of [[4, 450000, day(12)], [0, 185000, day(25)], [2, 240000, day(40)]]) {
    // Re-use the customer of the same name if one is already here. Running this twice should not leave an
    // organisation with two "Rao Industrial Supplies", each with its own ledger account.
    const already = await Customer.findOne({ customerName: leads[i].company }).select("_id").lean();
    const { lead, opportunity, customerId } = await M.Lead_.qualify(
      String(leads[i]._id),
      { value, expectedCloseDate: close, ...(already ? { customerId: String(already._id) } : {}) },
      MARK
    );
    await M.Opp.updateOne({ _id: opportunity._id }, { $set: { createdBy: MARK } });
    deals.push(opportunity);
    console.log(`  qualified ${lead.leadNo} -> customer ${String(customerId).slice(-6)} and deal ${opportunity.opportunityNo}`);
  }

  // Move them along by hand, the way a person would before any document exists. Each move leaves its own follow-up.
  await M.Opp_.moveStage(String(deals[0]._id), { stageKey: "quoted" }, MARK);
  await M.Opp_.moveStage(String(deals[1]._id), { stageKey: "qualified" }, MARK);

  // One won and one lost, so every report has something to say. A lost deal must give its reason - that rule is
  // what makes "why deals are lost" worth reading.
  await M.Opp_.win(String(deals[0]._id), { value: 468000 }, MARK);
  const lostDeal = await M.Opp_.create(
    { title: "Deccan Steel - angles and channels", customerId: String(deals[1].customerId), value: 310000, expectedCloseDate: day(-5), source: "walk_in" },
    MARK
  );
  await M.Opp.updateOne({ _id: lostDeal._id }, { $set: { createdBy: MARK } });
  await M.Opp_.lose(String(lostDeal._id), { reason: "price", note: "Went with a local coater at a lower rate" }, MARK);
  console.log(`  won ${deals[0].opportunityNo}, lost ${lostDeal.opportunityNo}`);
  return { leads, deals, lostDeal };
}

// What was actually said. A note is recorded done the moment it is written; a call with a due date in the past is
// what makes "What is late" on the dashboard say something real.
async function talk(M, leads, deals) {
  const rows = [
    { kind: "call", subject: "Rang about the coating rates", regarding: { kind: "opportunity", id: String(deals[0]._id) }, done: "interested" },
    { kind: "visit", subject: "Visited the Coimbatore works", regarding: { kind: "opportunity", id: String(deals[1]._id) }, done: "spoke" },
    { kind: "note", subject: "They coat in-house today, so price is the whole argument", regarding: { kind: "opportunity", id: String(deals[1]._id) } },
    { kind: "call", subject: "Chase the signed contract copy", regarding: { kind: "opportunity", id: String(deals[0]._id) }, dueAt: day(-3) },
    { kind: "whatsapp", subject: "Send the sample photographs", regarding: { kind: "lead", id: String(leads[5]._id) }, dueAt: day(-1) },
    { kind: "call", subject: "First call - find out what they coat", regarding: { kind: "lead", id: String(leads[6]._id) }, dueAt: day(0) },
    { kind: "meeting", subject: "Works visit with the production head", regarding: { kind: "opportunity", id: String(deals[2]._id) }, dueAt: day(2) },
  ];
  let open = 0;
  let done = 0;
  for (const r of rows) {
    const made = await M.Act_.create({ kind: r.kind, subject: r.subject, regarding: r.regarding, dueAt: r.dueAt }, MARK);
    await M.Act.updateOne({ _id: made._id }, { $set: { createdBy: MARK } });
    if (r.done) {
      await M.Act_.done(String(made._id), { outcome: r.done }, MARK);
      done += 1;
    } else if (made.status === "OPEN") open += 1;
  }
  console.log(`  logged ${rows.length} calls, visits and notes (${done} finished, ${open} still owed)`);
}

// Two more people at a customer we already deal with: the person who signs and the person who actually rings.
async function people(M, deals) {
  const customerId = String(deals[0].customerId);
  for (const c of [
    { name: "Lakshmi Raghavan", designation: "Purchase Head", email: "lakshmi@raoindustrial.in", phone: "9840055679", customerId },
    { name: "Suresh Babu", designation: "Stores In-charge", phone: "9840055680", customerId },
  ]) {
    const made = await M.Contact_.create(c, MARK);
    await M.Contact.updateOne({ _id: made._id }, { $set: { createdBy: MARK } });
  }
  console.log("  added 2 more people at the customer we already deal with");
}


// The part worth showing. A real quotation is raised against a real customer and marked sent, and the deal in front
// of it advances BY ITSELF - no stage was chosen by a person. Accepting the second one advances it again. This is
// what fills "Moved by itself" on the dashboard, and it is the module's whole argument demonstrated rather than
// described.
async function offers(M, deals) {
  const Stock = require("../../models/modules/stockModel");
  const item = await Stock.findOne({ itemType: { $ne: "service" } }).select("_id itemName").lean();
  if (!item) {
    console.log("  no stock item to quote, so nothing was offered");
    return;
  }
  const quote = async (deal, qty, price) =>
    M.Quote.create(
      { partyId: String(deal.customerId), items: [{ itemId: String(item._id), qty, price }], notes: "Rates as discussed" },
      MARK
    );

  const first = await quote(deals[2], 400, 260);
  await M.Quote.transition(String(first._id), "send", {}, MARK);
  console.log(`  ${first.quotationNo} sent -> the deal moved itself`);

  const second = await quote(deals[1], 500, 310);
  await M.Quote.transition(String(second._id), "send", {}, MARK);
  await M.Quote.transition(String(second._id), "accept", { acceptedBy: "Ramesh Iyer" }, MARK);
  console.log(`  ${second.quotationNo} sent and accepted -> that deal moved itself twice`);
}

async function main() {
  if (!ORG) throw new Error("say which organisation: --org=<code>");
  await mongoose.connect(process.env.MONGO_URI);
  const M = {
    Lead: require("../../models/modules/crm/leadModel"),
    Opp: require("../../models/modules/crm/opportunityModel"),
    Act: require("../../models/modules/crm/crmActivityModel"),
    Contact: require("../../models/modules/crm/contactModel"),
    Lead_: require("../../services/crm/leadService"),
    Opp_: require("../../services/crm/opportunityService"),
    Act_: require("../../services/crm/activityService"),
    Contact_: require("../../services/crm/contactService"),
    Setup: require("../../services/crm/crmSetupService"),
    Quote: require("../../services/orderPurchase/quotationService"),
  };
  const Org = require("../../models/core/organisationModel");
  const org = await Org.findOne({ code: ORG }).lean();
  if (!org) throw new Error(`no organisation with code "${ORG}"`);

  await runWithTenant({ companyId: ORG, branchId: "main" }, async () => {
    if (UNDO) {
      const gone = await wipe(M);
      console.log(`removed from ${org.legalName}:`, gone);
      console.log("the customers that qualifying created were LEFT ALONE - they have ledger accounts behind them.");
      return;
    }
    console.log(`seeding ${org.legalName} (${org.baseCurrency})`);
    const made = await seed(M);
    if (!made) return;
    await talk(M, made.leads, made.deals);
    await people(M, made.deals);
    await offers(M, made.deals);
    console.log("done. Open CRM > Dashboard.");
  });
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
