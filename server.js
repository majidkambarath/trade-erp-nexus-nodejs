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

const app = express();
const port = process.env.PORT || 4444;

// Middleware
app.use(express.static("public"));
// rawBody is kept so signed webhooks (e-invoice inbound) can be verified byte for byte.
app.use(express.json({ limit: "50mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser()); // the session cookie (controllers/core/adminController.js)

// CORS configuration
// Browser origins allowed to call the API with credentials. Deployments add their own through
// CORS_ORIGINS (comma separated), so a new frontend URL or custom domain needs no code change.
// Unknown origins are refused: the old version logged "change this in production" and then
// allowed everyone anyway, which with credentials: true let any site ride a logged-in session.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173", // vite dev server
  "http://localhost:4173", // vite preview
  "http://localhost:3000",
  "http://localhost:8080",
  "https://zarvia.onrender.com", // deployed frontend
];

// Trailing slashes are stripped so "https://x.com/" in the env var still matches the Origin
// header, which never carries one.
const normalizeOrigin = (value) => value.trim().replace(/[/]+$/, "");

const allowedOrigins = [
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.CORS_ORIGINS || "").split(",").map(normalizeOrigin).filter(Boolean),
];

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
  allowedHeaders: ["Content-Type", "x-secret-key", "Authorization"],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Connect to MongoDB, then repair data older versions wrote (idempotent, so safe on every start)
mongodb()
  .then(() => require("./utils/migrations").runMigrations())
  .then((done) => { if (Object.values(done).some(Boolean)) console.log("[migrations]", done); })
  .catch((err) => console.error("[migrations] failed:", err.message))
  // a company that never chose otherwise has ledger posting on, and every customer / vendor its
  // account, from the first start (not only once somebody opens the chart of accounts)
  .then(() => require("./services/financial/defaultChartService").onOpen({}))
  .then((done) => { if (done?.postingEnabled || done?.partyAccounts) console.log("[ledger]", done); })
  .catch((err) => console.error("[ledger] start-up check failed:", err.message));

// Health check endpoint. Declared before the route mounts: adminRouter is mounted at
// "/api/v1" and its "GET /:id" would otherwise swallow "/health" and demand a token.
app.get("/api/v1/health", (req, res) => {
  res.json({
    success: true,
    message: "Server is running successfully",
    timestamp: new Date().toISOString(),
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
app.use("/api/v1/quotations", require("./routes/orderPurchase/quotationRoutes")); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/delivery-notes", require("./routes/orderPurchase/deliveryNoteRoutes")); // before adminRouter, whose bare GET /:id would capture it
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
setInterval(() => {
  EInvoiceService.processDue().catch((err) => console.error("[einvoice] background pass failed:", err.message));
}, 60000).unref();