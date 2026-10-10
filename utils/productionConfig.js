// What the server insists on before it will run in production, and the one place the sign-in signing key is read.
//
// The key used to be `process.env.JWT_SECRET || "your-secret-key"`: a deployment that forgot the variable would have signed every
// token with a string that is in this repository, and anyone who read it could mint a token for any account of any organisation.
// Away from production the fallback is still there (a developer's laptop, the unit tests), with a warning; in production a missing
// or weak key stops the server from starting at all. (On Render a deploy that fails to start leaves the old one running.)
const DEV_FALLBACK = "your-secret-key";
const MIN_SECRET_LENGTH = 32;
const WEAK = new Set([DEV_FALLBACK, "secret", "changeme", "change-me", "password", "jwt-secret", "jwtsecret", "supersecret", "mysecret", "test", "12345678", "your-secret", "secret-key"]);

const isProduction = (env = process.env) => env.NODE_ENV === "production";

// Is this a key worth signing with? -> a reason, or null.
function weakness(secret) {
  const s = String(secret ?? "");
  if (!s) return "is not set";
  if (WEAK.has(s.toLowerCase())) return "is a well-known placeholder";
  if (s.length < MIN_SECRET_LENGTH) return `is shorter than ${MIN_SECRET_LENGTH} characters`;
  if (new Set(s).size < 8) return "has almost no variety (use random characters)";
  return null;
}

let warned = false;
// The key sign-in tokens are signed with. Read on every call (cheap), so a test that sets the variable late is honoured.
function jwtSecret(env = process.env) {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (isProduction(env)) throw new Error("JWT_SECRET is not set");
  if (!warned && env.NODE_ENV !== "test") {
    warned = true;
    console.warn("[security] JWT_SECRET is not set: using a development key. Never run like this in production.");
  }
  return DEV_FALLBACK;
}

// Everything wrong with the environment of a PRODUCTION server -> { fatal: [], warnings: [] }. Pure: takes the environment as an argument.
function configProblems(env = process.env) {
  const fatal = [];
  const warnings = [];
  if (!isProduction(env)) return { fatal, warnings };
  const bad = weakness(env.JWT_SECRET);
  if (bad) fatal.push(`JWT_SECRET ${bad}. Set it to at least ${MIN_SECRET_LENGTH} random characters (for example: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))").`);
  if (env.PLATFORM_JWT_SECRET) {
    const platform = weakness(env.PLATFORM_JWT_SECRET);
    if (platform) fatal.push(`PLATFORM_JWT_SECRET ${platform}.`);
    else if (env.PLATFORM_JWT_SECRET === env.JWT_SECRET) fatal.push("PLATFORM_JWT_SECRET must differ from JWT_SECRET: the developer console and the customers must not share a key.");
  }
  if (!env.MONGO_URI) fatal.push("MONGO_URI is not set.");
  if (!env.SECRET_BOX_KEY && !env.EINVOICE_SECRET_KEY) warnings.push("SECRET_BOX_KEY is not set: stored provider keys, two-factor secrets and recovery codes are protected with a key derived from JWT_SECRET, so rotating JWT_SECRET would make them unreadable.");
  if (!env.PUBLIC_APP_URL) warnings.push("PUBLIC_APP_URL is not set: reset links and customer document links point at the default frontend address.");
  if (!env.PLATFORM_JWT_SECRET) warnings.push("PLATFORM_JWT_SECRET is not set: the developer console's key is derived from JWT_SECRET.");
  return { fatal, warnings };
}

// Called once, first thing, by server.js. Prints the warnings; refuses to go on when something is fatal.
function assertProductionConfig(env = process.env, { exit = (code) => process.exit(code), log = console } = {}) {
  const { fatal, warnings } = configProblems(env);
  for (const w of warnings) log.warn(`[security] ${w}`);
  if (fatal.length) {
    for (const f of fatal) log.error(`[security] REFUSING TO START: ${f}`);
    exit(1);
  }
  return { fatal, warnings };
}

module.exports = { DEV_FALLBACK, MIN_SECRET_LENGTH, weakness, jwtSecret, configProblems, assertProductionConfig, isProduction };
