const Admin = require("../../models/core/adminModel");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const AuthSession = require("../../models/core/authSessionModel");
const AppError = require("../../utils/AppError");
const Organisation = require("../../models/core/organisationModel");
const { runWithTenant, runUnscoped } = require("../../utils/tenantContext");
const { permissionsFor, mayManage, withoutSystemFields } = require("../../utils/adminPermissions");
const { deleteFromCloudinary } = require("../../middleware/upload");
const { signInRefusal } = require("../../utils/subscriptionGate");
const { subscriptionState } = require("../../utils/plans");
const UsageService = require("./usageService");
const Branch = require("../../models/core/branchModel");
const TwoFactorService = require("./twoFactorService");
const { signChallenge, verifyChallenge, CHALLENGE_SECONDS } = require("../../utils/accountTokens");

// The signing key: utils/productionConfig.js (no placeholder fallback in production; the server refuses to start without a real one).
const { jwtSecret } = require("../../utils/productionConfig");
// Short access tokens: a stolen one stops working within minutes, and the session cookie renews it.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "30d";
// How long a rotated refresh token is still honoured: two tabs of one browser may refresh in the same moment, and the second one
// still holds the cookie the first one has just replaced. Longer than this, a rotated token is a copy someone kept.
const refreshGraceMs = () => {
  const seconds = process.env.REFRESH_REUSE_GRACE_SECONDS === undefined ? 20 : Number(process.env.REFRESH_REUSE_GRACE_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 20) * 1000;
};

// Generate JWT tokens. Both name the session (`sid`), so ending the session ends both, and each says what it is for: an access token
// opens the API and nothing else; a refresh token only renews (it is a different claim, not a different key, so a deploy of this
// change does not sign anyone out: access tokens issued before it carry no `use` and are accepted until they expire).
//   options.jti        the refresh token's own id, so a session can tell the current cookie from a rotated one
//   options.refreshExp when the refresh token ends (epoch seconds); default is the configured lifetime
const generateTokens = (payload, sid, options = {}) => {
  const accessToken = jwt.sign({ ...payload, sid, use: "access" }, jwtSecret(), {
    expiresIn: JWT_EXPIRES_IN,
    issuer: "ERP-system",
    audience: "ERP-admin",
    algorithm: "HS256",
  });

  const jti = options.jti || crypto.randomUUID();
  const refreshClaims = { id: payload.id, sid, type: "refresh", use: "refresh", jti };
  if (options.refreshExp) refreshClaims.exp = options.refreshExp;
  const refreshToken = jwt.sign(refreshClaims, jwtSecret(), {
    ...(options.refreshExp ? {} : { expiresIn: JWT_REFRESH_EXPIRES_IN }),
    issuer: "ERP-system",
    audience: "ERP-admin",
    algorithm: "HS256",
  });

  return { accessToken, refreshToken, jti };
};

// Verify token
const verifyToken = (token) => {
  try {
    return jwt.verify(token, jwtSecret(), {
      issuer: "ERP-system",
      audience: "ERP-admin",
      algorithms: ["HS256"],
    });
  } catch (error) {
    if (error.name === "TokenExpiredError")
      throw new AppError("Token has expired", 401, "TOKEN_EXPIRED");
    if (error.name === "JsonWebTokenError")
      throw new AppError("Invalid token", 401, "INVALID_TOKEN");
    throw new AppError("Token verification failed", 401, "TOKEN_ERROR");
  }
};

// Admin login
const MAX_EMAIL = 254;
const MAX_PASSWORD = 1000; // bcrypt reads 72 bytes; this only stops a megabyte being turned into bytes for nothing

// A real bcrypt hash of nothing in particular, made once. A sign-in for an address that has no account (or a switched-off one) weighs
// the typed password against it, and does the same database work, so a refusal takes as long as one for a real account and the time
// does not say which it was. (bcrypt returns at once for a malformed hash, which would give the game away.)
let decoy;
const decoyHash = () => (decoy ||= bcrypt.hash("nobody-has-this-password", 12));
const decoySignIn = async (password) => {
  // the same steps a real account takes: its organisation is read, its attempt is counted, the password is weighed
  await Organisation.exists({ code: "\u0000decoy" });
  await runUnscoped("sign-in: a refusal for an address with no account does the work of one with an account, so the time says nothing", () =>
    Admin.updateOne({ _id: new mongoose.Types.ObjectId() }, { $inc: { loginAttempts: 0 } })
  );
  await bcrypt.compare(String(password), await decoyHash());
};
const refusedSignIn = () => new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");

const loginAdmin = async (email, password, ipAddress = null, context = {}) => {
  // Both are text and nothing else: an object or an array in either field is never a sign-in, and is not handed to the database.
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password)
    throw new AppError(
      "Email and password are required",
      400,
      "MISSING_CREDENTIALS"
    );
  if (email.length > MAX_EMAIL || password.length > MAX_PASSWORD) throw refusedSignIn();

  // The one moment no organisation is known: a person types an email, and the account row says which
  // organisation they belong to. Everything after this runs as that organisation.
  const admin = await runUnscoped("sign-in: the account is found by its email, before any organisation is known", () =>
    Admin.findOne({ email: email.trim().toLowerCase(), isActive: true }).select("+password +loginAttempts +lockUntil")
  );

  // No such person, and a person who is switched off or suspended, are refused in the same words and in the same time. (A suspended
  // person with the right password used to be given tokens that every later request then refused.)
  if (!admin || admin.status !== "active") {
    await decoySignIn(password);
    throw refusedSignIn();
  }

  const organisation = await assertOrganisationOpen(admin.companyId);
  const result = await runWithTenant({ companyId: admin.companyId, branchId: admin.branchId }, () => finishLogin(admin, password, ipAddress, context));
  // Where the subscription stands, so the app can warn in the grace period or explain a read-only organisation
  // before the first thing is refused.
  return { ...result, subscription: subscriptionState(organisation) };
};

// An account whose organisation is gone must not sign in, and neither must one whose organisation is suspended,
// closed, or past the end of its subscription (unless that organisation is set to read-only, which may still
// sign in and look). The refusal says which, and when it ended, so the screen can tell the person.
const assertOrganisationOpen = async (companyId) => {
  const organisation = await Organisation.findOne({ code: companyId });
  if (!organisation) throw new AppError("This account's organisation could not be found. Please contact support.", 403, "ORGANISATION_NOT_FOUND");
  const refusal = signInRefusal(organisation);
  if (refusal) throw refusal;
  return organisation;
};

const lockedError = (lockUntil) =>
  new AppError(`Account locked. Try after ${Math.max(1, Math.ceil((new Date(lockUntil).getTime() - Date.now()) / (1000 * 60)))} minutes`, 423, "ACCOUNT_LOCKED");

// Password check, lock-out, token and session: all as the account's own organisation.
const finishLogin = async (admin, password, ipAddress, context) => {
  if (admin.isLocked) throw lockedError(admin.lockUntil);

  // The attempt is counted BEFORE the password is weighed (see the lock-out in models/core/adminModel.js): the sixth guess and every one
  // after it is refused unweighed, however many arrive together.
  const attempt = await admin.reserveAttempt();
  if (attempt.locked) throw lockedError(attempt.lockUntil);

  const isValid = await admin.comparePassword(password);
  if (!isValid) throw refusedSignIn(); // already counted

  // Two-factor on: the password alone opens nothing. Hand back a challenge that proves the password was right, for five minutes,
  // and leave the failure count where it was: the second step clears it, so a thief with the password cannot keep resetting it.
  if (admin.twoFactor?.enabled) {
    await admin.giveBackAttempt();
    return { twoFactorRequired: true, challengeToken: signChallenge({ sub: String(admin._id), cid: admin.companyId }), challengeExpiresIn: CHALLENGE_SECONDS };
  }

  await admin.resetLoginAttempts();
  return startSession(admin, ipAddress, context);
};

// Opens the session once every proof is in: the sign-in time, the tokens, the session row the refresh cookie names.
const startSession = async (admin, ipAddress, context) => {
  admin.lastLogin = new Date();
  await admin.save();

  const tokenPayload = {
    id: admin._id,
    email: admin.email,
    type: admin.type,
    permissions: permissionsFor(admin.type), // derived: what an old row once stored is ignored
    name: admin.name,
    companyId: admin.companyId,
    branchId: admin.branchId,
  };

  // One session per sign-in. The refresh token names it, so logout can end exactly this one.
  const sid = crypto.randomUUID();
  const { accessToken, refreshToken, jti } = generateTokens(tokenPayload, sid);
  const refreshExpiresAt = new Date(jwt.decode(refreshToken).exp * 1000);
  await AuthSession.create({
    _id: sid,
    adminId: admin._id,
    userAgent: context.userAgent || null,
    ip: ipAddress,
    expiresAt: refreshExpiresAt,
    refreshJti: jti, // the cookie now in the browser; every refresh replaces it
  });

  return {
    admin: admin.toJSON(),
    tokens: { accessToken, refreshToken, refreshExpiresAt, expiresIn: JWT_EXPIRES_IN },
    loginInfo: { lastLogin: admin.lastLogin, ipAddress },
  };
};

// Sign-in, step two: the challenge from step one plus a code from the authenticator app (or one recovery code). A wrong code counts
// toward the same lock as a wrong password; a locked account is refused here exactly as at step one.
const completeTwoFactorLogin = async ({ challengeToken, code, recoveryCode }, ipAddress = null, context = {}) => {
  let claims;
  try {
    claims = verifyChallenge(challengeToken);
  } catch (error) {
    throw new AppError(error.message, 401, error.code || "CHALLENGE_INVALID");
  }
  if (code === undefined && recoveryCode === undefined) throw new AppError("Enter the code from your authenticator app", 400, "MISSING_CODE");

  const admin = await runUnscoped("sign-in step two: the challenge names the account, which names its organisation", () =>
    Admin.findOne({ _id: claims.sub, isActive: true }).select("+loginAttempts +lockUntil +twoFactor.secretEnc +twoFactor.recoveryCodes")
  );
  if (!admin || admin.status !== "active" || !admin.twoFactor?.enabled || admin.companyId !== claims.cid) {
    throw new AppError("This sign-in cannot be continued. Start again.", 401, "CHALLENGE_INVALID");
  }
  // A challenge handed out before every sign-in was ended (a password reset, an administrator's two-factor reset) is part of what was
  // ended. (Whole seconds, like the access tokens: one handed out in the same second as the reset is the sign-in that came after it.)
  if (admin.sessionsRevokedAt && claims.iat && claims.iat < Math.floor(admin.sessionsRevokedAt.getTime() / 1000)) {
    throw new AppError("This sign-in cannot be continued. Start again.", 401, "CHALLENGE_INVALID");
  }
  const organisation = await assertOrganisationOpen(admin.companyId);

  const result = await runWithTenant({ companyId: admin.companyId, branchId: admin.branchId }, async () => {
    if (admin.isLocked) throw lockedError(admin.lockUntil);
    const attempt = await admin.reserveAttempt(); // counted before the code is weighed, like a password
    if (attempt.locked) throw lockedError(attempt.lockUntil);
    const proof = await TwoFactorService.check(admin, { code, recoveryCode });
    if (!proof.ok) {
      throw proof.reason === "replayed"
        ? new AppError("That code has already been used. Wait for the next one your app shows.", 401, "TWO_FACTOR_CODE_REUSED")
        : new AppError("That code is not right. Check the six digits your app shows now, or use a recovery code.", 401, "INVALID_TWO_FACTOR_CODE");
    }
    await admin.resetLoginAttempts();
    const session = await startSession(admin, ipAddress, context);
    return { ...session, signIn: { method: proof.method, recoveryCodesLeft: proof.method === "recovery" ? proof.recoveryLeft : undefined } };
  });
  return { ...result, subscription: subscriptionState(organisation) };
};

// Create new admin
// Throws when this actor may not do this to this account. Done inside the service, after any upload, so a
// refused request still passes through the cleanup below instead of leaving files behind.
const assertMay = (args) => {
  const verdict = mayManage(args);
  if (!verdict.ok) throw new AppError(verdict.message, 403, verdict.code);
};

const createAdmin = async (adminData, files = null, creatorId = null, actorType = null) => {
  adminData = withoutSystemFields(adminData);
  // The company's letterhead belongs to the organisation (services/core/companyProfileService.js), never to a person.
  delete adminData.companyInfo;
  if (!actorType) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
  try {
    assertMay({ actor: actorType, nextType: adminData.type, action: "create" });
  } catch (error) {
    if (files?.profileImage) await deleteFromCloudinary(files.profileImage.filename);
    if (files?.companyLogo) await deleteFromCloudinary(files.companyLogo.filename);
    throw error;
  }
  if (typeof adminData.email !== "string" || !adminData.email.trim()) throw new AppError("Please provide a valid email", 400, "VALIDATION_ERROR");
  // An address belongs to one person in one organisation (so signing in needs no organisation picker), which makes it unique across ALL
  // organisations: the check looks everywhere and answers in the same words whichever organisation holds it. (Left to the database's
  // unique index it answered "Duplicate field value" with the conflicting value for another organisation's address, and "Email already
  // exists" for this one's: two different answers for the one fact the caller must not be able to read.)
  const existing = await runUnscoped("create account: an email address is unique across organisations, so it is looked for in all of them", () =>
    Admin.exists({ email: adminData.email.trim().toLowerCase() })
  );
  if (existing) throw new AppError("Email already exists", 400, "EMAIL_EXISTS");

  try {
    // The plan allows only so many people. Checked after the permission and duplicate checks, so a refusal for
    // those reasons is not hidden behind this one, and inside the try so an upload is cleaned up when it refuses.
    await UsageService.assertRoom("users");

    // a person belongs to a branch that exists in this organisation and is switched on (the head office is always there)
    if (adminData.branchId && String(adminData.branchId).toLowerCase() !== "main") {
      const code = String(adminData.branchId).toLowerCase();
      if (!(await Branch.exists({ code, isActive: true }))) throw new AppError("That branch does not exist in this organisation", 400, "BRANCH_NOT_FOUND");
      adminData.branchId = code;
    }

    // Handle profile image
    if (files?.profileImage) {
      adminData.profileImage = {
        url: files.profileImage.path,
        publicId: files.profileImage.filename
      };
    }

    // A company logo sent with a person is not kept on the person: it is discarded (and removed from storage).
    if (files?.companyLogo) { await deleteFromCloudinary(files.companyLogo.filename).catch(() => {}); files = { ...files, companyLogo: null }; }

    const admin = new Admin({ ...adminData, mustChangePassword: true, createdBy: creatorId });
    await admin.save();
    return admin.toJSON();
  } catch (error) {
    // Cleanup uploaded files if admin creation fails
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw error;
  }
};

// Update admin
// policy is { actorType } for one person managing another, or { selfService: true } for the profile screen,
// where a person edits only themselves (that route has already removed type, status and the rest). With
// neither, it refuses: a new caller that forgets the policy must fail, not pass.
const updateAdmin = async (adminId, updateData, files = null, updatedBy = null, policy = {}) => {
  updateData = withoutSystemFields(updateData);
  delete updateData.companyInfo; // the letterhead is the organisation's, changed through /company/profile
  // A person editing their own profile changes their name, and their picture through the upload route. NOT the sign-in address (a stolen
  // session could point it at a mailbox of its own and then reset the password from there), the branch they work in, the
  // password-change flag, the picture's storage id (the old picture is deleted by it) or anything else about who they are.
  if (policy.selfService) updateData = { ...(updateData.name !== undefined ? { name: updateData.name } : {}) };
  let endSessions = false; // set below when this change must end the person's sign-ins
  const admin = await Admin.findById(adminId);
  if (!admin) {
    // Cleanup uploaded files if admin not found
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }

  try {
    if (!policy.selfService) {
      if (!policy.actorType) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
      assertMay({ actor: policy.actorType, target: admin.type, nextType: updateData.type, self: String(admin._id) === String(updatedBy), action: "update" });
      // Switching someone back on takes a seat again, so it meets the plan's user limit just as adding a new person does
      // (the same rule userService applies on the new users API). Inside the try: a refusal cleans up its uploads.
      const flag = (value, otherwise) => (value === undefined ? otherwise : value === true || value === "true"); // a form sends text
      const wasActive = admin.isActive !== false && admin.status === "active";
      const willBeActive = flag(updateData.isActive, admin.isActive !== false) && (updateData.status ?? admin.status) === "active";
      if (!wasActive && willBeActive) await UsageService.assertRoom("users");
      // A password set by someone else, or a person switched off, ends every sign-in they hold: the old password is no longer who they are.
      endSessions = Boolean(updateData.password) || (wasActive && !willBeActive);
    }
    // Store old image public IDs for cleanup
    const oldProfileImageId = admin.profileImage?.publicId;

    // Handle profile image update
    if (files?.profileImage) {
      updateData.profileImage = {
        url: files.profileImage.path,
        publicId: files.profileImage.filename
      };
    }

    // A company logo sent with a person is not kept on the person: it is discarded (and removed from storage).
    if (files?.companyLogo) { await deleteFromCloudinary(files.companyLogo.filename).catch(() => {}); files = { ...files, companyLogo: null }; }

    // Set the updatedBy field using $locals
    if (updatedBy) {
      admin.$locals = admin.$locals || {};
      admin.$locals.updatedBy = updatedBy;
    }

    // A password set by someone else (an administrator resetting it) is theirs to replace at the next sign-in.
    if (!policy.selfService && updateData.password) { updateData.mustChangePassword = true; updateData.lockUntil = undefined; updateData.loginAttempts = 0; }

    // Apply updates to the admin object
    Object.assign(admin, updateData);
    
    // Save the updated admin
    const savedAdmin = await admin.save();
    if (endSessions) await endSessionsOf(admin._id);

    // Delete old images from Cloudinary after successful update
    if (files?.profileImage && oldProfileImageId) {
      await deleteFromCloudinary(oldProfileImageId);
    }

    return savedAdmin.toJSON();
  } catch (error) {
    // Cleanup new uploaded files if update fails
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw error;
  }
};

// Get admin by ID
const getAdminById = async (adminId) => {
  const admin = await Admin.findById(adminId)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email');
  
  if (!admin) {
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }
  
  return admin.toJSON();
};

// Get all admins with pagination
const getAllAdmins = async (page = 1, limit = 10, filters = {}) => {
  const skip = (page - 1) * limit;
  
  // Build query
  const query = { isActive: true };
  if (filters.type) query.type = filters.type;
  if (filters.status) query.status = filters.status;
  if (filters.search) {
    // text to find, not a pattern to run (a crafted pattern is a way to make the database spin)
    const needle = String(filters.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: needle, $options: 'i' } },
      { email: { $regex: needle, $options: 'i' } },
      { 'companyInfo.companyName': { $regex: needle, $options: 'i' } }
    ];
  }

  const [admins, total] = await Promise.all([
    Admin.find(query)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Admin.countDocuments(query)
  ]);

  return {
    admins: admins.map(admin => admin.toJSON()),
    pagination: {
      current: page,
      pages: Math.ceil(total / limit),
      total,
      limit
    }
  };
};

// Delete admin (soft delete)
const deleteAdmin = async (adminId, deletedBy = null, actorType = null) => {
  if (!actorType) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
  const admin = await Admin.findById(adminId);
  if (!admin) {
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }
  assertMay({ actor: actorType, target: admin.type, self: String(admin._id) === String(deletedBy), action: "delete" });

  // Set admin as inactive instead of hard delete
  admin.isActive = false;
  admin.status = 'inactive';
  if (deletedBy) {
    admin.$locals.updatedBy = deletedBy;
  }
  await admin.save();
  await endSessionsOf(admin._id);

  // Optionally delete images from Cloudinary
  const imagesToDelete = [];
  if (admin.profileImage?.publicId) {
    imagesToDelete.push(admin.profileImage.publicId);
  }
  // (not companyInfo.companyLogo: the organisation's adopted letterhead may use that very image)
  
  if (imagesToDelete.length > 0) {
    await deleteFromCloudinary(imagesToDelete);
  }

  return { message: 'Admin deleted successfully' };
};

const SESSION_ENDED = "Your session has ended. Please sign in again.";
const endedSession = () => new AppError(SESSION_ENDED, 401, "SESSION_REVOKED");

// Ends sessions (all of a person's, or all but the one making the request). Their refresh cookies stop working at once, and so do the
// access tokens that name them: the API looks the session up on every request (middleware/authMiddleware.js).
const endSessionsOf = (adminId, exceptSessionId = null) =>
  AuthSession.updateMany(
    { adminId, revokedAt: null, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) },
    { $set: { revokedAt: new Date() } }
  );

// A cookie from before rotation existed carries no token id; its session has none either. Both read as the same placeholder.
const jtiOf = (value) => value || "legacy";

// A refresh token that was already replaced has come back after the grace period. Two browsers hold copies of one cookie, and one of
// them is not the person: there is no telling which, so the whole sign-in ends (the person signs in again; the thief cannot).
const reuseDetected = async (admin, session) => {
  await AuthSession.updateOne({ _id: session._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await require("./auditService").log({
    req: { admin: { id: String(admin._id), email: admin.email, name: admin.name }, ip: null },
    action: "SESSION_REFRESH_REUSE_DETECTED",
    entity: "Admin",
    entityId: admin._id,
    summary: `${admin.email}: a refresh token that had already been replaced was presented again; that sign-in was ended`,
  });
  require("./accountSecurityService").notice(admin, "A sign-in was ended for your safety", "A copy of an old sign-in was used again, so that sign-in was ended. If you were not expecting this, change your password.");
};

// Refresh: the refresh token must name a session that is still open. Logging out, a password change, or an admin being deactivated ends
// it, so the next refresh fails and the browser shows the sign-in page.
//
// Every refresh REPLACES the cookie (a new `jti`), so a copy of an old cookie is recognisable: it is neither the current token nor, for
// a few seconds, the one just replaced (two tabs refreshing together). Anything else ends the session.
// -> { accessToken, expiresIn, admin } and, when the cookie was replaced, { refreshToken, refreshExpiresAt } for the controller to set.
const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken || typeof refreshToken !== "string") throw endedSession();

  const decoded = verifyToken(refreshToken);
  if (decoded.type !== "refresh" || typeof decoded.sid !== "string")
    throw new AppError("Invalid token type", 401, "INVALID_TOKEN_TYPE");

  // The session id is a random secret that names its own organisation, so it is found with none in scope.
  const session = await runUnscoped("refresh: the session id is a secret that names its own organisation", () => AuthSession.findById(decoded.sid));
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.companyId || String(session.adminId) !== String(decoded.id))
    throw endedSession();

  await assertOrganisationOpen(session.companyId);
  const { admin, rotatedTo } = await runWithTenant({ companyId: session.companyId }, async () => {
    const found = await Admin.findById(decoded.id);
    if (!found || !found.isActive || found.status !== "active")
      throw new AppError("Admin not found or inactive", 401, "ADMIN_INACTIVE");

    const presented = jtiOf(decoded.jti);
    let next = null;
    if (presented === jtiOf(session.refreshJti)) {
      // The current cookie: replace it. One atomic swap, so of two requests carrying it exactly one rotates.
      const candidate = crypto.randomUUID();
      const swapped = await AuthSession.findOneAndUpdate(
        { _id: session._id, revokedAt: null, refreshJti: session.refreshJti ?? null },
        { $set: { prevRefreshJti: jtiOf(session.refreshJti), refreshJti: candidate, rotatedAt: new Date(), lastSeenAt: new Date() } },
        { new: true }
      );
      if (swapped) next = candidate;
    }
    if (!next) {
      // Not the current one (or it was swapped a moment ago by the request that beat us): honoured only as the token just replaced.
      const latest = await AuthSession.findById(session._id).lean();
      const justReplaced = latest && !latest.revokedAt && latest.prevRefreshJti === presented && latest.rotatedAt && Date.now() - new Date(latest.rotatedAt).getTime() <= refreshGraceMs();
      if (!justReplaced) {
        await reuseDetected(found, session);
        throw endedSession();
      }
      await AuthSession.updateOne({ _id: session._id }, { lastSeenAt: new Date() });
    }
    return { admin: found, rotatedTo: next };
  });

  const tokenPayload = {
    id: admin._id,
    email: admin.email,
    type: admin.type,
    permissions: permissionsFor(admin.type), // derived: what an old row once stored is ignored
    name: admin.name,
    companyId: admin.companyId,
    branchId: admin.branchId,
  };
  // the replacement cookie ends when the session does (the sign-in's own fixed lifetime), not thirty days from now
  const { accessToken, refreshToken: replacement } = generateTokens(tokenPayload, session._id, rotatedTo ? { jti: rotatedTo, refreshExp: Math.floor(session.expiresAt.getTime() / 1000) } : {});

  return { accessToken, expiresIn: JWT_EXPIRES_IN, admin: admin.toJSON(), ...(rotatedTo ? { refreshToken: replacement, refreshExpiresAt: session.expiresAt } : {}) };
};

// Logout: revoke this browser's session. An expired or unsigned token has nothing to revoke.
const logoutSession = async (refreshToken) => {
  if (!refreshToken) return;
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, jwtSecret(), {
      issuer: "ERP-system",
      audience: "ERP-admin",
      algorithms: ["HS256"],
      ignoreExpiration: true,
    });
  } catch {
    return;
  }
  if (decoded?.type === "refresh" && decoded.sid) {
    await runUnscoped("logout: the session id is a secret that names the session to end", () =>
      AuthSession.updateOne({ _id: decoded.sid, revokedAt: null }, { revokedAt: new Date() })
    );
  }
};

module.exports = {
  loginAdmin,
  completeTwoFactorLogin,
  logoutSession,
  createAdmin,
  updateAdmin,
  getAdminById,
  getAllAdmins,
  deleteAdmin,
  refreshAccessToken,
  endSessionsOf,
  lockedError,
  verifyToken,
  generateTokens,
};