// Signing in to the developer console. Everything here is separate from a customer's sign-in on purpose:
//   - its own people (PlatformUser), who belong to no organisation
//   - its own token audience ("ERP-platform") and secret, so a customer's token can never open the console and a
//     console token can never open a customer's data: each side's verify() rejects the other's by audience alone
//   - a short life (8 hours, no refresh): a console session is a working session, not a standing one
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../../utils/productionConfig");
const bcrypt = require("bcryptjs");
const PlatformUser = require("../../models/platform/platformUserModel");
const AppError = require("../../utils/AppError");
const TwoFactorService = require("../core/twoFactorService");
const { signChallenge, verifyChallenge, platformSecret, PLATFORM_CHALLENGE, CHALLENGE_SECONDS } = require("../../utils/accountTokens");

const ISSUER = "ERP-system";
const AUDIENCE = "ERP-platform";
// A separate secret when one is configured; otherwise one DERIVED from the customer secret (never the same
// value), so the console works out of the box and is still not signed with the customers' key.
const secret = () => process.env.PLATFORM_JWT_SECRET || `${jwtSecret()}::platform-console`;
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

// the console's own challenge: its own audience and its own secret, so a customer's challenge opens nothing here and the reverse
const challengeOptions = () => ({ kind: PLATFORM_CHALLENGE, secret: platformSecret() });

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
    // Two-factor on: the password alone opens nothing. A challenge (its own audience and secret, never a customer's) for the next
    // step; the failure count is left alone, so the second step is what clears it.
    if (user.twoFactor?.enabled) {
      return { twoFactorRequired: true, challengeToken: signChallenge({ sub: String(user._id) }, challengeOptions()), expiresIn: CHALLENGE_SECONDS };
    }
    await user.recordSuccess();
    return { token: sign(user), expiresIn: lifetime(), user: user.toJSON() };
  }

  // Sign-in, step two: the challenge plus a code from the authenticator (or one recovery code). A wrong code counts toward the
  // same two-hour lock as a wrong password.
  static async loginTwoFactor({ challengeToken, code, recoveryCode } = {}) {
    let claims;
    try {
      claims = verifyChallenge(challengeToken, challengeOptions());
    } catch (error) {
      throw new AppError(error.message, 401, error.code || "CHALLENGE_INVALID");
    }
    if (code === undefined && recoveryCode === undefined) throw new AppError("Enter the code from your authenticator app", 400, "MISSING_CODE");
    const user = await PlatformUser.findById(claims.sub).select("+loginAttempts +lockUntil +twoFactor.secretEnc +twoFactor.recoveryCodes");
    if (!user || user.status !== "active" || !user.twoFactor?.enabled) throw new AppError("This sign-in cannot be continued. Start again.", 401, "CHALLENGE_INVALID");
    if (user.isLocked) throw new AppError(`Account locked. Try again in ${Math.ceil((user.lockUntil - Date.now()) / 60000)} minutes`, 423, "ACCOUNT_LOCKED");
    const proof = await TwoFactorService.check(user, { code, recoveryCode });
    if (!proof.ok) {
      await user.recordFailure();
      throw proof.reason === "replayed"
        ? new AppError("That code has already been used. Wait for the next one your app shows.", 401, "TWO_FACTOR_CODE_REUSED")
        : new AppError("That code is not right. Check the six digits your app shows now, or use a recovery code.", 401, "INVALID_TWO_FACTOR_CODE");
    }
    await user.recordSuccess();
    return { token: sign(user), expiresIn: lifetime(), user: user.toJSON(), signIn: { method: proof.method, recoveryCodesLeft: proof.method === "recovery" ? proof.recoveryLeft : undefined } };
  }

  // ---- the signed-in person's own two-factor. The password is asked again for every change (a borrowed console session must not be
  // able to bind someone else's app, or switch the protection off); a wrong password or code counts toward the lock. 400, not 401: a
  // 401 would make the console think the session ended.
  static async _ownAccount(user) {
    const fresh = await PlatformUser.findById(user._id).select("+password +loginAttempts +lockUntil +twoFactor.secretEnc +twoFactor.pendingSecretEnc +twoFactor.recoveryCodes");
    if (!fresh || fresh.status !== "active") throw new AppError("This account is not active", 401, "ACCOUNT_INACTIVE");
    return fresh;
  }

  static async _provePassword(account, password) {
    if (account.isLocked) throw new AppError(`Account locked. Try again in ${Math.ceil((account.lockUntil - Date.now()) / 60000)} minutes`, 423, "ACCOUNT_LOCKED");
    if (!password || !(await account.comparePassword(password))) {
      await account.recordFailure();
      throw new AppError("That password is not right", 400, "PASSWORD_INCORRECT");
    }
  }

  static async _proveFactor(account, { code, recoveryCode }) {
    const proof = await TwoFactorService.check(account, { code, recoveryCode });
    if (!proof.ok) {
      await account.recordFailure();
      const replayed = proof.reason === "replayed";
      throw new AppError(replayed ? "That code has already been used. Wait for the next one your app shows." : "That code is not right. Check the six digits your app shows now, or use a recovery code.", 400, replayed ? "TWO_FACTOR_CODE_REUSED" : "INVALID_TWO_FACTOR_CODE");
    }
  }

  static async twoFactorStatus(user) {
    return TwoFactorService.summary(await this._ownAccount(user));
  }

  static async beginTwoFactor(user, { password } = {}) {
    const account = await this._ownAccount(user);
    await this._provePassword(account, password);
    const issuer = `${process.env.TWO_FACTOR_ISSUER || process.env.SYSTEM_MAIL_PRODUCT_NAME || "Zarvia"} Console`;
    const shown = await TwoFactorService.begin(account, { issuer, account: account.email });
    return { secret: shown.secret, formattedSecret: shown.formattedSecret, uri: shown.uri, issuer, account: account.email };
  }

  static async enableTwoFactor(user, { code } = {}) {
    const account = await this._ownAccount(user);
    if (TwoFactorService.isEnabled(account)) throw new AppError("Two-factor is already on.", 409, "TWO_FACTOR_ALREADY_ON");
    try {
      return await TwoFactorService.confirm(account, code);
    } catch (error) {
      if (error.code === "INVALID_TWO_FACTOR_CODE") await account.recordFailure();
      throw error;
    }
  }

  static async disableTwoFactor(user, { password, code, recoveryCode } = {}) {
    const account = await this._ownAccount(user);
    if (!TwoFactorService.isEnabled(account)) throw new AppError("Two-factor is not on.", 409, "TWO_FACTOR_NOT_ON");
    await this._provePassword(account, password);
    await this._proveFactor(account, { code, recoveryCode });
    await TwoFactorService.disable(account);
    return { enabled: false };
  }

  static async regenerateRecoveryCodes(user, { password, code, recoveryCode } = {}) {
    const account = await this._ownAccount(user);
    if (!TwoFactorService.isEnabled(account)) throw new AppError("Two-factor is not on.", 409, "TWO_FACTOR_NOT_ON");
    await this._provePassword(account, password);
    await this._proveFactor(account, { code, recoveryCode });
    return TwoFactorService.regenerate(account);
  }

  // One platform person clears another's two-factor (a lost phone). Never one's own; the console has no ranks, so any signed-in
  // platform person may, and it is written to the platform audit by the controller.
  static async resetTwoFactor(id, actorId) {
    if (String(id) === String(actorId)) throw new AppError("You cannot reset your own two-factor here. Turn it off with your password and a code.", 403, "CANNOT_CHANGE_SELF");
    const target = await PlatformUser.findById(id);
    if (!target) throw new AppError("That platform account was not found", 404, "PLATFORM_USER_NOT_FOUND");
    if (!TwoFactorService.isEnabled(target)) throw new AppError("Two-factor is not on for that account.", 409, "TWO_FACTOR_NOT_ON");
    await TwoFactorService.disable(target);
    return PlatformUser.findById(id);
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
