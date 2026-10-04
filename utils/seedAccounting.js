// Seeds the accounting foundation for the default company. Idempotent: safe to run repeatedly.
//   npm run seed:accounting
//
// Creates: the default chart of accounts and posting map (see utils/defaultChart.js), the standard
// tax codes, the current fiscal year (if the company has none), and switches ledger posting on once
// every posting account is mapped. Nothing is overwritten: an existing mapping stays as set.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const FiscalYearService = require("../services/core/fiscalYearService");
const AccountConfigService = require("../services/financial/accountConfigService");
const DefaultChartService = require("../services/financial/defaultChartService");
const { getTenant } = require("./tenant");

async function seedAccounting({ log = console.log } = {}) {
  const { companyId } = getTenant();

  const made = await DefaultChartService.provision();
  log(`default chart: ${made.groups} groups, ${made.accounts} accounts, ${made.mapped} mappings, ${made.taxCodes} tax codes created`);

  const fy = await FiscalYearService.ensureDefault(new Date(), companyId);
  log(fy ? `fiscal year ${fy.code} created` : "fiscal year: already defined");

  const readiness = await AccountConfigService.getReadiness();
  if (readiness.missing.length === 0) {
    await AccountConfigService.setPostingEnabled(true);
    log("ledger posting: enabled");
  }
  log(`account configuration: ${readiness.mapped}/${readiness.total} keys mapped`);
  return readiness;
}

module.exports = { seedAccounting };

if (require.main === module) {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not defined in your .env file");
    process.exit(1);
  }
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => seedAccounting())
    .then(() => mongoose.disconnect())
    .catch((err) => {
      console.error("seed failed:", err.message);
      process.exit(1);
    });
}
