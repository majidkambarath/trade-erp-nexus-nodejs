// A person's own account security: forgetting a password, and two-factor sign-in.
//
// Two rules run through everything here.
//   1. Nothing public tells you whether an account exists. "Forgot my password" answers the same thing, in about the same time,
//      for an address that has an account and one that has not.
//   2. A secret is shown once and kept as a hash (or encrypted), and every proof that guards one counts its failures against the
//      person's account lock (5 failures, 15 minutes), the same lock a wrong password uses.
const Admin = require("../../models/core/adminModel");
const AuthSession = require("../../models/core/authSessionModel");
const PasswordReset = require("../../models/core/passwordResetModel");
const Organisation = require("../../models/core/organisationModel");
const AppError = require("../../utils/AppError");
const { runWithTenant, runUnscoped } = require("../../utils/tenantContext");
const { signInRefusal } = require("../../utils/subscriptionGate");
const { newResetToken, looksLikeResetToken, resetTokenId } = require("../../utils/accountTokens");
const { passwordResetMail, securityNoticeMail } = require("../../utils/systemMailTemplates");
const { coarseIp } = require("../../middleware/rateLimit");
const { normalizeOrigin } = require("../../utils/allowedOrigins");
const AuditService = require("./auditService");
const TwoFactorService = require("./twoFactorService");
const SecurityPolicyService = require("./securityPolicyService");
const mailer = require("./systemMailer");

const MINUTE = 60 * 1000;
const RESET_MINUTES = 30; // how long a reset link lives
const RESET_PER_HOUR = 3; // reset mails for one account per hour: the rest are answered the same and not sent
const MAX_PASSWORD = 200; // bcrypt reads 72 bytes; this only stops a megabyte body being hashed
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DEFAULT_APP = "https://zarvia.onrender.com";
const ISSUER = () => process.env.TWO_FACTOR_ISSUER || process.env.SYSTEM_MAIL_PRODUCT_NAME || "Zarvia";

// How long "forgot my password" always takes to answer. A real request looks up the account, writes a row and starts a mail; an
// unknown address does none of that, so answering as soon as the work is done would say which it was. Instead the work runs
// BESIDE a fixed wait and the answer does not wait for it: a fast unknown address and a slow real one both answer after exactly
// this long (a database slower than the wait cannot show through either).
const delayMs = () => (process.env.FORGOT_PASSWORD_MIN_MS === undefined ? 600 : Number(process.env.FORGOT_PASSWORD_MIN_MS) || 0);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where the reset page lives: the configured public address, else the deployed frontend. Never the Origin of the request: the
// link is a credential, and an attacker who can set a header must not be able to make the mail point at their server.
const appBase = () => normalizeOrigin(process.env.PUBLIC_APP_URL) || DEFAULT_APP;
const resetUrl = (token) => `${appBase()}/reset-password?token=${encodeURIComponent(token)}`;

// A mail that is started and not waited for: the answer to the person must not depend on how fast (or whether) it went out.
const mailLater = (message, what) => {
  mailer.send(message).then((r) => { if (!r.ok) console.error(`[account-security] ${what}: mail not sent (${r.code})`); }, () => {});
};

const strong = (password) => {
  // text and nothing else (an object with its own toString made String() throw, which came back as a 500)
  if (typeof password !== "string") throw new AppError("A password needs at least 8 characters", 400, "WEAK_PASSWORD");
  const p = password;
  if (p.length < 8) throw new AppError("A password needs at least 8 characters", 400, "WEAK_PASSWORD");
  if (p.length > MAX_PASSWORD) throw new AppError("That password is too long", 400, "WEAK_PASSWORD");
};

// A request-shaped stand-in so the audit trail names the person for an action that happens with no signed-in request.
const actingAs = (admin, ip) => ({ admin: { id: String(admin._id), email: admin.email, name: admin.name }, ip: ip || null });

const AccountSecurity = {};

// ============================================================================ forgot / reset

/**
 * Someone typed an email on the "forgot my password" page. ALWAYS resolves with nothing and no difference: an account that
 * exists gets a link by email, one that does not gets nothing, one that is switched off or whose organisation is suspended gets
 * nothing, and an account that has asked too often gets nothing. The caller answers 200 to all of them.
 */
AccountSecurity.requestReset = async (email, { ip } = {}) => {
  const work = (async () => {
    try {
      // a string and nothing else: an array or an object is not an address, however it would read once turned into text
      const address = typeof email === "string" ? email.trim().toLowerCase() : "";
      if (EMAIL_SHAPE.test(address) && address.length <= 254) await issueResetLink(address, ip);
    } catch (error) {
      // not even a fault may change the answer; it is read in the log
      console.error("[account-security] reset request failed:", error.message);
    }
  })();
  await wait(delayMs());
  void work; // finished or not, the answer does not wait for it
};

async function issueResetLink(address, ip) {
  const admin = await runUnscoped("password reset: the person is found by the email they typed, before any organisation is known", () =>
    Admin.findOne({ email: address }).select("name email companyId branchId isActive status").lean()
  );
  if (!admin || !admin.isActive || admin.status !== "active") return;
  const organisation = await Organisation.findOne({ code: admin.companyId });
  if (!organisation || signInRefusal(organisation)) return; // suspended, closed or ended: no mail, the same answer

  await runWithTenant({ companyId: admin.companyId, branchId: admin.branchId || "main" }, async () => {
    const recent = await PasswordReset.countDocuments({ adminId: admin._id, createdAt: { $gt: new Date(Date.now() - 60 * MINUTE) } });
    if (recent >= RESET_PER_HOUR) return;
    // a new request supersedes the links before it: only the newest mail works
    await PasswordReset.updateMany({ adminId: admin._id, usedAt: null, supersededAt: null }, { $set: { supersededAt: new Date() } });
    const { token, id } = newResetToken();
    const expiresAt = new Date(Date.now() + RESET_MINUTES * MINUTE);
    await PasswordReset.create({ _id: id, companyId: admin.companyId, adminId: admin._id, expiresAt, purgeAt: new Date(expiresAt.getTime() + 24 * 60 * MINUTE), requestedFrom: coarseIp(ip) });
    mailLater({ to: admin.email, ...passwordResetMail({ name: admin.name, url: resetUrl(token), minutes: RESET_MINUTES }) }, "password reset");
  });
}

const invalidLink = () => new AppError("This link is no longer valid. Ask for a new one.", 400, "RESET_TOKEN_INVALID");

/**
 * The person opened the emailed link and typed a new password. The link is good once. Applying it: the password is replaced, the
 * "someone else chose it" flag and any lock are cleared, EVERY sign-in the person holds is ended, and it is written to the
 * organisation's trail. Two-factor, if the person has it, is untouched: a stolen mailbox must not be enough to get in.
 */
AccountSecurity.resetPassword = async (token, password, { ip } = {}) => {
  strong(password);
  if (!looksLikeResetToken(token)) throw invalidLink();
  const id = resetTokenId(token);
  const row = await runUnscoped("password reset: the token's hash names its own row, and so its organisation", () => PasswordReset.findById(id).lean());
  if (!row || row.usedAt || row.supersededAt || row.expiresAt <= new Date()) throw invalidLink();

  return runWithTenant({ companyId: row.companyId }, async () => {
    const admin = await Admin.findById(row.adminId).select("+password");
    if (!admin || !admin.isActive || admin.status !== "active") throw invalidLink();
    const organisation = await Organisation.findOne({ code: admin.companyId });
    if (!organisation || signInRefusal(organisation)) throw invalidLink();
    if (await admin.comparePassword(password)) throw new AppError("Choose a password you have not used here", 400, "PASSWORD_UNCHANGED");

    // Claim the link BEFORE using it: of two requests with the same token, exactly one gets past here.
    const claimed = await PasswordReset.findOneAndUpdate({ _id: id, usedAt: null, supersededAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date() } });
    if (!claimed) throw invalidLink();

    const now = new Date();
    admin.password = password; // hashed on save
    admin.mustChangePassword = false;
    admin.passwordChangedAt = now;
    admin.sessionsRevokedAt = now;
    admin.loginAttempts = 0;
    admin.lockUntil = undefined;
    admin.$locals.updatedBy = admin._id;
    await admin.save();

    await AuthSession.updateMany({ adminId: admin._id, revokedAt: null }, { $set: { revokedAt: now } });
    await PasswordReset.updateMany({ adminId: admin._id, usedAt: null, supersededAt: null }, { $set: { supersededAt: now } }); // any other link still out there

    await AuditService.log({ req: actingAs(admin, ip), action: "PASSWORD_RESET", entity: "Admin", entityId: admin._id, summary: `${admin.email} chose a new password from an emailed link; every sign-in was ended` });
    mailLater({ to: admin.email, ...securityNoticeMail({ name: admin.name, headline: "Your password was changed", detail: "It was reset from the link in an email. Every device was signed out." }) }, "password reset notice");
    return { email: admin.email };
  });
};

// ============================================================================ two-factor, signed in

const ACCOUNT_SELECT = "+password +loginAttempts +lockUntil +twoFactor.secretEnc +twoFactor.pendingSecretEnc +twoFactor.recoveryCodes";

async function accountOf(req) {
  const admin = await Admin.findById(req.admin.id).select(ACCOUNT_SELECT);
  if (!admin || !admin.isActive || admin.status !== "active") throw new AppError("Admin not found or inactive", 401, "ADMIN_INACTIVE");
  return admin;
}

const lockedFor = (lockUntil) => new AppError(`Account locked. Try after ${Math.max(1, Math.ceil((new Date(lockUntil).getTime() - Date.now()) / MINUTE))} minutes`, 423, "ACCOUNT_LOCKED");

// A password typed to authorise a security change. A wrong one counts toward the lock, like a wrong password at sign-in - and, as there,
// the attempt is counted BEFORE the password is weighed, so guesses sent together do not get past the limit.
// (400, not 401: a 401 makes the browser think the session ended and sign the person out.)
async function provePassword(admin, password) {
  if (admin.isLocked) throw lockedFor(admin.lockUntil);
  const attempt = await admin.reserveAttempt();
  if (attempt.locked) throw lockedFor(attempt.lockUntil);
  if (typeof password !== "string" || !password || password.length > 1000 || !(await admin.comparePassword(password))) {
    throw new AppError("That password is not right", 400, "PASSWORD_INCORRECT"); // already counted
  }
  await admin.giveBackAttempt(); // a right password is not a failure; whoever finishes the change clears the count
}

const wrongCode = (reason) => (reason === "replayed"
  ? new AppError("That code has already been used. Wait for the next one your app shows.", 400, "TWO_FACTOR_CODE_REUSED")
  : new AppError("That code is not right. Check the six digits your app shows now, or use a recovery code.", 400, "INVALID_TWO_FACTOR_CODE"));

async function proveSecondFactor(admin, { code, recoveryCode }) {
  const attempt = await admin.reserveAttempt(); // counted before the code is weighed
  if (attempt.locked) throw lockedFor(attempt.lockUntil);
  const result = await TwoFactorService.check(admin, { code, recoveryCode });
  if (!result.ok) throw wrongCode(result.reason); // already counted
  await admin.giveBackAttempt();
  return result;
}

/** What the Security screen shows: on or off, since when, recovery codes left, and whether the organisation requires it. */
AccountSecurity.twoFactorStatus = async (req) => {
  const admin = await Admin.findById(req.admin.id).select("+twoFactor.recoveryCodes");
  return { ...TwoFactorService.summary(admin), required: (await SecurityPolicyService.policy()).requireTwoFactor };
};

/** Step 1 of enrolling: the password again (a borrowed session must not be able to bind someone else's app), then a new secret to scan or type. */
AccountSecurity.beginTwoFactor = async (req, { password }) => {
  const admin = await accountOf(req);
  await provePassword(admin, password);
  if (admin.loginAttempts > 0) await admin.resetLoginAttempts();
  const shown = await TwoFactorService.begin(admin, { issuer: ISSUER(), account: admin.email });
  return { secret: shown.secret, formattedSecret: shown.formattedSecret, uri: shown.uri, issuer: ISSUER(), account: admin.email };
};

/** Step 2: the code from the app proves it works. Turns two-factor on, ends every OTHER sign-in, returns the recovery codes once. */
AccountSecurity.enableTwoFactor = async (req, { code }) => {
  const admin = await accountOf(req);
  if (TwoFactorService.isEnabled(admin)) throw new AppError("Two-factor is already on.", 409, "TWO_FACTOR_ALREADY_ON");
  if (admin.isLocked) throw lockedFor(admin.lockUntil);
  const attempt = await admin.reserveAttempt(); // a guess at the code is counted before it is weighed
  if (attempt.locked) throw lockedFor(attempt.lockUntil);
  let result;
  try {
    result = await TwoFactorService.confirm(admin, code);
  } catch (error) {
    if (error.code !== "INVALID_TWO_FACTOR_CODE") await admin.giveBackAttempt(); // only a wrong code is a failure
    throw error;
  }
  await admin.resetLoginAttempts();
  // Sessions opened before there was a second factor stay open on nobody's say-so but a thief's: end them, keep this one.
  await AuthSession.updateMany({ adminId: admin._id, revokedAt: null, ...(req.sessionId ? { _id: { $ne: req.sessionId } } : {}) }, { $set: { revokedAt: new Date() } });
  mailLater({ to: admin.email, ...securityNoticeMail({ name: admin.name, headline: "Two-factor sign-in was turned on", detail: "From now on signing in asks for a code from your authenticator app. Your other devices were signed out." }) }, "two-factor on notice");
  return result;
};

/** Turn it off: the password AND a code (or a recovery code), unless the organisation requires it. */
AccountSecurity.disableTwoFactor = async (req, { password, code, recoveryCode }) => {
  const admin = await accountOf(req);
  if (!TwoFactorService.isEnabled(admin)) throw new AppError("Two-factor is not on.", 409, "TWO_FACTOR_NOT_ON");
  if ((await SecurityPolicyService.policy()).requireTwoFactor) {
    throw new AppError("Your organisation requires two-factor sign-in, so it cannot be turned off. Ask an administrator.", 403, "TWO_FACTOR_REQUIRED_BY_POLICY");
  }
  await provePassword(admin, password);
  await proveSecondFactor(admin, { code, recoveryCode });
  if (admin.loginAttempts > 0) await admin.resetLoginAttempts();
  await TwoFactorService.disable(admin);
  mailLater({ to: admin.email, ...securityNoticeMail({ name: admin.name, headline: "Two-factor sign-in was turned off", detail: "Signing in no longer asks for a code." }) }, "two-factor off notice");
  return { enabled: false };
};

/** New recovery codes, replacing every old one: the password AND a code. */
AccountSecurity.regenerateRecoveryCodes = async (req, { password, code, recoveryCode }) => {
  const admin = await accountOf(req);
  if (!TwoFactorService.isEnabled(admin)) throw new AppError("Two-factor is not on.", 409, "TWO_FACTOR_NOT_ON");
  await provePassword(admin, password);
  await proveSecondFactor(admin, { code, recoveryCode });
  if (admin.loginAttempts > 0) await admin.resetLoginAttempts();
  return TwoFactorService.regenerate(admin);
};

AccountSecurity.notice = (admin, headline, detail) => mailLater({ to: admin.email, ...securityNoticeMail({ name: admin.name, headline, detail }) }, headline);
AccountSecurity.RESET_MINUTES = RESET_MINUTES;

module.exports = AccountSecurity;
