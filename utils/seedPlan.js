// What `npm run seed` (utils/setup.js) is allowed to create, decided from the environment alone: pure, so the rules are tested
// without a database and the script can refuse BEFORE it connects to one.
//
// The rule the old script broke: it made two super administrators with a password written in the source ("12312312") and, on every
// run, put that password back on an account that already existed. Fine on a laptop, a way into production if anyone ran it there.
//
//   development / test (unset NODE_ENV, or anything but production)   exactly as before: admin@test.com and admin@test.uae with the
//                                                                     known password, every run re-applied. Many tests depend on it.
//   production (NODE_ENV=production, or on Render)                    the known default is never created. The account comes from
//                                                                     ADMIN_EMAIL (required) and ADMIN_PASSWORD, or - with no
//                                                                     password given - a strong random one printed once. Either way
//                                                                     the person must choose their own at the first sign-in.
//                                                                     An account that already exists is left alone unless
//                                                                     ADMIN_RESET=1 says to replace its password.
const crypto = require("crypto");

const DEV_ADMINS = [
  { name: "Super Admin", email: "admin@test.com", password: "12312312" },
  { name: "Super Admin", email: "admin@test.uae", password: "12312312" },
];

// Passwords that are written down somewhere public, or in this very repository.
const KNOWN_WEAK = new Set(["12312312", "123123123", "12345678", "123456789", "1234567890", "password", "password1", "admin123", "admin1234", "qwerty123", "letmein123"]);
const MIN_LENGTH = 12;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? "").trim());

/** Why this password may not be used for a production administrator, in words; null when it may. */
function weakReason(password) {
  const p = String(password ?? "");
  if (KNOWN_WEAK.has(p.toLowerCase())) return "that is a well-known password (the old built-in default, or one on every list)";
  if (p.length < MIN_LENGTH) return `use at least ${MIN_LENGTH} characters`;
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return "use both letters and digits";
  if (/^(.)\1+$/.test(p)) return "do not repeat one character";
  return null;
}

// 24 characters of base64url (144 random bits), re-drawn in the unlikely case it has no letter or no digit.
function generatePassword() {
  for (;;) {
    const p = crypto.randomBytes(18).toString("base64url");
    if (!weakReason(p)) return p;
  }
}

const isProduction = (env) => env.NODE_ENV === "production" || env.RENDER === "true";

/**
 * @returns {{ production: boolean, accounts: {name,email,password,mustChangePassword,generated}[], replaceExisting: boolean }}
 * @throws Error with a sentence a person can act on.
 */
function planSeed(env = process.env) {
  const production = isProduction(env);
  const email = String(env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const given = env.ADMIN_PASSWORD !== undefined && env.ADMIN_PASSWORD !== "";

  if (!production && !email && !given) {
    return { production, replaceExisting: true, accounts: DEV_ADMINS.map((a) => ({ ...a, mustChangePassword: false, generated: false })) };
  }

  if (!email) {
    throw new Error(production
      ? "Set ADMIN_EMAIL to the address of the first administrator (and ADMIN_PASSWORD, or leave it out for a generated one). Production never creates the built-in test accounts."
      : "ADMIN_PASSWORD is set but ADMIN_EMAIL is not. Set both, or neither for the development defaults.");
  }
  if (!EMAIL.test(email)) throw new Error(`ADMIN_EMAIL "${email}" does not look like an email address.`);

  if (given && production) {
    // A developer's machine may use a password of their own choosing; production may not use a weak one, the old default above all.
    const reason = weakReason(env.ADMIN_PASSWORD);
    if (reason) throw new Error(`ADMIN_PASSWORD refused: ${reason}.`);
  }

  const password = given ? env.ADMIN_PASSWORD : generatePassword();
  return {
    production,
    replaceExisting: !production || truthy(env.ADMIN_RESET),
    accounts: [{ name: String(env.ADMIN_NAME || "Super Admin").trim() || "Super Admin", email, password, mustChangePassword: production || !given, generated: !given }],
  };
}

module.exports = { planSeed, weakReason, generatePassword, DEV_ADMINS, KNOWN_WEAK, MIN_LENGTH };
