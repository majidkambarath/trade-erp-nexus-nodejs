// `npm run seed` made a super administrator with a password written in the source, and put it back on every run. Fine on a laptop;
// in production it is a way in for anyone who has read the repository. These tests pin the line between the two, and prove the
// script itself refuses (as a real process, before it connects to anything), not just the planning function.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { planSeed, weakReason, generatePassword, DEV_ADMINS } = require("../seedPlan");

const production = (extra = {}) => ({ NODE_ENV: "production", ...extra });

test("development and test: exactly the two accounts the tests rely on, with the known password, re-applied on every run", () => {
  for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }]) {
    const plan = planSeed(env);
    assert.equal(plan.production, false);
    assert.equal(plan.replaceExisting, true);
    assert.deepEqual(plan.accounts.map((a) => [a.email, a.password, a.mustChangePassword]), [["admin@test.com", "12312312", false], ["admin@test.uae", "12312312", false]]);
  }
  assert.deepEqual(DEV_ADMINS.map((a) => a.email), ["admin@test.com", "admin@test.uae"]);
});

test("production with nothing set refuses: it never creates the built-in accounts", () => {
  assert.throws(() => planSeed(production()), /ADMIN_EMAIL/);
  assert.throws(() => planSeed({ RENDER: "true" }), /ADMIN_EMAIL/, "Render counts as production even when NODE_ENV was forgotten");
});

test("production refuses the old default and every weak password, whoever types it", () => {
  for (const password of ["12312312", "password", "Password1", "short1A", "aaaaaaaaaaaaaaaa", "onlyletterslong", "123456789012"]) {
    assert.throws(() => planSeed(production({ ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: password })), /ADMIN_PASSWORD refused/, password);
  }
  assert.equal(weakReason("12312312") !== null, true);
  assert.equal(weakReason("A-long-passphrase-4-me"), null);
});

test("production takes the account from the environment and makes the person choose their own password", () => {
  const plan = planSeed(production({ ADMIN_EMAIL: " Owner@Example.com ", ADMIN_PASSWORD: "A-long-passphrase-4-me", ADMIN_NAME: "Nadia" }));
  assert.equal(plan.production, true);
  assert.deepEqual(plan.accounts, [{ name: "Nadia", email: "owner@example.com", password: "A-long-passphrase-4-me", mustChangePassword: true, generated: false }]);
});

test("production with no password generates a strong one, once, and marks it to be replaced at the first sign-in", () => {
  const a = planSeed(production({ ADMIN_EMAIL: "owner@example.com" })).accounts[0];
  const b = planSeed(production({ ADMIN_EMAIL: "owner@example.com" })).accounts[0];
  assert.equal(a.generated, true);
  assert.equal(a.mustChangePassword, true);
  assert.equal(weakReason(a.password), null, "it passes the same strength test");
  assert.ok(a.password.length >= 24);
  assert.notEqual(a.password, b.password);
  assert.equal(weakReason(generatePassword()), null);
});

test("production leaves an existing account alone unless ADMIN_RESET says otherwise", () => {
  const env = production({ ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "A-long-passphrase-4-me" });
  assert.equal(planSeed(env).replaceExisting, false);
  assert.equal(planSeed({ ...env, ADMIN_RESET: "1" }).replaceExisting, true);
  assert.equal(planSeed({ ...env, ADMIN_RESET: "no" }).replaceExisting, false);
});

test("a malformed address, or a password without an address, is refused anywhere", () => {
  assert.throws(() => planSeed({ ADMIN_EMAIL: "not an email" }), /does not look like an email/);
  assert.throws(() => planSeed({ ADMIN_PASSWORD: "whatever-i-like-1" }), /ADMIN_EMAIL/);
});

test("development with an address of its own: that account, not the built-in ones, and its password is honoured", () => {
  const plan = planSeed({ ADMIN_EMAIL: "me@dev.test", ADMIN_PASSWORD: "dev-pass-1" });
  assert.deepEqual(plan.accounts.map((a) => [a.email, a.password, a.mustChangePassword]), [["me@dev.test", "dev-pass-1", false]]);
  assert.equal(plan.replaceExisting, true);
  assert.equal(planSeed({ ADMIN_EMAIL: "me@dev.test" }).accounts[0].mustChangePassword, true, "a generated password is always replaced at the first sign-in");
});

test("the real script, run as production with the old default, exits non-zero and never reaches the database", () => {
  const root = path.resolve(__dirname, "..", "..");
  const run = (env) => spawnSync(process.execPath, ["utils/setup.js"], {
    cwd: root, encoding: "utf8", timeout: 30000,
    // a database that cannot be reached: if the script tried, it would hang or fail differently, and the output below would show it
    env: { ...process.env, MONGO_URI: "mongodb://127.0.0.1:1/never-connect?serverSelectionTimeoutMS=500", ...env },
  });
  for (const env of [
    { NODE_ENV: "production", ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "12312312" },
    { NODE_ENV: "production", ADMIN_EMAIL: "", ADMIN_PASSWORD: "" },
    { RENDER: "true", NODE_ENV: "", ADMIN_EMAIL: "owner@example.com", ADMIN_PASSWORD: "12312312" },
  ]) {
    const result = run(env);
    assert.equal(result.status, 1, `exit status for ${JSON.stringify(env)}: ${result.stderr}`);
    assert.match(result.stderr, /seed refused/);
    assert.ok(!/MongoDB connected|connection error/.test(result.stdout + result.stderr), "it refused before connecting");
  }
});
