// A believable workshop, in its own BRAND NEW organisation: Al Manara Auto Garage, Dubai - a UAE garage with
// full product access (every module, every feature, and the garage vertical switched on by override) so
// there is nothing to unlock before looking at it.
//
// It goes through the REAL services, exactly as scripts/demo/crmDemo.js does for the CRM: the organisation is
// made through PlatformOrganisationService.create (the same path the developer console uses), the vehicles and
// job cards go through VehicleService/JobCardService/InsuranceClaimService, and the two full cycles below
// (a retail brake-and-oil job, and an accident repair split between the insurer and the customer) are proof
// the whole chain actually works: stock falls at the right cost, labour revenue lands apart from parts, an
// insurer and a customer can be billed from one decision, and a job card really does reach CLOSED.
//
//   node scripts/demo/garageDemo.js
//   node scripts/demo/garageDemo.js --code=al-manara-garage
//
// Safe to run twice: if the organisation already exists, its code is reused and the job cards are only
// seeded once (a stamp on the first retail job card's notes is the idempotency check). There is no --undo -
// this makes a whole organisation, and removing one is a developer-console action, not a script's to take.
require("dotenv").config();
const mongoose = require("mongoose");
const { runWithTenant } = require("../../utils/tenantContext");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const CODE = arg("code", "al-manara-garage");
const STAMP = "garage-demo";

async function ensureOrganisation() {
  const Organisation = require("../../models/core/organisationModel");
  const existing = await Organisation.findOne({ code: CODE }).lean();
  if (existing) {
    console.log(`Organisation "${CODE}" already exists (${existing.legalName}); reusing it.`);
    return existing;
  }

  const PlatformOrganisationService = require("../../services/platform/platformOrganisationService");
  const result = await PlatformOrganisationService.create(
    {
      code: CODE,
      legalName: "Al Manara Auto Garage LLC",
      tradeName: "Al Manara Garage",
      country: "AE",
      baseCurrency: "AED",
      timezone: "Asia/Dubai",
      planCode: "internal", // every module and limit this product has
      moduleOverrides: { garage: true }, // the one module "internal" does not already carry: an opt-in vertical
      featureOverrides: { production: true }, // also opt-in; on here so there is nothing left to switch on
      firstAdmin: { name: "Yousuf Al Mazrouei", email: "owner@almanara-garage.ae", password: "Garage#2026" },
    },
    { by: { email: "demo-script@local" } }
  );
  console.log(`Organisation created: ${CODE} (${result.organisation.legalName})`);
  if (result.firstAdmin) console.log(`Sign in: owner@almanara-garage.ae / Garage#2026`);
  else console.log(`First administrator was NOT created: ${result.firstAdminError}`);
  return result.organisation;
}

async function seedMasters(M) {
  const category = await M.Category.findOneAndUpdate({ name: "Garage" }, { $setOnInsert: { name: "Garage", status: "Active" } }, { upsert: true, new: true });
  const otherIncome = await M.LedgerAccount.findOne({ accountName: "Other Income" });
  const base = { categoryId: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "Workshop" };

  const stockItem = async (sku, itemName, salesPrice, extra = {}) => {
    const found = await M.Stock.findOne({ sku });
    if (found) return found;
    return M.StockService.createStock({ ...base, sku, itemName, salesPrice, ...extra }, "demo-script");
  };
  const parts = {
    brakePads: await stockItem("PART-BRAKE", "Brake pads (set)", 150),
    oilFilter: await stockItem("PART-OIL", "Oil filter", 40),
    engineOil: await stockItem("PART-5W30", "Engine oil 5W-30 (5L)", 180),
    bumper: await stockItem("PART-BUMPER", "Front bumper (OEM)", 1200),
    headlamp: await stockItem("PART-HEADLAMP", "Headlamp assembly", 650),
  };
  const labour = {
    brakeJob: await stockItem("LAB-BRAKE", "Labour - brake pad replacement", 200, { itemType: "service", incomeAccountId: otherIncome?._id }),
    oilChange: await stockItem("LAB-OIL", "Labour - oil and filter change", 80, { itemType: "service", incomeAccountId: otherIncome?._id }),
    panelPaint: await stockItem("LAB-PANEL", "Labour - panel beating and paint", 1500, { itemType: "service", incomeAccountId: otherIncome?._id }),
    headlampFit: await stockItem("LAB-HEADLAMP", "Labour - headlamp replacement", 150, { itemType: "service", incomeAccountId: otherIncome?._id }),
  };

  // Stock the parts at a known cost, exactly as a real workshop would before the first job.
  const vendor = await (async () => {
    const Vendor = require("../../models/modules/vendorModel");
    const found = await Vendor.findOne({ vendorId: "GARV1" });
    if (found) return found;
    return Vendor.create({ vendorId: "GARV1", vendorName: "Gulf Auto Parts Trading LLC", contactPerson: "Rashid", address: "Al Quoz, Dubai", paymentTerms: "Net 30" });
  })();
  const sublet = await (async () => {
    const Vendor = require("../../models/modules/vendorModel");
    const found = await Vendor.findOne({ vendorId: "GARV2" });
    if (found) return found;
    return Vendor.create({ vendorId: "GARV2", vendorName: "Shine Auto Paint Shop", contactPerson: "Suresh", address: "Ras Al Khor, Dubai", paymentTerms: "Net 15" });
  })();

  const buyApproved = async (items) => {
    const t = await M.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items }, "demo-script");
    return M.Tx.processTransaction(t._id, "approve", "demo-script");
  };
  const fresh = await M.Stock.findById(parts.brakePads._id);
  if (!fresh.currentStock) {
    await buyApproved([
      { itemId: parts.brakePads._id, description: "Brake pads", qty: 20, price: 80, rate: 80, vatPercent: 0 },
      { itemId: parts.oilFilter._id, description: "Oil filter", qty: 20, price: 25, rate: 25, vatPercent: 0 },
      { itemId: parts.engineOil._id, description: "Engine oil", qty: 15, price: 110, rate: 110, vatPercent: 0 },
      { itemId: parts.bumper._id, description: "Front bumper", qty: 5, price: 600, rate: 600, vatPercent: 0 },
      { itemId: parts.headlamp._id, description: "Headlamp", qty: 8, price: 350, rate: 350, vatPercent: 0 },
    ]);
  }

  const customer = async (code, name, phone) => {
    const found = await M.Customer.findOne({ customerId: code });
    if (found) return found;
    return M.Customer.create({ customerId: code, customerName: name, contactPerson: name, phone, shippingAddress: "Dubai, UAE", paymentTerms: "Net 30" });
  };
  const ali = await customer("GARC1", "Ali Hassan", "0501234567");
  const fatima = await customer("GARC2", "Fatima Al Suwaidi", "0509876543");
  const khalid = await customer("GARC3", "Khalid Omar", "0507654321");
  const insurer = await (async () => {
    const found = await M.Customer.findOne({ customerId: "GARINS1" });
    if (found) return found;
    return M.Customer.create({ customerId: "GARINS1", customerName: "Orient Insurance PJSC", contactPerson: "Claims Desk", phone: "044445555", shippingAddress: "Dubai, UAE", paymentTerms: "Net 30", isInsurer: true });
  })();

  const staffMember = async (code, name, designation, phone) => {
    const Staff = require("../../models/modules/staffModel");
    const found = await Staff.findOne({ staffId: code });
    if (found) return found;
    return Staff.create({ staffId: code, name, designation, contactNo: phone, idNo: `784-${code}`, joiningDate: new Date("2023-01-01"), createdBy: "demo-script" });
  };
  const raj = await staffMember("GARS1", "Raj Kumar", "Senior Technician", "971501112222");
  const mahesh = await staffMember("GARS2", "Mahesh Patel", "Technician", "971502223333");

  const vehicle = async (plate, make, model, year, colour, custId) => {
    const found = await M.VehicleService.findByPlateOrChassis({ plateNumber: plate });
    if (found) return found;
    return M.VehicleService.create({ plateNumber: plate, plateEmirate: "Dubai", make, model, year, colour, customerId: custId }, "demo-script");
  };

  return {
    parts, labour, vendor, sublet,
    customers: { ali, fatima, khalid, insurer },
    staff: { raj, mahesh },
    vehicles: {
      hilux: await vehicle("A 11111", "Toyota", "Hilux", 2020, "White", ali._id),
      civic: await vehicle("B 22222", "Honda", "Civic", 2019, "Silver", fatima._id),
      patrol: await vehicle("D 33333", "Nissan", "Patrol", 2022, "Black", khalid._id),
      corolla: await vehicle("A 44444", "Toyota", "Corolla", 2021, "Grey", ali._id),
    },
  };
}

// A complete retail job, start to finish: check-in, two complaints, parts and labour, a full approval, both
// tasks done, the invoice raised and approved, and the car released.
async function retailJobClosed(M, W) {
  let card = await M.JobCard.create(
    {
      vehicleId: W.vehicles.hilux._id, customerId: W.customers.ali._id, jobType: "retail",
      odometerIn: 68250, fuelLevelIn: "1/2", promisedAt: new Date(Date.now() + 2 * 86400000),
      complaints: [{ concern: "Brakes squeaking when stopping" }, { concern: "Oil change due, dashboard light on" }],
      lines: [
        { kind: "part", itemId: W.parts.brakePads._id, qty: 1, price: 150 },
        { kind: "labour", itemId: W.labour.brakeJob._id, qty: 1, price: 200 },
        { kind: "part", itemId: W.parts.oilFilter._id, qty: 1, price: 40 },
        { kind: "part", itemId: W.parts.engineOil._id, qty: 1, price: 180 },
        { kind: "labour", itemId: W.labour.oilChange._id, qty: 1, price: 80 },
      ],
      tasks: [
        { name: "Replace brake pads", mode: "in_house", stage: 1, standardHours: 1, staffId: W.staff.raj._id },
        { name: "Oil and filter change", mode: "in_house", stage: 1, standardHours: 0.5, staffId: W.staff.mahesh._id },
      ],
    },
    "demo-script"
  );
  card = await M.JobCard.recordCheckIn(card._id, {
    itemsPresent: ["Spare wheel", "Jack and tools", "Registration card"],
    damagePoints: [{ panel: "Rear bumper", kind: "scratch", notes: "Minor scuff, pre-existing" }],
    notes: "Fuel at half, no warning lights besides oil service.",
  }, "demo-script");
  card = await M.JobCard.sendEstimate(card._id, "demo-script");
  card = await M.JobCard.recordApproval(card._id, { method: "whatsapp", note: "Approved the whole estimate" }, "demo-script");
  for (const t of card.tasks) {
    await M.JobCard.startTask(card._id, t._id, "demo-script");
    card = await M.JobCard.completeTask(card._id, t._id, { actualHours: t.standardHours }, "demo-script");
  }
  const { invoice } = await M.JobCard.createInvoice({ jobCardId: card._id, billTo: "customer" }, "demo-script");
  await M.Tx.processTransaction(invoice._id, "approve", "demo-script");
  // Released on account (a trusted customer): the receipt itself is a separate, well-tested flow (Finance >
  // Receipts) that does not need re-proving here, and "owed, but the car still went out" is itself a real
  // scene the Receivables screen should show.
  card = await M.JobCard.releaseVehicle(card._id, { odometerOut: 68255, handedTo: "Ali Hassan", warrantyMonths: 3, onAccount: true }, "demo-script");
  return card;
}

// An accident repair: a bumper and a headlamp, surveyed, approved with an excess and depreciation, done, and
// billed as two invoices from one decision - the insurer for the repair, the customer for the excess and the
// depreciation - which is the one scene that makes this vertical worth having.
async function insuranceJobClosed(M, W) {
  let card = await M.JobCard.create(
    {
      vehicleId: W.vehicles.patrol._id, customerId: W.customers.khalid._id, jobType: "insurance",
      odometerIn: 41200, fuelLevelIn: "3/4",
      complaints: [{ concern: "Front-end collision, bumper and headlamp damaged" }],
      lines: [
        { kind: "part", itemId: W.parts.bumper._id, qty: 1, price: 1200 },
        { kind: "part", itemId: W.parts.headlamp._id, qty: 1, price: 650 },
        { kind: "labour", itemId: W.labour.panelPaint._id, qty: 1, price: 1500 },
        { kind: "labour", itemId: W.labour.headlampFit._id, qty: 1, price: 150 },
      ],
      tasks: [{ name: "Replace bumper, repaint panel and fit headlamp", mode: "in_house", stage: 1, standardHours: 6, staffId: W.staff.raj._id }],
    },
    "demo-script"
  );
  card = await M.JobCard.recordCheckIn(card._id, {
    itemsPresent: ["Spare wheel", "Registration card", "Fuel card"],
    damagePoints: [
      { panel: "Front bumper", kind: "broken", notes: "Cracked and displaced, accident damage" },
      { panel: "Left headlamp", kind: "broken", notes: "Lens shattered" },
    ],
    notes: "Customer reports a low-speed collision this morning; police report attached separately.",
  }, "demo-script");

  let claim = await M.Claim.create(
    { insurerId: W.customers.insurer._id, jobCardId: card._id, policyNo: "POL-2026-44871", policyHolder: "Khalid Omar", accidentDate: new Date(Date.now() - 86400000), policeReportNo: "DXB-PR-889213" },
    "demo-script"
  );
  claim = await M.Claim.submit(claim._id, "demo-script");
  claim = await M.Claim.recordSurvey(claim._id, { surveyorName: "Ahmed Saeed", company: "Crawford & Company UAE", notes: "Bumper and headlamp confirmed damaged; consistent with reported collision." }, "demo-script");
  claim = await M.Claim.recordApproval(
    claim._id,
    { status: "PARTLY_APPROVED", lpoNo: "LPO-2026-99214", approvedAmount: 3350, note: "Approved less excess and parts depreciation", deductions: { excess: 500, partsDepreciationPct: 10, depreciablePartsAmount: 1850 } },
    "demo-script"
  );

  card = await M.JobCard.sendEstimate(card._id, "demo-script");
  card = await M.JobCard.recordApproval(card._id, { method: "lpo", reference: "LPO-2026-99214" }, "demo-script");
  for (const t of card.tasks) {
    await M.JobCard.startTask(card._id, t._id, "demo-script");
    card = await M.JobCard.completeTask(card._id, t._id, { actualHours: t.standardHours }, "demo-script");
  }

  claim = await M.Claim.raiseInvoices(claim._id, "demo-script");
  for (const inv of claim.invoices) await M.Tx.processTransaction(inv.transactionId, "approve", "demo-script");
  card = await M.JobCard.releaseVehicle(card._id, { odometerOut: 41210, handedTo: "Khalid Omar", warrantyMonths: 6, onAccount: true }, "demo-script");
  return { card, claim };
}

// Three more jobs, left open at different stages, so the Board and the Job cards list look like a workshop
// mid-morning rather than a closed history.
async function openJobs(M, W) {
  const draft = await M.JobCard.create(
    {
      vehicleId: W.vehicles.corolla._id, customerId: W.customers.ali._id, jobType: "retail",
      odometerIn: 25400, fuelLevelIn: "F",
      complaints: [{ concern: "AC not cooling" }],
    },
    "demo-script"
  );
  await M.JobCard.recordCheckIn(draft._id, { itemsPresent: ["Spare wheel"], notes: "Just arrived, AC inspection pending." }, "demo-script");

  let waiting = await M.JobCard.create(
    {
      vehicleId: W.vehicles.civic._id, customerId: W.customers.fatima._id, jobType: "retail",
      odometerIn: 54000, fuelLevelIn: "1/4",
      complaints: [{ concern: "Oil change due" }, { concern: "Front tyres wearing unevenly" }],
      lines: [
        { kind: "part", itemId: W.parts.oilFilter._id, qty: 1, price: 40 },
        { kind: "part", itemId: W.parts.engineOil._id, qty: 1, price: 180 },
        { kind: "labour", itemId: W.labour.oilChange._id, qty: 1, price: 80 },
      ],
      tasks: [{ name: "Oil and filter change", mode: "in_house", stage: 1, standardHours: 0.5, staffId: W.staff.mahesh._id }],
    },
    "demo-script"
  );
  waiting = await M.JobCard.sendEstimate(waiting._id, "demo-script");

  let working = await M.JobCard.create(
    {
      vehicleId: W.vehicles.patrol._id, customerId: W.customers.khalid._id, jobType: "retail",
      odometerIn: 41500, fuelLevelIn: "1/2",
      complaints: [{ concern: "Rattling noise from the rear" }],
      lines: [
        { kind: "part", itemId: W.parts.brakePads._id, qty: 1, price: 150 },
        { kind: "labour", itemId: W.labour.brakeJob._id, qty: 1, price: 200 },
      ],
      tasks: [{ name: "Inspect rear suspension and replace brake pads", mode: "in_house", stage: 1, standardHours: 1.5, staffId: W.staff.raj._id }],
    },
    "demo-script"
  );
  working = await M.JobCard.sendEstimate(working._id, "demo-script");
  working = await M.JobCard.recordApproval(working._id, { method: "call", note: "Approved by phone" }, "demo-script");
  await M.JobCard.startTask(working._id, working.tasks[0]._id, "demo-script");

  return { draft, waiting, working };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  await ensureOrganisation();

  const M = {
    Category: require("../../models/modules/categoryModel"),
    Stock: require("../../models/modules/stockModel"),
    StockService: require("../../services/stock/stockService"),
    Customer: require("../../models/modules/customerModel"),
    Tx: require("../../services/orderPurchase/transactionService"),
    VehicleService: require("../../services/garage/vehicleService"),
    JobCard: require("../../services/garage/jobCardService"),
    Claim: require("../../services/garage/insuranceClaimService"),
    LedgerAccount: require("../../models/modules/financial/financialModels").LedgerAccount,
    JobCardModel: require("../../models/modules/garage/jobCardModel"),
  };

  await runWithTenant({ companyId: CODE, branchId: "main" }, async () => {
    const already = await M.JobCardModel.findOne({ notes: { $regex: STAMP } }).lean();
    const W = await seedMasters(M);

    if (already) {
      console.log(`${CODE} already has its demo job cards. Nothing more to seed.`);
    } else {
      console.log("Running the retail job through to CLOSED (check-in, estimate, tasks, invoice, gate pass)...");
      const retail = await retailJobClosed(M, W);
      await M.JobCardModel.updateOne({ _id: retail._id }, { $set: { notes: `${STAMP}: brake pads and oil change, fully closed` } });
      console.log(`  ${retail.jobNo} -> ${retail.status}`);

      console.log("Running the accident-repair job through two invoices (insurer + customer)...");
      const { card: accident, claim } = await insuranceJobClosed(M, W);
      await M.JobCardModel.updateOne({ _id: accident._id }, { $set: { notes: `${STAMP}: bumper and headlamp, insurer + customer invoices` } });
      console.log(`  ${accident.jobNo} -> ${accident.status}, claim ${claim.claimNo} -> ${claim.status} (insurer AED ${claim.split.insurerAmount}, customer AED ${claim.split.customerAmount})`);

      console.log("Leaving three more jobs open, at different stages, for the board...");
      const { draft, waiting, working } = await openJobs(M, W);
      console.log(`  ${draft.jobNo} DRAFT, ${waiting.jobNo} AWAITING_APPROVAL, ${working.jobNo} IN_PROGRESS`);
    }

    console.log("");
    console.log(`Done. Sign in to ${CODE} and open Garage > Board.`);
  });

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
