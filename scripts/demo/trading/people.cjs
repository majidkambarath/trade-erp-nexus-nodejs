// Phase "people": Fatima (accountant), Ravi (sales) and an auditor (viewer), signed in as themselves
// later. An administrator who adds someone makes them change their password at first sign-in
// (mustChangePassword); a demo login has to work the first time, so that one flag is cleared here,
// directly, for these three accounts only.
const { client, rec, listOf, must } = require("./lib.cjs");

async function people(ctx, PEOPLE, mongoose) {
  const { api, log, DEMO_PASSWORD } = ctx;
  const have = listOf(await api("GET", "/access/users"));
  for (const p of PEOPLE) {
    if (!have.find((u) => String(u.email).toLowerCase() === p.email)) {
      must(await api("POST", "/access/users", { name: p.name, email: p.email, password: DEMO_PASSWORD, role: p.role }), `person ${p.name}`);
    }
  }
  await mongoose.connection.db.collection("admins").updateMany(
    { companyId: ctx.org.code, email: { $in: PEOPLE.map((p) => p.email) } },
    { $set: { mustChangePassword: false } }
  );
  for (const p of PEOPLE) ctx.peopleApis[p.role] = client(p.email, DEMO_PASSWORD);
  const users = listOf(await api("GET", "/access/users"));
  ctx.userIds = Object.fromEntries(PEOPLE.map((p) => [p.role, String(users.find((u) => String(u.email).toLowerCase() === p.email)?.id || users.find((u) => String(u.email).toLowerCase() === p.email)?._id)]));
  log(`people: ${PEOPLE.map((p) => `${p.name} (${p.role})`).join(", ")}; password ${DEMO_PASSWORD}`);
}

module.exports = { people };
