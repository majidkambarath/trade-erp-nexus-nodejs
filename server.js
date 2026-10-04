const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { mongodb } = require("./config/db");
const errorHandler = require("./utils/errorHandler");

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
const einvoiceRouter = require("./routes/einvoice/einvoiceRoutes");
dotenv.config();

const app = express();
const port = process.env.PORT || 4444;

// Middleware
app.use(express.static("public"));
// rawBody is kept so signed webhooks (e-invoice inbound) can be verified byte for byte.
app.use(express.json({ limit: "50mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      "http://localhost:5173",
      "http://localhost:3000",
      "http://localhost:8080",
    ];

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // For now allow all origins - change this in production
      callback(null, true);
    }
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
  .catch((err) => console.error("[migrations] failed:", err.message));

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
app.use("/api/v1/banking", bankingRouter); // before adminRouter, whose bare GET /:id would capture it
app.use("/api/v1/einvoice", einvoiceRouter);
app.use("/api/v1/batches", batchRouter); // before adminRouter, whose bare GET /:id would capture it
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