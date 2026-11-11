// A month of a believable UAE workshop, into an organisation that ALREADY EXISTS, on dates you choose.
//
// scripts/demo/garageDemo.js is the right domain but makes its own organisation, writes no vouchers at
// all, buys once, and lands everything at wall-clock now. The abc-*.cjs engine is the right shape but
// drives the HTTP API and hardcodes 2025-2026 dates in fourteen places. This is the two put together:
// real services called in process, as garageDemo does, with every document placed on a given day.
//
//   node scripts/demo/workshopDemo.js --env=.env.golden-arrow --org=golden-arrow --from=2026-11-01 --to=2026-11-11
//   ... --yes                      actually write
//   ... --phase=masters,purchases  run only some phases
//
// Idempotent: every master is found-or-created and every phase counts what is already there first.
// There is no --undo - a job card past DRAFT cannot be deleted and a statutory number is never
// recycled. Use scripts/demo/wipeOrgData.js, which is built for that and resets the counters too.
//
// NOT seeded: cheques and card settlements (they need their own clearing lifecycle), CRM (not in the
// `standard` plan), production, job work, payroll.
const path = require("path");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const ENV_FILE = arg("env", ".env");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ENV_FILE) });

const CODE = arg("org", null);
const FROM = arg("from", "2026-11-01");
const TO = arg("to", null);
const EXPECT_HOST = arg("expect-host", null);
const BY = "workshop-demo";
const ONLY = (arg("phase", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const runs = (p) => !ONLY.length || ONLY.includes(p);

// A day-only date is stored at UTC midnight throughout this product: the same calendar day in every
// report, whatever zone it is read in.
let START = null;
let DAYS = 1;
const D = (n) => new Date(Date.UTC(START.y, START.m, START.d + Math.max(0, Math.min(Math.round(n), DAYS - 1))));
const iso = (d) => d.toISOString().slice(0, 10);

// Seeded, so the same command tells the same story twice (mulberry32, as abc-lib.cjs uses).
let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const made = {};
const note = (what, n = 1) => { if (n) made[what] = (made[what] || 0) + n; };
const say = (s) => console.log(`    ${s}`);

// ---------------------------------------------------------------------------------------------------
const PARTS = [
  ["PRT-PAD-F", "Brake pads - front (set)", 80, 180], ["PRT-PAD-R", "Brake pads - rear (set)", 70, 160],
  ["PRT-DISC", "Brake disc", 120, 260], ["PRT-OIL5", "Engine oil 5W-30 (5L)", 95, 190],
  ["PRT-OILF", "Oil filter", 22, 55], ["PRT-AIRF", "Air filter", 28, 70],
  ["PRT-CABF", "Cabin filter", 32, 80], ["PRT-BATT", "Battery 70Ah", 210, 420],
  ["PRT-WIPE", "Wiper blades (pair)", 35, 85], ["PRT-BULB", "Headlamp bulb", 25, 60],
  ["PRT-COOL", "Coolant (4L)", 40, 95], ["PRT-PLUG", "Spark plugs (set of 4)", 60, 140],
  ["PRT-BELT", "Serpentine belt", 55, 130], ["PRT-BUMP", "Front bumper", 600, 1200],
  ["PRT-LAMP", "Headlamp assembly", 350, 700], ["PRT-GAS", "A/C gas R134a (kg)", 45, 110],
];

const VENDORS = [
  ["GAV1", "Gulf Auto Parts Trading LLC", "Rashid Al Blooshi", "Al Quoz Industrial 3, Dubai", "Net 30"],
  ["GAV2", "Emirates Lubricants LLC", "Suresh Nair", "Jebel Ali, Dubai", "Net 30"],
  ["GAV3", "Shine Auto Paint Shop", "Mohammed Iqbal", "Ras Al Khor, Dubai", "Net 15"],
  ["GAV4", "Desert Tyre Centre", "Ahmed Siddiqui", "Al Qusais, Dubai", "Net 15"],
];

// [code, name, contact, phone, plate, emirate, make, model, year, colour]
const CUSTOMERS = [
  ["GAC01", "Ali Hassan", "0501234567", "A 11111", "Dubai", "Toyota", "Hilux", 2020, "White"],
  ["GAC02", "Fatima Al Suwaidi", "0509876543", "B 22222", "Dubai", "Honda", "Civic", 2019, "Silver"],
  ["GAC03", "Khalid Omar", "0507654321", "D 33333", "Dubai", "Nissan", "Patrol", 2022, "Black"],
  ["GAC04", "Mariam Al Zaabi", "0553331122", "E 44444", "Dubai", "Toyota", "Corolla", 2021, "Grey"],
  ["GAC05", "Rashid Trading LLC", "043334455", "F 55555", "Dubai", "Mitsubishi", "L200", 2018, "White"],
  ["GAC06", "Sunrise Facilities Management", "042221133", "G 66666", "Dubai", "Nissan", "Urvan", 2020, "White"],
  ["GAC07", "Noura Al Mansoori", "0544556677", "H 77777", "Sharjah", "Lexus", "ES 350", 2021, "Pearl"],
  ["GAC08", "Vikram Shetty", "0566778899", "I 88888", "Dubai", "Hyundai", "Tucson", 2022, "Blue"],
  ["GAC09", "Al Barsha Logistics", "044447788", "J 99999", "Dubai", "Ford", "Transit", 2019, "White"],
  ["GAC10", "Yousuf Al Hammadi", "0501119988", "K 10101", "Abu Dhabi", "Nissan", "Altima", 2020, "Black"],
  ["GAC11", "Priya Menon", "0522334455", "L 12121", "Dubai", "Kia", "Sportage", 2023, "Red"],
  ["GAC12", "Desert Rose Catering", "043337711", "M 13131", "Dubai", "Toyota", "Hiace", 2017, "White"],
];

const INSURERS = [["GAI1", "Orient Insurance PJSC", "044445555"], ["GAI2", "Oman Insurance Company", "042223344"]];
const STAFF = [["GAS1", "Raj Kumar", "Senior Technician"], ["GAS2", "Mahesh Patel", "Technician"],
  ["GAS3", "Imran Ali", "Body & Paint Technician"], ["GAS4", "Noel Fernandes", "Auto Electrician"]];

const COMPLAINTS = ["Brakes squealing when stopping", "Service due, dashboard light on", "A/C not cooling properly",
  "Battery dead, needed a jump start", "Rattling noise from the front", "Check-engine light on", "Oil leak under the engine",
  "Wipers smearing, need replacing", "Overheating in traffic", "Headlamp not working", "Rough idle and poor pickup"];

// [expense account, narration, NET amount, standard-rated?]
const EXPENSES = [
  ["Rent Expense", "Workshop rent - November 2026", 18000, false],
  ["Utilities", "DEWA - electricity and water", 3250, true],
  ["Waste Oil & Waste Disposal", "Licensed waste oil collection", 850, true],
  ["Tools & Equipment Maintenance", "Two-post lift annual service", 1200, true],
  ["Workshop Insurance", "Motor trade liability - monthly", 1450, false],
  ["Trade Licence & Government Fees", "DED trade licence renewal", 5200, false],
  ["Utilities", "Etisalat - internet and telephone", 620, true],
  ["Tools & Equipment Maintenance", "Diagnostic scanner subscription", 900, true],
  ["Waste Oil & Waste Disposal", "Scrap and filter disposal", 420, true],
  ["Utilities", "Workshop cleaning supplies", 380, true],
  ["Tools & Equipment Maintenance", "Air compressor repair", 1650, true],
  ["Rent Expense", "Staff accommodation - November", 6500, false],
];

const hostOf = (uri) => { const m = /@([^/?]+)/.exec(String(uri || "")); return m ? m[1] : "(unknown)"; };

// ---------------------------------------------------------------------------------------------------
// Everything resolved by NAME at run time, so no id is written into this file.
async function load() {
  const { LedgerAccount } = require("../../models/modules/financial/financialModels");
  const TaxCode = require("../../models/modules/financial/taxCodeModel");
  const UOM = require("../../models/modules/uomModel");
  const Category = require("../../models/modules/categoryModel");
  const Stock = require("../../models/modules/stockModel");

  const all = await LedgerAccount.find().lean();
  const byName = new Map(all.map((a) => [a.accountName.toLowerCase(), a]));
  const account = (name) => {
    const a = byName.get(String(name).toLowerCase());
    if (!a) throw new Error(`no ledger account named "${name}" - has scripts/setup/garageClient.js been run?`);
    return a;
  };
  const std = await TaxCode.findOne({ kind: "standard", isActive: { $ne: false } }).lean();
  if (!std) throw new Error("no standard tax code - the UAE starter set is seeded only for an AE organisation");

  let each = await UOM.findOne({ unitName: /^each$/i }).lean();
  if (!each) each = (await UOM.findOne().lean());
  let category = await Category.findOne({ name: /^workshop services$/i }).lean();
  if (!category) category = (await Category.create({ name: "Workshop Services", status: "Active" })).toObject();

  const labour = {};
  for (const sku of ["LAB-MECH", "LAB-ELEC", "LAB-AC", "LAB-BODY", "LAB-SERV", "SUB-WORK", "SHOP-SUP"]) {
    const s = await Stock.findOne({ sku }).lean();
    if (!s) throw new Error(`service item ${sku} is missing - run scripts/setup/garageClient.js first`);
    labour[sku] = s;
  }
  // Transaction.createdBy and JobCard.createdBy are strings, but Voucher.createdBy is an ObjectId and
  // refuses anything else. Vouchers are therefore attributed to a real account - the owner - which is
  // also what a reader of the audit trail would expect to see.
  const Admin = require("../../models/core/adminModel");
  const owner = await Admin.findOne({ type: "super_admin" }).sort({ createdAt: 1 }).lean()
    || await Admin.findOne().lean();
  if (!owner) throw new Error("this organisation has no administrator to attribute vouchers to");

  return {
    account, std, each, category, labour, adminId: owner._id,
    bank: account("Bank Account"), cash: account("Cash in Hand"), petty: account("Petty Cash"),
    M: {
      Stock, Customer: require("../../models/modules/customerModel"), Vendor: require("../../models/modules/vendorModel"),
      Staff: require("../../models/modules/staffModel"), Transaction: require("../../models/modules/transactionModel"),
      Voucher: require("../../models/modules/financial/financialModels").Voucher,
      JobCard: require("../../models/modules/garage/jobCardModel"),
      Claim: require("../../models/modules/garage/insuranceClaimModel"),
      StockService: require("../../services/stock/stockService"),
      Tx: require("../../services/orderPurchase/transactionService"),
      Fin: require("../../services/financial/financialService"),
      Vehicle: require("../../services/garage/vehicleService"),
      Cards: require("../../services/garage/jobCardService"),
      Claims: require("../../services/garage/insuranceClaimService"),
      Quotes: require("../../services/orderPurchase/quotationService"),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
async function seedMasters(c) {
  const { M } = c;
  let n = 0;
  for (const [sku, name, cost, price] of PARTS) {
    if (await M.Stock.findOne({ sku }).lean()) continue;
    await M.StockService.createStock({
      sku, itemName: name, categoryId: c.category._id, unitOfMeasure: c.each?._id,
      purchasePrice: cost, salesPrice: price, origin: "UAE", brand: "Workshop", itemType: "goods",
    }, BY);
    n += 1;
  }
  note("parts", n);

  n = 0;
  for (const [code, name, contact, address, terms] of VENDORS) {
    if (await M.Vendor.findOne({ vendorId: code }).lean()) continue;
    await M.Vendor.create({ vendorId: code, vendorName: name, contactPerson: contact, address, paymentTerms: terms });
    n += 1;
  }
  note("vendors", n);

  n = 0;
  for (const [code, name, phone] of CUSTOMERS.map((r) => [r[0], r[1], r[2]])) {
    if (await M.Customer.findOne({ customerId: code }).lean()) continue;
    await M.Customer.create({ customerId: code, customerName: name, contactPerson: name, phone,
      shippingAddress: "Dubai, UAE", paymentTerms: "Net 30", creditLimit: 0 });
    n += 1;
  }
  for (const [code, name, phone] of INSURERS) {
    if (await M.Customer.findOne({ customerId: code }).lean()) continue;
    await M.Customer.create({ customerId: code, customerName: name, contactPerson: "Claims Desk", phone,
      shippingAddress: "Dubai, UAE", paymentTerms: "Net 45", creditLimit: 0, isInsurer: true });
    n += 1;
  }
  note("customers & insurers", n);

  n = 0;
  for (const [code, name, designation] of STAFF) {
    if (await M.Staff.findOne({ staffId: code }).lean()) continue;
    await M.Staff.create({ staffId: code, name, designation, contactNo: "9715" + between(10000000, 99999999),
      idNo: `784-${code}`, joiningDate: new Date("2024-01-15"), createdBy: BY });
    n += 1;
  }
  note("staff", n);

  n = 0;
  for (const r of CUSTOMERS) {
    const [code, , , plate, emirate, make, model, year, colour] = r;
    if (await M.Vehicle.findByPlateOrChassis({ plateNumber: plate })) continue;
    const owner = await M.Customer.findOne({ customerId: code }).lean();
    await M.Vehicle.create({ plateNumber: plate, plateEmirate: emirate, make, model, year, colour,
      customerId: owner._id, odometer: between(20000, 140000) }, BY);
    n += 1;
  }
  note("vehicles", n);
}

// The money. Without it every payment overdraws the bank and equity opens negative - and with no
// opening balances (the owner's choice) a capital introduction is an ordinary journal, not an
// opening-balance voucher, so no go-live date is fixed.
async function capital(c) {
  if (await c.M.Voucher.findOne({ voucherType: "journal", narration: /capital introduced/i }).lean()) return;
  await c.M.Fin.createVoucher({
    voucherType: "journal", date: D(0), narration: "Capital introduced by the owner",
    lines: [
      { accountId: c.bank._id, debit: 400000, narration: "Capital introduced" },
      { accountId: c.account("Owner's Capital")._id, credit: 400000, narration: "Capital introduced" },
    ],
  }, c.adminId);
  note("capital journal", 1);
}

const lineFor = (c, part, qty, price) => ({
  itemId: part._id, description: part.itemName, qty, price,
  rate: r2(qty * price), taxCodeId: c.std._id,
});

async function purchases(c) {
  const { M } = c;
  const want = 12;
  const have = await M.Transaction.countDocuments({ type: "purchase_order" });
  if (have >= want) return;
  const parts = await M.Stock.find({ itemType: { $ne: "service" } }).lean();
  const vendors = await M.Vendor.find({ vendorId: { $in: ["GAV1", "GAV2", "GAV4"] } }).lean();

  // The first invoices walk the catalogue in order so EVERY part is bought before anything is sold;
  // the rest are random. Picking at random throughout left parts that a job card then sold from a
  // stock that was never bought, and the valuation showed an item on hand below zero.
  const perInvoice = Math.ceil(parts.length / 4);
  for (let i = have; i < want; i += 1) {
    const vendor = vendors[i % vendors.length];
    let chosen = [];
    if (i < 4) {
      chosen = parts.slice(i * perInvoice, (i + 1) * perInvoice);
    } else {
      for (let k = 0; k < between(3, 5); k += 1) {
        const p = pick(parts);
        if (!chosen.find((x) => String(x._id) === String(p._id))) chosen.push(p);
      }
    }
    if (!chosen.length) chosen = [pick(parts)];
    const items = chosen.map((p) => lineFor(c, p, between(10, 30), p.purchasePrice || 50));
    const t = await M.Tx.createTransaction({
      type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
      date: D(i * 0.7), items, vendorReference: `INV-${7100 + i}`,
      notes: "workshop-demo: parts purchase",
    }, BY);
    await M.Tx.processTransaction(t._id, "approve", BY);
    note("purchase invoices", 1);
  }
}

// 16 cards, left at every status so the board has something in each column.
// DELIVERED is last so that adding it later only ever appends: the stage of a card is decided by its
// index, so re-ordering this list would change what an already-created card was meant to be.
const CARD_PLAN = [
  ["CLOSED", 5], ["READY", 2], ["IN_PROGRESS", 3], ["AWAITING_APPROVAL", 2], ["DRAFT", 2], ["DELIVERED", 4],
];
// On a FRESH organisation that is 18 cards with every status represented. On an organisation seeded
// before DELIVERED was a distinct stage, the first sixteen came out as the other five statuses and
// these last four are what fill the board's sixth column.

async function buildCard(c, { customer, vehicle, day, stage, staff, withSublet }) {
  const { M } = c;
  const parts = await M.Stock.find({ itemType: { $ne: "service" } }).lean();
  const p1 = pick(parts);
  const p2 = pick(parts.filter((p) => String(p._id) !== String(p1._id)));
  const lab = pick([c.labour["LAB-MECH"], c.labour["LAB-ELEC"], c.labour["LAB-AC"], c.labour["LAB-SERV"]]);

  const lines = [
    { kind: "part", itemId: p1._id, qty: between(1, 2), price: p1.salesPrice, taxCodeId: c.std._id },
    { kind: "part", itemId: p2._id, qty: 1, price: p2.salesPrice, taxCodeId: c.std._id },
    { kind: "labour", itemId: lab._id, qty: between(1, 3), price: lab.salesPrice, taxCodeId: c.std._id },
  ];
  // Shop supplies charged on the invoice. It is a SERVICE item, so it rides on a labour line: a
  // `consumable` line needs a stocked goods item (jobCardService checks kind against the item
  // master and answers LINE_KIND_MISMATCH otherwise).
  lines.push({ kind: "labour", itemId: c.labour["SHOP-SUP"]._id, qty: 1, price: c.labour["SHOP-SUP"].salesPrice, taxCodeId: c.std._id });
  if (withSublet) {
    const paint = await M.Vendor.findOne({ vendorId: "GAV3" }).lean();
    lines.push({ kind: "sublet", itemId: c.labour["SUB-WORK"]._id, qty: 1, price: between(300, 900), vendorId: paint._id, taxCodeId: c.std._id });
  }

  let card = await M.Cards.create({
    vehicleId: vehicle._id, customerId: customer._id, jobType: "retail",
    receivedAt: D(day), odometerIn: between(20000, 150000), fuelLevelIn: pick(["E", "1/4", "1/2", "3/4", "F"]),
    promisedAt: D(day + 1), complaints: [{ concern: pick(COMPLAINTS) }],
    lines, tasks: [{ name: "Diagnose and repair", mode: "in_house", stage: 1, standardHours: between(1, 4), staffId: staff._id }],
    notes: "workshop-demo",
  }, BY);
  if (stage === "DRAFT") return card;

  card = await M.Cards.recordCheckIn(card._id, {
    itemsPresent: ["Spare wheel", "Jack and tools", "Registration card"],
    damagePoints: [{ panel: pick(["Rear bumper", "Front wing", "Driver door"]), kind: pick(["scratch", "dent", "chip"]), notes: "Pre-existing" }],
    notes: "Checked in at the gate.",
  }, BY);
  card = await M.Cards.sendEstimate(card._id, BY);
  if (stage === "AWAITING_APPROVAL") return card;

  card = await M.Cards.recordApproval(card._id, { method: pick(["whatsapp", "call", "counter"]), note: "Approved the estimate" }, BY);
  if (stage === "IN_PROGRESS") { await M.Cards.startTask(card._id, card.tasks[0]._id, BY); return card; }

  for (const t of card.tasks) {
    await M.Cards.startTask(card._id, t._id, BY);
    card = await M.Cards.completeTask(card._id, t._id, { actualHours: t.standardHours }, BY);
  }
  if (stage === "READY") return card;

  // "The car went out, the counter has not rung it up yet" - a real scene, and the one the
  // Receivables screen and the board's "delivered, not invoiced" count exist to show. Releasing
  // before invoicing needs onAccount, or mayRelease refuses with PAYMENT_DUE.
  if (stage === "DELIVERED") {
    return M.Cards.releaseVehicle(card._id, {
      odometerOut: between(20000, 150000), handedTo: customer.customerName, warrantyMonths: 3, onAccount: true,
    }, BY);
  }

  const { invoice } = await M.Cards.createInvoice({ jobCardId: card._id, billTo: "customer", date: D(day + 1) }, BY);
  await M.Tx.processTransaction(invoice._id, "approve", BY);
  note("sales invoices", 1);
  card = await M.Cards.releaseVehicle(card._id, {
    odometerOut: between(20000, 150000), handedTo: customer.customerName, warrantyMonths: 3, onAccount: true,
  }, BY);
  return card;
}

async function jobCards(c) {
  const { M } = c;
  const have = await M.JobCard.countDocuments({ notes: /workshop-demo/ });
  const total = CARD_PLAN.reduce((s, [, n]) => s + n, 0);
  if (have >= total) return;

  const customers = await M.Customer.find({ isInsurer: { $ne: true }, customerId: /^GAC/ }).lean();
  const staff = await M.Staff.find({ staffId: /^GAS/ }).lean();
  const wanted = [];
  for (const [stage, n] of CARD_PLAN) for (let i = 0; i < n; i += 1) wanted.push(stage);

  for (let i = have; i < wanted.length; i += 1) {
    const customer = customers[i % customers.length];
    const vehicle = await M.Vehicle.findByPlateOrChassis({ plateNumber: CUSTOMERS[i % CUSTOMERS.length][3] });
    const card = await buildCard(c, {
      customer, vehicle, day: 2 + i * 0.5, stage: wanted[i], staff: staff[i % staff.length], withSublet: i % 5 === 0,
    });
    say(`${card.jobNo} -> ${card.status}`);
    note(`job cards`, 1);
  }
}

// An accident repair billed to the insurer and the customer from one decision. One claim per card.
async function claims(c) {
  const { M } = c;
  const want = 10;
  const have = await M.Claim.countDocuments();
  if (have >= want) return;

  const customers = await M.Customer.find({ isInsurer: { $ne: true }, customerId: /^GAC/ }).lean();
  const insurers = await M.Customer.find({ isInsurer: true }).lean();
  const staff = await M.Staff.find({ staffId: /^GAS/ }).lean();
  const bump = await M.Stock.findOne({ sku: "PRT-BUMP" }).lean();
  const lamp = await M.Stock.findOne({ sku: "PRT-LAMP" }).lean();

  for (let i = have; i < want; i += 1) {
    const customer = customers[(i + 3) % customers.length];
    const vehicle = await M.Vehicle.findByPlateOrChassis({ plateNumber: CUSTOMERS[(i + 3) % CUSTOMERS.length][3] });
    const day = 1 + i * 0.8;
    let card = await M.Cards.create({
      vehicleId: vehicle._id, customerId: customer._id, jobType: "insurance",
      receivedAt: D(day), odometerIn: between(20000, 150000), fuelLevelIn: "1/2",
      complaints: [{ concern: "Front-end collision, bumper and headlamp damaged" }],
      lines: [
        { kind: "part", itemId: bump._id, qty: 1, price: bump.salesPrice, taxCodeId: c.std._id },
        { kind: "part", itemId: lamp._id, qty: 1, price: lamp.salesPrice, taxCodeId: c.std._id },
        { kind: "labour", itemId: c.labour["LAB-BODY"]._id, qty: between(4, 8), price: c.labour["LAB-BODY"].salesPrice, taxCodeId: c.std._id },
      ],
      tasks: [{ name: "Replace bumper, repaint panel and fit headlamp", mode: "in_house", stage: 1, standardHours: 6, staffId: staff[i % staff.length]._id }],
      notes: "workshop-demo: accident repair",
    }, BY);
    card = await M.Cards.recordCheckIn(card._id, { itemsPresent: ["Registration card"], damagePoints: [{ panel: "Front bumper", kind: "broken", notes: "Accident damage" }], notes: "Towed in." }, BY);
    card = await M.Cards.sendEstimate(card._id, BY);
    card = await M.Cards.recordApproval(card._id, { method: "lpo", reference: `LPO-${4400 + i}`, note: "Insurer approved" }, BY);
    for (const t of card.tasks) {
      await M.Cards.startTask(card._id, t._id, BY);
      card = await M.Cards.completeTask(card._id, t._id, { actualHours: 6 }, BY);
    }

    const insurer = insurers[i % insurers.length];
    let claim = await M.Claims.create({
      insurerId: insurer._id, jobCardId: card._id, policyNo: `POL-${90000 + i}`, policyHolder: customer.customerName,
      insurerClaimNo: `CLM-REF-${5200 + i}`, accidentDate: D(Math.max(0, day - 1)), reportedDate: D(day),
      policeReportNo: `PR-${7700 + i}`, notes: "workshop-demo",
    }, BY);
    claim = await M.Claims.submit(claim._id, BY);
    claim = await M.Claims.recordSurvey(claim._id, { surveyorName: pick(["A. Khan", "S. Thomas", "M. Farouk"]), company: "Gulf Surveyors", visitedAt: D(day + 1), notes: "Damage consistent with the report." }, BY);
    claim = await M.Claims.recordApproval(claim._id, {
      status: "PARTLY_APPROVED", lpoNo: `LPO-${4400 + i}`, approvedAmount: r2(bump.salesPrice + lamp.salesPrice),
      note: "Excess and depreciation to the customer",
      deductions: { excess: 500, partsDepreciationPct: 10, depreciablePartsAmount: r2(bump.salesPrice) },
    }, BY);
    // Two DRAFTS come out of one decision - the insurer's repair and the customer's excess and
    // depreciation - and neither posts until it is approved. Re-read the claim rather than trust the
    // return shape, then approve each by its transaction id.
    await M.Claims.raiseInvoices(claim._id, BY);
    const after = await M.Claim.findById(claim._id).lean();
    for (const inv of after.invoices || []) {
      await M.Tx.processTransaction(inv.transactionId, "approve", BY);
      note("sales invoices", 1);
    }
    say(`${card.jobNo} / ${claim.claimNo} -> ${claim.status}`);
    note("insurance claims", 1);
  }
}

const settle = (inv, part) => {
  const out = r2(inv.outstandingAmount);
  const amount = part ? r2(out / 2) : out;
  return { invoiceId: inv._id, amount, balance: r2(out - amount) };
};

async function receipts(c) {
  const { M } = c;
  const want = 12;
  const have = await M.Voucher.countDocuments({ voucherType: "receipt" });
  if (have >= want) return;
  const open = await M.Transaction.find({ type: "sales_order", status: "APPROVED", outstandingAmount: { $gt: 0.01 } }).lean();
  if (!open.length) { say("no open sales invoices to settle - run the jobcards phase first"); return; }

  for (let i = have; i < want && i - have < open.length; i += 1) {
    const inv = open[i - have];
    const link = settle(inv, i % 3 === 0);
    // Half the takings in cash: a workshop is a counter trade, and without cash coming IN the
    // "cash banked" contras below would push Cash in Hand negative.
    const mode = i % 2 === 0 ? "cash" : (i % 4 === 1 ? "bank" : "transfer");
    await M.Fin.createVoucher({
      voucherType: "receipt", customerId: inv.partyId, totalAmount: link.amount, date: D(5 + (i % 6)),
      paymentMode: mode,
      paymentDetails: mode === "cash" ? { accountId: c.cash._id, reference: `CR-${3300 + i}` }
        : { accountId: c.bank._id, reference: `DEP-${8800 + i}` },
      linkedInvoices: [link], narration: `Received against ${inv.transactionNo}`,
    }, c.adminId);
    note("receipts", 1);
  }
}

async function payments(c) {
  const { M } = c;
  const want = 12;
  const have = await M.Voucher.countDocuments({ voucherType: "payment" });
  if (have >= want) return;
  const open = await M.Transaction.find({ type: "purchase_order", status: "APPROVED", outstandingAmount: { $gt: 0.01 } }).lean();
  if (!open.length) { say("no open purchase invoices to settle - run the purchases phase first"); return; }

  for (let i = have; i < want && i - have < open.length; i += 1) {
    const inv = open[i - have];
    const link = settle(inv, i % 4 === 0);
    await M.Fin.createVoucher({
      voucherType: "payment", vendorId: inv.partyId, totalAmount: link.amount, date: D(6 + (i % 5)),
      paymentMode: "transfer", paymentDetails: { accountId: c.bank._id, reference: `TT-${6600 + i}` },
      linkedInvoices: [link], narration: `Paid against ${inv.transactionNo}`,
    }, c.adminId);
    note("payments", 1);
  }
}

async function expenses(c) {
  const { M } = c;
  const have = await M.Voucher.countDocuments({ voucherType: "expense" });
  if (have >= EXPENSES.length) return;
  for (let i = have; i < EXPENSES.length; i += 1) {
    const [acc, description, amount, vat] = EXPENSES[i];
    await M.Fin.createVoucher({
      voucherType: "expense", ledgerBased: true, expenseAccountId: c.account(acc)._id,
      amount, description, date: D(1 + (i % (DAYS - 1 || 1))),
      // Petty cash pays for small things; rent and the trade licence go by bank. Paying an 18,000
      // rent out of the till is how the cash account ends the month overdrawn, which cannot happen
      // in life and reads on the balance sheet as "Cash shortfall".
      paymentMode: amount < 1000 ? "cash" : "bank",
      paymentDetails: amount < 1000 ? { accountId: c.petty._id, reference: `PC-${100 + i}` } : { accountId: c.bank._id, reference: `EXP-${5500 + i}` },
      ...(vat ? { taxCodeId: c.std._id, vatAmount: r2(amount * 0.05) } : {}),
    }, c.adminId);
    note("expenses", 1);
  }
}

async function journals(c) {
  const { M } = c;
  const want = 10;
  const have = await M.Voucher.countDocuments({ voucherType: "journal" });
  if (have >= want) return;
  // NOTHING here may touch Inventory Stock. Crediting it by journal writes stock down with no
  // movement behind it, and StockReportsService.ledgerCheck then reports the difference under
  // "Journals and other vouchers posted to Inventory - posted to the ledger by hand; no stock
  // movement stands behind them". Stock leaves through a document or a stock adjustment, never a
  // journal. (An earlier version of this list credited Inventory three times and put the
  // reconciliation out by exactly those 7,100.)
  //
  // The accruals are held in Salaries Payable because the starter chart has no Accrued Expenses
  // account and this script must not add one - the wipe checks the chart back to its setup size.
  const plan = [
    ["Technician wages for November moved to cost of sales", "Workshop Wages - Technicians", "Salaries & Wages", 22000],
    ["Accrual - November electricity not yet billed", "Utilities", "Salaries Payable", 900],
    ["Accrual - waste disposal contract", "Waste Oil & Waste Disposal", "Salaries Payable", 350],
    ["Prepaid insurance released for November", "Workshop Insurance", "Salaries Payable", 1450],
    ["Accrual - paint supplier, materials not yet billed", "Paint & Body Materials", "Salaries Payable", 2600],
    ["Accrual - workshop consumables not yet billed", "Consumables & Shop Supplies", "Salaries Payable", 1400],
    ["Accrual - coater's sublet charges not yet billed", "Sublet & Subcontract Charges", "Salaries Payable", 3100],
    ["Accrual - lift service contract", "Tools & Equipment Maintenance", "Salaries Payable", 1800],
    ["Petty cash count difference written off", "Utilities", "Petty Cash", 45],
  ];
  // `have` already counts the capital journal, which is one of the ten.
  for (let i = Math.max(0, have - 1); i < plan.length; i += 1) {
    const [narration, dr, cr, amount] = plan[i];
    await M.Fin.createVoucher({
      voucherType: "journal", date: D(3 + (i % 7)), narration,
      lines: [{ accountId: c.account(dr)._id, debit: amount, narration }, { accountId: c.account(cr)._id, credit: amount, narration }],
    }, c.adminId);
    note("journals", 1);
  }
}

async function contras(c) {
  const { M } = c;
  const want = 10;
  const have = await M.Voucher.countDocuments({ voucherType: "contra" });
  if (have >= want) return;
  for (let i = have; i < want; i += 1) {
    const toBank = i % 2 === 0;
    await M.Fin.createVoucher({
      voucherType: "contra", ledgerBased: true,
      fromAccountId: toBank ? c.cash._id : c.bank._id,
      toAccountId: toBank ? c.bank._id : c.petty._id,
      // The petty-cash top-ups must comfortably exceed the small expenses routed to petty above
      // (about 3,200 over the month), or the float ends the month overdrawn - which a cash box
      // cannot be, and which reads on the balance sheet as a "Cash shortfall".
      totalAmount: toBank ? between(1, 3) * 400 : between(2, 6) * 250,
      date: D(2 + (i % 8)),
      narration: toBank ? "Cash takings banked" : "Petty cash drawn from the bank",
    }, c.adminId);
    note("contras", 1);
  }
}

async function notes(c) {
  const { M } = c;
  const wantEach = 10;
  const haveC = await M.Voucher.countDocuments({ voucherType: "credit_note" });
  const haveD = await M.Voucher.countDocuments({ voucherType: "debit_note" });

  const sales = await M.Transaction.find({ type: "sales_order", status: "APPROVED", outstandingAmount: { $gt: 1 } }).lean();
  for (let i = haveC; i < wantEach && i - haveC < sales.length; i += 1) {
    const inv = sales[i - haveC];
    const amount = Math.min(r2(inv.outstandingAmount / 4), 250);
    if (amount < 1) continue;
    await M.Fin.createVoucher({
      voucherType: "credit_note", partyId: inv.partyId, partyType: "Customer", date: D(7 + (i % 4)),
      narration: `Goodwill allowance on ${inv.transactionNo}`, taxCodeId: c.std._id,
      lines: [{ accountId: c.account("Sales Returns")._id, amount, description: "Goodwill allowance" }],
      referenceInvoiceId: inv._id,
    }, c.adminId);
    note("credit notes", 1);
  }

  const vendors = await M.Vendor.find({ vendorId: /^GAV/ }).lean();
  for (let i = haveD; i < wantEach; i += 1) {
    await M.Fin.createVoucher({
      voucherType: "debit_note", partyId: vendors[i % vendors.length]._id, partyType: "Vendor", date: D(6 + (i % 5)),
      narration: "Price variance charged back to the supplier", taxCodeId: c.std._id,
      lines: [{ accountId: c.account("Purchase Variance")._id, amount: between(2, 9) * 50, description: "Price variance" }],
    }, c.adminId);
    note("debit notes", 1);
  }
}

async function returns(c) {
  const { M } = c;
  const want = 6;

  // A part sold and brought back. Only PART lines are returned: a labour line is work already done,
  // and a service item moves no stock, so crediting it back as a return would say the hours were
  // never worked.
  const haveSR = await M.Transaction.countDocuments({ type: "sales_return" });
  if (haveSR < want) {
    const sold = await M.Transaction.find({ type: "sales_order", status: "APPROVED", isOpening: { $ne: true } }).lean();
    // Walk the whole list rather than index into it: a claim's CUSTOMER invoice is excess and
    // depreciation only - every line a service - so the first several invoices have nothing
    // returnable, and indexing by position found only those and gave up.
    let i = haveSR;
    for (const src of sold) {
      if (i >= want) break;
      const goods = [];
      for (const line of src.items || []) {
        const item = await M.Stock.findById(line.itemId).lean();
        if (item && item.itemType !== "service") goods.push({ line, item });
      }
      if (!goods.length) continue;
      i += 1;
      const { line } = goods[0];
      const qty = 1;
      const t = await M.Tx.createTransaction({
        type: "sales_return", partyId: src.partyId, partyType: "Customer", partyTypeRef: "Customer",
        date: D(8 + (i % 3)), returnOf: { transactionId: src._id },
        items: [{ itemId: line.itemId, description: line.description, qty, price: line.price, rate: r2(qty * line.price), taxCodeId: c.std._id }],
        notes: "workshop-demo: part returned by the customer",
      }, BY);
      await M.Tx.processTransaction(t._id, "approve", BY);
      note("sales returns", 1);
    }
  }

  const havePR = await M.Transaction.countDocuments({ type: "purchase_return" });
  if (havePR >= want) return;
  const bought = await M.Transaction.find({ type: "purchase_order", status: "APPROVED" }).lean();
  for (let i = havePR; i < want && i - havePR < bought.length; i += 1) {
    const src = bought[i - havePR];
    const line = (src.items || [])[0];
    if (!line) continue;
    const qty = Math.max(1, Math.floor((line.qty || 1) / 4));
    const t = await M.Tx.createTransaction({
      type: "purchase_return", partyId: src.partyId, partyType: "Vendor", partyTypeRef: "Vendor",
      date: D(8 + (i % 3)), returnOf: { transactionId: src._id },
      items: [{ itemId: line.itemId, description: line.description, qty, price: line.price, rate: r2(qty * line.price), taxCodeId: c.std._id }],
      notes: "workshop-demo: wrong part supplied",
    }, BY);
    await M.Tx.processTransaction(t._id, "approve", BY);
    note("purchase returns", 1);
  }
}

async function paper(c) {
  const { M } = c;
  const want = 10;
  const Quotation = require("../../models/modules/quotationModel");
  const have = await Quotation.countDocuments();
  if (have >= want) return;
  const customers = await M.Customer.find({ isInsurer: { $ne: true }, customerId: /^GAC/ }).lean();
  const parts = await M.Stock.find({ itemType: { $ne: "service" } }).lean();

  for (let i = have; i < want; i += 1) {
    const customer = customers[i % customers.length];
    const p = pick(parts);
    const lab = c.labour["LAB-MECH"];
    const q = await M.Quotes.create({
      partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer",
      date: D(1 + (i % 8)), validUntil: D(DAYS - 1),
      items: [
        { itemId: p._id, description: p.itemName, qty: 1, price: p.salesPrice, rate: r2(p.salesPrice), taxCodeId: c.std._id },
        { itemId: lab._id, description: lab.itemName, qty: 2, price: lab.salesPrice, rate: r2(2 * lab.salesPrice), taxCodeId: c.std._id },
      ],
      notes: "workshop-demo: estimate for approval",
    }, BY);
    if (i % 3 !== 2) await M.Quotes.transition(q._id, "send", {}, BY);
    if (i % 3 === 0) await M.Quotes.transition(q._id, "accept", {}, BY);
    if (i % 3 === 1) await M.Quotes.transition(q._id, "reject", { reason: "Went elsewhere on price" }, BY);
    note("quotations", 1);
  }
}

// ---------------------------------------------------------------------------------------------------
async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error(`MONGO_URI is not set. Is ${ENV_FILE} there?`);
  if (!CODE) throw new Error("--org=<code> is required; this script never creates an organisation.");
  if (process.env.NODE_ENV === "test") throw new Error("refusing to run with NODE_ENV=test");
  const host = hostOf(uri);
  if (EXPECT_HOST && !host.includes(EXPECT_HOST)) throw new Error(`MONGO_URI names ${host}, not ${EXPECT_HOST}.`);

  const fromD = new Date(`${FROM}T00:00:00Z`);
  if (Number.isNaN(fromD.getTime())) throw new Error(`--from "${FROM}" is not a date`);
  const toD = TO ? new Date(`${TO}T00:00:00Z`) : new Date();
  if (Number.isNaN(toD.getTime())) throw new Error(`--to "${TO}" is not a date`);
  if (toD < fromD) throw new Error("--to is before --from");
  START = { y: fromD.getUTCFullYear(), m: fromD.getUTCMonth(), d: fromD.getUTCDate() };
  DAYS = Math.max(1, Math.round((toD - fromD) / 86400000) + 1);

  console.log("");
  console.log("  Seed a workshop's month");
  console.log(`  env file     ${ENV_FILE}`);
  console.log(`  cluster      ${host}`);
  console.log(`  organisation ${CODE}`);
  console.log(`  dates        ${iso(D(0))} .. ${iso(D(DAYS - 1))}  (${DAYS} days)`);
  console.log(`  phases       ${ONLY.length ? ONLY.join(", ") : "all"}`);
  console.log("");
  if (!flag("yes")) { console.log("  Nothing was written. Add --yes to go ahead."); console.log(""); return; }

  const mongoose = require("mongoose");
  await mongoose.connect(uri);
  try {
    const Organisation = require("../../models/core/organisationModel");
    const org = await Organisation.findOne({ code: CODE }).lean();
    if (!org) throw new Error(`no organisation "${CODE}" on this cluster`);
    require("../../utils/orgLocale").warm(org);

    const { runWithTenant } = require("../../utils/tenantContext");
    await runWithTenant({ companyId: CODE, branchId: "main" }, async () => {
      const c = await load();
      const steps = [
        ["masters", seedMasters], ["capital", capital], ["purchases", purchases], ["jobcards", jobCards],
        ["claims", claims], ["receipts", receipts], ["payments", payments], ["expenses", expenses],
        ["journals", journals], ["contras", contras], ["notes", notes], ["returns", returns], ["paper", paper],
      ];
      // Sequential on purpose. The number-series counter is one row per series, the party ledger
      // balance one row per party and the Stock cost pool one row per part: approvals in parallel
      // contend on all three and burn the eight retries of utils/withTransactionSession.js.
      for (const [name, fn] of steps) {
        if (!runs(name)) continue;
        console.log(`  ${name}...`);
        await fn(c);
      }
    });

    console.log("");
    console.log("  What was written");
    const keys = Object.keys(made).sort();
    if (!keys.length) console.log("    (nothing - everything was already there)");
    for (const k of keys) console.log(`    ${k.padEnd(28)} ${String(made[k]).padStart(4)}`);
    console.log("");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("");
  console.error(`  seed failed: ${error.message}`);
  if (error.code) console.error(`  code: ${error.code}`);
  if (error.details) console.error(`  details: ${JSON.stringify(error.details)}`);
  console.error("");
  process.exit(1);
});
