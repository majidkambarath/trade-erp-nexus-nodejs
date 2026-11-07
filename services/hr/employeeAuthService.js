const bcrypt = require("bcryptjs");
const EmployeeUser = require("../../models/modules/hr/employeeUserModel");
const Staff = require("../../models/modules/staffModel");
const AppError = require("../../utils/AppError");
const tokens = require("../../utils/employeeTokens");
const { runUnscoped, runWithTenant } = require("../../utils/tenantContext");

// A real hash of nothing in particular, made once - the same decoy pattern platformAuthService.js uses,
// so a wrong-phone attempt costs the same as a wrong-password one and neither the message nor the timing
// says which it was.
let decoy;
const decoyHash = async () => (decoy ||= await bcrypt.hash("nobody-has-this-password", 12));

class EmployeeAuthService {
  /**
   * Sign-in finds the account by PHONE unscoped (the one moment no organisation is known, the same reason
   * Admin.email is looked up unscoped) - then everything after runs as that account's own organisation.
   * The lock-out counts BEFORE it weighs (reserveAttempt is called before the password is even read): N
   * parallel guesses each get their OWN sequential attempt number, so they cannot all pass the check
   * before any of them is counted.
   */
  static async login(phone, password, ip) {
    if (typeof phone !== "string" || typeof password !== "string") throw new AppError("Phone and password are required", 400, "MISSING_CREDENTIALS");
    const user = await runUnscoped("employee sign-in: the account is found by its phone, before any organisation is known", () =>
      EmployeeUser.findOne({ phone: phone.trim() }).select("+password +loginAttempts +lockUntil +currentRefreshJti")
    );
    if (!user || user.status !== "active") {
      await bcrypt.compare(password, await decoyHash());
      throw new AppError("Incorrect phone number or password", 401, "INVALID_CREDENTIALS");
    }
    return runWithTenant({ companyId: user.companyId }, async () => {
      const reserved = await user.reserveAttempt();
      if (reserved.locked) {
        const minutes = Math.ceil((reserved.lockUntil - Date.now()) / 60000);
        throw new AppError(`Too many attempts. Try again in ${minutes} minutes.`, 423, "ACCOUNT_LOCKED");
      }
      if (!(await user.comparePassword(password))) {
        throw new AppError("Incorrect phone number or password", 401, "INVALID_CREDENTIALS");
      }
      await user.resetLoginAttempts();
      return this._issueSession(user, ip);
    });
  }

  static async _issueSession(user, ip) {
    const jti = tokens.newJti();
    await EmployeeUser.updateOne({ _id: user._id }, { $set: { currentRefreshJti: jti } });
    const access = tokens.signAccess({ id: user._id, staffId: user.staffId, companyId: user.companyId });
    const refresh = tokens.signRefresh({ id: user._id, companyId: user.companyId, jti });
    return {
      accessToken: access, refreshToken: refresh,
      user: { id: String(user._id), staffId: String(user.staffId), mustChangePassword: user.mustChangePassword },
    };
  }

  /** The refresh cookie is single-use in the sense that matters here: signing in again anywhere
   * overwrites `currentRefreshJti`, so a stale copy stops working the moment a real session replaces it
   * (D15's stated scope - not Admin's full reuse-detection rotation, see the model's own header). */
  static async refresh(refreshToken) {
    if (!refreshToken) throw new AppError("No session", 401, "NO_SESSION_COOKIE");
    let claims;
    try {
      claims = tokens.verify(refreshToken);
    } catch {
      throw new AppError("Your session has ended. Please sign in again.", 401, "SESSION_REVOKED");
    }
    if (claims.use !== "refresh") throw new AppError("Invalid token", 401, "INVALID_TOKEN_TYPE");
    const user = await runUnscoped("employee refresh: the session names its own organisation, not yet known to this request", () =>
      EmployeeUser.findById(claims.sub).select("+currentRefreshJti")
    );
    if (!user || user.status !== "active") throw new AppError("This account is not active", 401, "ACCOUNT_INACTIVE");
    if (user.companyId !== claims.companyId) throw new AppError("Invalid token", 401, "TOKEN_ORGANISATION_MISMATCH");
    if (!user.currentRefreshJti || user.currentRefreshJti !== claims.jti) throw new AppError("Your session has ended. Please sign in again.", 401, "SESSION_REVOKED");
    if (user.sessionsRevokedAt && claims.iat * 1000 < user.sessionsRevokedAt.getTime()) throw new AppError("Your session has ended. Please sign in again.", 401, "SESSION_REVOKED");
    return runWithTenant({ companyId: user.companyId }, () => this._issueSession(user));
  }

  /** Verifies an access token and re-reads the account from the database - the row decides, never the
   * token's own claims (the same rule accountFor already holds customer sign-in to). */
  static async authenticate(accessToken) {
    let claims;
    try {
      claims = tokens.verify(accessToken);
    } catch (error) {
      if (error?.name === "TokenExpiredError") throw new AppError("Your session has ended. Please sign in again.", 401, "TOKEN_EXPIRED");
      throw new AppError("Invalid token", 401, "INVALID_TOKEN");
    }
    if (claims.use !== "access") throw new AppError("Invalid token", 401, "INVALID_TOKEN_TYPE");
    const user = await runUnscoped("employee auth: the token names the account, which names its own organisation", () => EmployeeUser.findById(claims.sub));
    if (!user || user.status !== "active") throw new AppError("This account is not active", 401, "ACCOUNT_INACTIVE");
    if (user.companyId !== claims.companyId) throw new AppError("Invalid token", 401, "TOKEN_ORGANISATION_MISMATCH");
    if (user.sessionsRevokedAt && claims.iat * 1000 < user.sessionsRevokedAt.getTime()) throw new AppError("Your session has ended. Please sign in again.", 401, "SESSION_REVOKED");
    return user;
  }

  static async logout(userId) {
    await EmployeeUser.updateOne({ _id: userId }, { $set: { currentRefreshJti: null } });
  }

  static async changePassword(userId, { currentPassword, newPassword }) {
    const user = await EmployeeUser.findById(userId).select("+password");
    if (!user) throw new AppError("Account not found", 404, "ACCOUNT_NOT_FOUND");
    if (!(await user.comparePassword(currentPassword))) throw new AppError("Your current password is not right", 400, "PASSWORD_INCORRECT");
    if (typeof newPassword !== "string" || newPassword.length < 8) throw new AppError("The new password needs at least 8 characters", 400, "WEAK_PASSWORD");
    user.password = newPassword; // the pre-save hook hashes it and stamps passwordChangedAt
    user.mustChangePassword = false;
    user.sessionsRevokedAt = new Date(); // every OTHER session ends; this request's own tokens are reissued below
    await user.save();
    return this._issueSession(user);
  }

  /** An administrator sets up or resets an employee's portal access - the one door that may set a
   * password without knowing the old one. */
  static async setAccount({ staffId, phone, password }, by) {
    const staff = await Staff.findById(staffId).select("_id");
    if (!staff) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
    if (typeof phone !== "string" || !/^\+?\d{10,15}$/.test(phone.trim())) throw new AppError("Enter a real phone number", 400, "INVALID_PHONE");
    if (typeof password !== "string" || password.length < 8) throw new AppError("The password needs at least 8 characters", 400, "WEAK_PASSWORD");
    const existing = await EmployeeUser.findOne({ staffId });
    if (existing) {
      existing.phone = phone.trim();
      existing.password = password;
      existing.mustChangePassword = true;
      existing.status = "active";
      existing.sessionsRevokedAt = new Date();
      await existing.save();
      return existing;
    }
    return EmployeeUser.create({ staffId, phone: phone.trim(), password, mustChangePassword: true, createdBy: by });
  }

  static async disable(staffId) {
    const user = await EmployeeUser.findOneAndUpdate({ staffId }, { $set: { status: "inactive", sessionsRevokedAt: new Date(), currentRefreshJti: null } }, { new: true });
    if (!user) throw new AppError("This employee has no portal account", 404, "ACCOUNT_NOT_FOUND");
    return user;
  }

  static async statusFor(staffId) {
    const user = await EmployeeUser.findOne({ staffId }).select("phone status mustChangePassword createdAt");
    return user ? { hasAccount: true, phone: user.phone, status: user.status, mustChangePassword: user.mustChangePassword } : { hasAccount: false };
  }
}

module.exports = EmployeeAuthService;
