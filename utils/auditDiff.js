// What changed between two versions of a record, field by field, for the audit log. Pure: no database.
//
// A field is a dotted path ("vat.trn", "credit.days"); an array is compared whole, at its own path, because an
// element-by-element diff of a list of contacts or lines reads worse than "was this, is now that". Values are shown as an
// auditor would read them: an id as its hex string, a date as ISO, long text cut. Secrets are never written: a field whose
// name looks like one is reported as changed, with neither value.

const SENSITIVE = /(password|passwd|secret|token|apikey|api_key|passenc|keyenc|enc$|otp|recovery)/i;
const ALWAYS_IGNORED = new Set(["_id", "__v", "updatedAt", "createdAt", "companyId"]);
const MAX_DEPTH = 4;
const MAX_TEXT = 300;
const MAX_CHANGES = 100;

const isId = (v) => v && typeof v === "object" && typeof v.toHexString === "function";
const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !isId(v) && !Buffer.isBuffer(v);

/** A value as the log keeps it. */
function shown(v) {
  if (v === undefined || v === null) return null;
  if (isId(v)) return v.toHexString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return "[binary]";
  if (typeof v === "string") return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  if (typeof v === "object") {
    const text = JSON.stringify(v, (_k, x) => (isId(x) ? x.toHexString() : x));
    return text && text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text ? JSON.parse(text) : null;
  }
  return v;
}

/** The record as dotted paths -> comparable value (objects nested up to MAX_DEPTH, arrays whole). */
function flatten(value, prefix = "", depth = 0, out = new Map()) {
  if (!isPlain(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (!prefix && ALWAYS_IGNORED.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlain(v) && depth < MAX_DEPTH && Object.keys(v).length) flatten(v, path, depth + 1, out);
    else out.set(path, v);
  }
  return out;
}

const key = (v) => {
  const s = shown(v);
  return s === null || s === undefined || s === "" ? "" : JSON.stringify(s);
};

/** Whether `path` is, or lies under, one of `ignore`. */
const ignored = (path, ignore) => ignore.some((p) => path === p || path.startsWith(`${p}.`));

/**
 * The changes from `before` to `after` -> [{ field, from, to }], at most 100, in a stable order. A record created has no
 * `before`; one deleted has no `after`. `ignore` lists fields (and their children) never reported.
 */
function changes(before, after, { ignore = [] } = {}) {
  const a = flatten(before && typeof before.toObject === "function" ? before.toObject() : before);
  const b = flatten(after && typeof after.toObject === "function" ? after.toObject() : after);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out = [];
  for (const path of paths) {
    if (ignored(path, ignore)) continue;
    const from = a.get(path);
    const to = b.get(path);
    if (key(from) === key(to)) continue;
    if (SENSITIVE.test(path.split(".").pop())) out.push({ field: path, from: "[hidden]", to: "[hidden]" });
    else out.push({ field: path, from: shown(from), to: shown(to) });
    if (out.length >= MAX_CHANGES) break;
  }
  return out;
}

/** The top-level fields an update document writes ({ $set: { "vat.trn": … } } -> ["vat.trn"]); a pipeline counts its $set stages. */
function updatedPaths(update) {
  if (!update) return [];
  const stages = Array.isArray(update) ? update : [update];
  const paths = [];
  for (const stage of stages) {
    for (const [k, v] of Object.entries(stage || {})) {
      if (k.startsWith("$")) {
        if (v && typeof v === "object" && !Array.isArray(v)) paths.push(...Object.keys(v));
      } else paths.push(k);
    }
  }
  return paths;
}

module.exports = { changes, updatedPaths, ignored, shown, SENSITIVE };
