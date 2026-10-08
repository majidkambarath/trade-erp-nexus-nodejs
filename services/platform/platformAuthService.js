// Signing in to the developer console. Everything here is separate from a customer's sign-in on purpose:
//   - its own people (PlatformUser), who belong to no organisation
//   - its own token audience ("ERP-platform") and secret, so a customer's token can never open the console and a
//     console token can never open a customer's data: each side's verify() rejects the other's by audience alone
//   - a short life (8 hours, no refresh): a console session is a working session, not a standing one
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const PlatformUser = require("../../models/platform/platformUserModel");
const AppError = require("../../utils/AppError");

const ISSUER = "ERP-system";
const AUDIENCE = "ERP-platform";
// A separate secret when one is configured; otherwise one DERIVED from the customer secret (never the same
// value), so the console works out of the box and is still not signed with the customers' key.
const secret = () => process.env.PLATFORM_JWT_SECRET || `${process.env.JWT_SECRET}::platform-console`;
const lifetime = () => process.env.PLATFORM_JWT_EXPIRES_IN || "8h";

// Twelve characters, with letters and digits: this account can create and suspend organisations.
function assertStrongPassword(password) {
  const p = String(password || "");
  if (p.length < 12 || !/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) {
    throw new AppError("A platform password needs at least 12 characters, with letters and digits", 400, "WEAK_PASSWORD");
  }
}

// A real hash of nothing in particular, made once. Comparing a wrong-email attempt against it costs the same as
// checking a real password, so how long a refusal takes does not reveal whether the email exists. (bcrypt
// returns at once for a malformed hash, which would give the game away.)
let decoy;
const decoyHash = async () => (decoy ||= await bcrypt.hash("nobody-has-this-password", 12));

const sign = (user) =>
  jwt.sign({ id: String(user._id), email: user.email, name: user.name, scope: "platform" }, secret(), { expiresIn: lifetime(), issuer: ISSUER, audience: AUDIENCE });

function verify(token) {
  try {
    const claims = jwt.verify(token, secret(), { issuer: ISSUER, audience: AUDIENCE });
    if (claims.scope !== "platform") throw new AppError("Invalid token", 401, "INVALID_TOKEN");
    return claims;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.name === "TokenExpiredError") throw new AppError("Your session has ended. Please sign in again.", 401, "TOKEN_EXPIRED");
    throw new AppError("Invalid token", 401, "INVALID_TOKEN");
  }
}

class PlatformAuthService {
  static async login(email, password) {
    if (!email || !password) throw new AppError("Email and password are required", 400, "MISSING_CREDENTIALS");
    const user = await PlatformUser.findOne({ email: String(email).toLowerCase().trim() }).select("+password +loginAttempts +lockUntil");
    // The same answer for "no such person" and "wrong password", and the check still runs, so neither the
    // message nor the timing says which one it was.
    if (!user || user.status !== "active") {
      await bcrypt.compare(String(password), await decoyHash());
      throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
    }
    if (user.isLocked) {
      const minutes = Math.ceil((user.lockUntil - Date.now()) / 60000);
      throw new AppError(`Account locked. Try again in ${minutes} minutes`, 423, "ACCOUNT_LOCKED");
    }
    if (!(await user.comparePassword(password))) {
      await user.recordFailure();
      throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
    }
    await user.recordSuccess();
    return { token: sign(user), expiresIn: lifetime(), user: user.toJSON() };
  }

  // A token is only as good as the account behind it: switched off, it stops working at once.
  static async authenticate(token) {
    const claims = verify(token);
    const user = await PlatformUser.findById(claims.id);
    if (!user || user.status !== "active") throw new AppError("This account is not active", 401, "ACCOUNT_INACTIVE");
    return user;
  }

  static async create({ name, email, password }) {
    assertStrongPassword(password);
    if (await PlatformUser.exists({ email: String(email || "").toLowerCase().trim() })) throw new AppError("That email is already a platform account", 409, "EMAIL_EXISTS");
    return PlatformUser.create({ name, email, password });
  }

  static async list() {
    return PlatformUser.find().sort({ createdAt: 1 });
  }

  static async update(id, patch = {}, actorId = null) {
    const user = await PlatformUser.findById(id).select("+password");
    if (!user) throw new AppError("That platform account was not found", 404, "PLATFORM_USER_NOT_FOUND");
    if (patch.status !== undefined) {
      if (!["active", "inactive"].includes(patch.status)) throw new AppError("Status must be active or inactive", 400, "STATUS_INVALID");
      if (patch.status === "inactive" && String(user._id) === String(actorId)) throw new AppError("You cannot switch off your own account", 409, "CANNOT_DISABLE_SELF");
      if (patch.status === "inactive" && (await PlatformUser.countDocuments({ status: "active", _id: { $ne: user._id } })) === 0) {
        throw new AppError("That is the last active platform account", 409, "LAST_PLATFORM_USER");
      }
      user.status = patch.status;
    }
    if (patch.name !== undefined) user.name = String(patch.name).trim();
    if (patch.password !== undefined) { assertStrongPassword(patch.password); user.password = patch.password; }
    await user.save();
    return user;
  }
}

module.exports = PlatformAuthService;
module.exports.assertStrongPassword = assertStrongPassword;
module.exports.AUDIENCE = AUDIENCE;
