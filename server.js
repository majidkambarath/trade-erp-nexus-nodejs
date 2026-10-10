const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const dotenv = require("dotenv");
const { mongodb } = require("./config/db");
const errorHandler = require("./utils/errorHandler");
const AppError = require("./utils/AppError");

// Import routers
const vendorRouter = require("./routes/vendor/vendorRouter");
const customerRouter = require("./routes/customer/customerRouter"); // Add customer router
const adminRouter = require("./routes/core/adminRouter");
const stockRouter = require("./routes/stock/stockRouter");
const uomRouter = require("./routes/unit/uomRouter");
const transactionRouter = require("./routes/orderPurchase/transactionRouter");
const inventoryRouter = require("./routes/stock/inventoryMovementRoutes");
const categoryRouter = require("./routes/stock/categoryRouter");
const staffRoutes = require("./routes/staff/staffRoutes");
const financialRouter = require("./routes/financial/financialRoutes");
const accountRouter = require("./routes/financial/accountRouter");
const transactorRouter = require("./routes/financial/transactorRoutes");
const expenseTypeRouter = require("./routes/financial/expenseType");
const reportsRoutesr= require("./routes/reports/vatReportRoutes")
const ledgerRoutesr= require("./routes/ledgerRoutes")
const accountingSetupRouter = require("./routes/financial/accountingSetupRoutes");
const bankingRouter = require("./routes/banking/bankingRoutes");
const batchRouter = require("./routes/stock/batchRoutes");
const vatReturnRouter = require("./routes/reports/vatReturnRoutes");
const einvoiceRouter = require("./routes/einvoice/einvoiceRoutes");
dotenv.config();

// In production a missing or weak signing key stops the server here, before it opens a port or touches the database
// (utils/productionConfig.js). Elsewhere this only warns about settings worth a look.
require("./utils/productionConfig").assertProductionConfig();

const app = express();
const port = process.env.PORT || 4444;

// No "X-Powered-By: Express", and Express told how many proxies of ours stand in front of it, so req.ip - which every per-address limit,
// session and audit row uses - is the address our own proxy saw, not a header the client wrote (utils/trustProxy.js).
app.disable("x-powered-by");
const proxyHops = require("./utils/trustProxy").trustProxyHops();
app.set("trust proxy", proxyHops);
if (process.env.NODE_ENV === "production") console.log(`[security] trusting ${proxyHops} proxy hop(s) for the client address; check GET /api/v1/health -> yourAddress`);

// Middleware
app.use(require("./middleware/securityHeaders"));
app.use(express.static("public"));
// Body sizes: 1 MB of JSON for anyone, a larger one only for the few routes that need it and only with a valid access token
// (middleware/bodyLimits.js). rawBody is kept only for the signed webhooks (e-invoice inbound), so they can be verified byte for byte.
app.use(require("./middleware/bodyLimits").bodyParsers({ verifyToken: require("./services/core/adminService").verifyToken }));
app.use(require("./middleware/sanitizeInput")); // drops __proto__ / constructor / prototype / $operator keys from every body (see the file)
app.use(cookieParser()); // the session cookie (controllers/core/adminController.js)

// CORS configuration
// Browser origins allowed to call the API with credentials. Deployments add their own through
// CORS_ORIGINS (comma separated), so a new frontend URL or custom domain needs no code change.
// Unknown origins are refused: the old version logged "change this in production" and then
// allowed everyone anyway, which with credentials: true let any site ride a logged-in session.
// The trusted browser origins live in utils/allowedOrigins.js, because the messaging service needs the
// same list to decide which frontend a customer's document link points at.
const { allowedOrigins, normalizeOrigin } = require("./utils/allowedOrigins");

const corsOptions = {
  origin: function (origin, callback) {
    // No Origin header: curl, health checks, server-to-server calls and the signed e-invoice
    // webhooks. A browser always sends one on a cross-site request, so this is not a hole.
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(normalizeOrigin(origin))) return callback(null, true);

    callback(
      new AppError(`Origin ${origin} is not allowed by CORS`, 403, "CORS_ORIGIN_NOT_ALLOWED")
    );
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-secret-key", "Authorization", "Idempotency-Key", "X-Branch"],
  // The subscription warning headers (grace period, ending soon) are for the app to read.
  exposedHeaders: ["X-Subscription-State", "X-Subscription-Days-Left", "X-Subscription-Ends"],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Connect to MongoDB, then repair data older versions wrote (idempotent, so safe on every start), then
// adopt the original organisation. Signing in needs its organisation to exist, so requests wait for this
// (see the gate below) instead of being refused in the first moments after a start.
const organisationsReady = mongodb()
  .then(() => require("./utils/migrations").runMigrations())
  .then((done) => { if (Object.values(done).some(Boolean)) console.log("[migrations]", done); })
  .catch((err) => console.error("[migrations] failed:", err.message))
  // the organisation that existed before organisations did becomes a real one, with its head office
  .then(() => require("./services/core/organisationService").ensureDefault())
  .then((adopted) => { if (adopted) console.log("[organisations] adopted the original organisation:", adopted.code); })
  // every organisation's base currency and time zone is known before the first request is served
  .then(() => require("./services/core/organisationService").warmLocales())
  .catch((err) => console.error("[organisations] could not adopt the original organisation:", err.message));

let organisationsSettled = false;
organisationsReady.finally(() => { organisationsSettled = true; });
const BOOT_WAIT_MS = 20000; // never hold a request longer than this, however slow the database is
app.use((req, res, next) => {
  if (organisationsSettled || req.path === "/api/v1/health") return next();
  let released = false;
  const release = () => { if (!released) { released = true; clearTimeout(timer); next(); } };
  const timer = setTimeout(release, BOOT_WAIT_MS);
  organisationsReady.then(release, release);
});

// a company that never chose otherwise has ledger posting on, and every customer / vendor its
// account, from the first start (not only once somebody opens the chart of accounts)
organisationsReady
  .then(() => {
    const Organisations = require("./services/core/organisationService");
    return Organisations.forEach((code) => {
      // another organisation's chart is only touched once the ledger is separated by organisation
      if (code !== Organisations.DEFAULT_CODE && !Organisations.chartIsSafeToProvision()) return null;
      return require("./services/financial/defaultChartService").onOpen({});
    }, { label: "ledger" });
  })
  .then((runs) => { for (const { code, result } of runs || []) if (result?.postingEnabled || result?.partyAccounts) console.log("[ledger]", code, result); })
  .catch((err) => console.error("[ledger] start-up check failed:", err.message));

// Health check endpoint. Declared before the route mounts: adminRouter is mounted at
// "/api/v1" and its "GET /:id" would otherwise swallow "/health" and demand a token.
app.get("/api/v1/health", (req, res) => {
  res.json({
    success: true,
    message: "Server is running successfully",
    // false until the start-up work (migrations, adopting the original organisation) is done: the server answers while it
    // is still building a fresh database, and a sign-in in that window would be refused. Health checks may ignore it.
    ready: organisationsSettled,
    timestamp: new Date().toISOString(),
    // The address the server believes this request came from. It is YOUR address, told back to you: a deployment checks its proxy setting
    // with it (TRUST_PROXY_HOPS) from outside, and a forged X-Forwarded-For must not change it.
    yourAddress: String(req.ip || "").replace(/^::ffff:/, ""),
  });
});

// Routes
// Two-segment path, so adminRouter's bare GET /:id cannot capture it; mounted first anyway.
app.use("/api/v1/accounting", accountingSetupRouter);
app.use("/api/v1/accounting", require("./routes/financial/partyAccountRoutes"));
app.use("/api/v1/banking", bankingRouter); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/einvoice", einvoiceRouter);
app.use("/api/v1/batches", batchRouter); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/vat-return", vatReturnRouter); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/stock-reports", require("./routes/reports/stockReportRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/ifrs", require("./routes/reports/ifrsRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/dashboard-summary", require("./routes/reports/dashboardRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/opening-balances", require("./routes/financial/openingBalanceRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/document-types", require("./routes/masters/documentTypeRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/document-expiry", require("./routes/masters/documentExpiryRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/currencies", require("./routes/financial/currencyRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/branches", require("./routes/core/branchRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/company", require("./routes/core/companyRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/quotations", require("./routes/orderPurchase/quotationRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/delivery-notes", require("./routes/orderPurchase/deliveryNoteRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/document-flow", require("./routes/orderPurchase/documentFlowRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/messaging", require("./routes/messaging/messagingRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/access", require("./routes/core/accessRoutes")); // people and roles; before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/organisation", require("./routes/core/organisationRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/approvals", require("./routes/core/approvalRoutes")); // what waits for the signed-in person's approval; before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/auth", require("./routes/core/authRoutes")); // forgot / reset password, the second sign-in step, two-factor; before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/platform", require("./routes/platform/platformRoutes")); // the developer console: its own people and its own tokens, never a customer's
app.use("/api/v1/share", require("./routes/messaging/shareRoutes")); // PUBLIC (no login): the document link a customer opens
app.use("/api/v1", adminRouter);
app.use("/api/v1/vendors", vendorRouter);
app.use("/api/v1/customers", customerRouter);
app.use("/api/v1/stock", stockRouter);
app.use("/api/v1/uom", uomRouter);
app.use("/api/v1/transactions", transactionRouter);
app.use("/api/v1/inventory", inventoryRouter);
app.use("/api/v1/categories", categoryRouter);
app.use("/api/v1/staff", staffRoutes);
app.use("/api/v1/vouchers", financialRouter);
app.use("/api/v1/account", accountRouter);
app.use("/api/v1/account-v2", transactorRouter);
app.use("/api/v1/expense", expenseTypeRouter);
app.use("/api/v1/reports", reportsRoutesr);
app.use("/api/v1/ledger", ledgerRoutesr);

// Global error handling middleware
app.use(errorHandler);

// Handle 404 routes
// app.use("*", (req, res) => {
//   res.status(404).json({
//     success: false,
//     message: `Route ${req.originalUrl} not found`,
//   });
// });

app.listen(port, () => {
  console.log("Server running !!!!!");
  console.log(`http://localhost:${port}`);
});

// e-Invoicing: once a minute, retry deliveries that failed and poll the ones in flight. A no-op
// for a company that has not enabled e-invoicing.
const EInvoiceService = require("./services/einvoice/einvoiceService");
// Messaging: the same minute, the same idea: retry emails that failed for a temporary reason, and wipe any
// message held past a day. A no-op while sending is switched off.
const MessagingService = require("./services/messaging/messagingService");
setInterval(() => {
  EInvoiceService.processDue().catch((err) => console.error("[einvoice] background pass failed:", err.message));
  MessagingService.processDue().catch((err) => console.error("[messaging] background pass failed:", err.message));
}, 60000).unref();