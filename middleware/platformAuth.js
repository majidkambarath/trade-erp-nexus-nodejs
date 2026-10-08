// Authenticates a request to the developer console. It opens NO organisation scope: platform code names the
// organisation it works on explicitly, and a query on an organisation's data that forgot to would fail closed
// instead of quietly returning every customer's rows.
const PlatformAuthService = require("../services/platform/platformAuthService");

const authenticatePlatform = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: "Access token is required", errorCode: "MISSING_TOKEN" });
    req.platformUser = await PlatformAuthService.authenticate(token);
    next();
  } catch (error) {
    res.status(error.statusCode || 401).json({ success: false, message: error.message || "Invalid token", errorCode: error.code || "INVALID_TOKEN" });
  }
};

module.exports = { authenticatePlatform };
