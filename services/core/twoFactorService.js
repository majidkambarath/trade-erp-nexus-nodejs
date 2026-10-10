// Two-factor sign-in, for any account kind that carries a `twoFactor` block: a customer's `Admin` and the developer console's
// `PlatformUser` use this one implementation. It works on the account's own model (`doc.constructor`) with single atomic updates,
// so two requests racing for the same code or the same recovery code cannot both win.
//
// The pieces: a base32 secret held ENCRYPTED (utils/secretBox.js) and shown once at enrolment; a code (utils/totp.js) proved at
// enrolment and at every sign-in; ten single-use recovery codes held only as hashes; and the last time step accepted, so a code
// that was seen once cannot be used again.
//
// This service never counts a failure and never signs anyone in: whoever calls it owns the lock-out and the session. It says
// whether the proof was good.
const AppError = require("../../utils/AppError");
const secretBox = require("../../utils/secretBox");
const totp = require("../../utils/totp");
const { newRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode } = require("../../utils/accountTokens");

const RECOVERY_COUNT = 10;
const modelOf = (doc) => doc.constructor;
const unused = (doc) => (doc.twoFactor?.recoveryCodes || []).filter((c) => !c.usedAt).length;

class TwoFactorService {
  static isEnabled(doc) {
    return Boolean(doc?.twoFactor?.enabled);
  }

  static recoveryLeft(doc) {
    return unused(doc);
  }

  /** Start an enrolment: a new secret, kept (encrypted) as PENDING until a code from the app proves it. Returns what to show once. */
  static async begin(doc, { issuer, account }) {
    if (this.isEnabled(doc)) throw new AppError("Two-factor is already on. Turn it off first to set it up again.", 409, "TWO_FACTOR_ALREADY_ON");
    const secret = totp.generateSecret();
    await modelOf(doc).updateOne({ _id: doc._id }, { $set: { "twoFactor.pendingSecretEnc": secretBox.encrypt(secret) } });
    return { secret, formattedSecret: totp.formatSecret(secret), uri: totp.otpauthUri({ secret, account, issuer }) };
  }

  /**
   * Finish it: the code must be the one the pending secret produces now. Switches two-factor on and returns the recovery codes,
   * in plain text, THIS ONCE (only their hashes are kept). `doc` must have been loaded with `+twoFactor.pendingSecretEnc`.
   */
  static async confirm(doc, code) {
    const pending = doc.twoFactor?.pendingSecretEnc;
    if (!pending) throw new AppError("Start again: ask for a new key first.", 409, "TWO_FACTOR_SETUP_NOT_STARTED");
    const proof = totp.verifyTotp(secretBox.decrypt(pending), code);
    if (!proof.ok) throw new AppError("That code is not right. Check the six digits your app shows now and try again.", 400, "INVALID_TWO_FACTOR_CODE");
    const codes = newRecoveryCodes(RECOVERY_COUNT);
    const done = await modelOf(doc).updateOne(
      { _id: doc._id, "twoFactor.enabled": { $ne: true } },
      {
        $set: {
          "twoFactor.enabled": true,
          "twoFactor.enabledAt": new Date(),
          "twoFactor.secretEnc": pending,
          "twoFactor.lastStep": proof.step, // the code just typed is spent
          "twoFactor.recoveryCodes": codes.map((c) => ({ hash: hashRecoveryCode(c), usedAt: null })),
        },
        $unset: { "twoFactor.pendingSecretEnc": 1 },
      }
    );
    if (done.modifiedCount !== 1) throw new AppError("Two-factor is already on.", 409, "TWO_FACTOR_ALREADY_ON");
    return { recoveryCodes: codes };
  }

  /**
   * Is this a good second factor for the account? `code` is the six digits from the app, `recoveryCode` one of the ten. A good
   * one is spent here (the step is recorded; the recovery code is crossed off). `doc` must have been loaded with
   * `+twoFactor.secretEnc +twoFactor.recoveryCodes`.
   *   { ok: true, method: "code" | "recovery", recoveryLeft }   or   { ok: false, reason: "invalid" | "replayed" }
   */
  static async check(doc, { code, recoveryCode } = {}) {
    const tf = doc.twoFactor;
    if (!tf?.enabled || !tf.secretEnc) return { ok: false, reason: "invalid" };

    // (text only: String() on an object a request body sent, with its own toString, throws - and came back as a 500)
    if (recoveryCode !== undefined && recoveryCode !== null && recoveryCode !== "" && typeof recoveryCode !== "string") return { ok: false, reason: "invalid" };
    if (typeof recoveryCode === "string" && recoveryCode.trim() !== "") {
      if (!looksLikeRecoveryCode(recoveryCode)) return { ok: false, reason: "invalid" };
      const hash = hashRecoveryCode(recoveryCode);
      const spent = await modelOf(doc).updateOne(
        { _id: doc._id, "twoFactor.recoveryCodes": { $elemMatch: { hash, usedAt: null } } },
        { $set: { "twoFactor.recoveryCodes.$.usedAt": new Date() } }
      );
      if (spent.modifiedCount !== 1) return { ok: false, reason: "invalid" };
      return { ok: true, method: "recovery", recoveryLeft: Math.max(0, unused(doc) - 1) };
    }

    const proof = totp.verifyTotp(secretBox.decrypt(tf.secretEnc), code, { afterStep: tf.lastStep ?? -1 });
    if (!proof.ok) return { ok: false, reason: proof.reason };
    // Claim the step. If another request claimed this one (or a later one) first, this code is a replay.
    const claimed = await modelOf(doc).updateOne(
      { _id: doc._id, $or: [{ "twoFactor.lastStep": { $lt: proof.step } }, { "twoFactor.lastStep": null }, { "twoFactor.lastStep": { $exists: false } }] },
      { $set: { "twoFactor.lastStep": proof.step } }
    );
    if (claimed.modifiedCount !== 1) return { ok: false, reason: "replayed" };
    doc.twoFactor.lastStep = proof.step;
    return { ok: true, method: "code", recoveryLeft: unused(doc) };
  }

  /** Ten new recovery codes in place of every old one (used or not). Returned once. */
  static async regenerate(doc) {
    const codes = newRecoveryCodes(RECOVERY_COUNT);
    const done = await modelOf(doc).updateOne(
      { _id: doc._id, "twoFactor.enabled": true },
      { $set: { "twoFactor.recoveryCodes": codes.map((c) => ({ hash: hashRecoveryCode(c), usedAt: null })) } }
    );
    if (done.modifiedCount !== 1) throw new AppError("Two-factor is not on.", 409, "TWO_FACTOR_NOT_ON");
    return { recoveryCodes: codes };
  }

  /** Switch it off and forget everything: the secret, a pending secret, the recovery codes, the last step. */
  static async disable(doc) {
    await modelOf(doc).updateOne(
      { _id: doc._id },
      {
        $set: { "twoFactor.enabled": false, "twoFactor.enabledAt": null, "twoFactor.secretEnc": null, "twoFactor.lastStep": -1 },
        $unset: { "twoFactor.recoveryCodes": 1, "twoFactor.pendingSecretEnc": 1 },
      }
    );
  }

  /** What a screen may be told: on or off, since when, how many recovery codes are left. */
  static summary(doc) {
    return { enabled: this.isEnabled(doc), enabledAt: doc.twoFactor?.enabledAt || null, recoveryCodesLeft: this.isEnabled(doc) ? unused(doc) : 0 };
  }
}

module.exports = TwoFactorService;
