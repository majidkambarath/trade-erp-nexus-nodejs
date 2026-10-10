// Loaded INTO the server process (node --require) by the mass-assignment sweep. It watches the built-in prototypes and prints a
// line the moment anything is added to one of them: that is what prototype pollution looks like from inside. The test reads the
// server's output at the end. The baseline is taken only when the test arms it (by creating the file named in PROBE_ARM_FILE),
// after start-up, so a library that legitimately extends a prototype while loading is not mistaken for an attack.
const fs = require("fs");
const watched = { "Object.prototype": Object.prototype, "Array.prototype": Array.prototype, "Function.prototype": Function.prototype, "String.prototype": String.prototype, "Number.prototype": Number.prototype, "Boolean.prototype": Boolean.prototype };
let baseline = null;
const names = (p) => [...Object.getOwnPropertyNames(p), ...Object.getOwnPropertySymbols(p).map(String)];
const check = () => {
  if (!baseline) {
    if (process.env.PROBE_ARM_FILE && fs.existsSync(process.env.PROBE_ARM_FILE)) {
      baseline = Object.fromEntries(Object.entries(watched).map(([k, p]) => [k, new Set(names(p))]));
      process.stdout.write("[pollution-probe] armed\n");
    }
    return;
  }
  for (const [k, p] of Object.entries(watched)) {
    const extra = names(p).filter((n) => !baseline[k].has(n));
    if (extra.length) { process.stdout.write(`[pollution-probe] POLLUTED ${k}: ${extra.join(",")}\n`); extra.forEach((n) => baseline[k].add(n)); }
  }
  // the most direct sign of all: a plain object that has a property nobody gave it
  const fresh = {};
  for (const k in fresh) { process.stdout.write(`[pollution-probe] POLLUTED enumerable key on every object: ${k}\n`); break; }
};
setInterval(check, 50).unref();
process.stdout.write("[pollution-probe] watching\n");
