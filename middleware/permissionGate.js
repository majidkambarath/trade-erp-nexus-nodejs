// The fourth gate on a route. In order, a request meets: authenticateToken (who are you, and is your organisation
// allowed in), requireFeature (does its plan include this), and then this - may THIS person, in THIS role, do it.
//
//   router.patch("/:id/approve", requirePermission("finance.approve"), controller.approve);
//   router.get("/customers",     requirePermission(["sales.view", "lookups.view"]), controller.list);   // any one of
//   router.post("/",             requirePermission(byDocumentType("create")), controller.create);       // decided per request
//
// The answer is always the server's: what the screens hide is a courtesy, and this is the lock. Every route must
// carry one of these, or say plainly that it needs none (signedIn, publicRoute): a guard test walks the routers and
// fails on any that does neither, so a new route cannot quietly ship open.
const AppError = require("../utils/AppError");
const roles = require("../utils/permissions");
const AuditService = require("../services/core/auditService");

const asList = (need) => (Array.isArray(need) ? need : [need]).filter(Boolean);

function denied(req, wanted) {
  const role = req.admin?.role;
  const who = role?.name || role?.key || "Your role";
  const message = role?.active === false
    ? "Your role has been switched off, so you cannot do this. Please contact your administrator."
    : `${who === "Your role" ? who : `Your role (${who})`} does not allow this. Ask your administrator if you need it.`;
  // Said once, in the organisation's own trail, so an administrator can see who keeps hitting a wall. Never waited for:
  // a failure to write the note must not change the answer.
  AuditService.log({ req, action: "PERMISSION_DENIED", entity: "Route", summary: `${req.method} ${req.baseUrl || ""}${req.path} needs ${wanted.join(" or ")}` });
  return new AppError(message, 403, "PERMISSION_DENIED", { required: wanted, role: role?.key || null });
}

/**
 * Require ANY ONE of the permissions. `need` is a key, a list of keys, or a function of the request (sync or async) that
 * returns one of those, for the routes whose answer depends on what is being touched. A guard that names nothing refuses.
 */
function requirePermission(need) {
  const gate = async (req, res, next) => {
    try {
      if (!req.admin) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
      const wanted = asList(typeof need === "function" ? await need(req) : need);
      if (!roles.canAny(req.admin.grants, wanted)) throw denied(req, wanted.length ? wanted : ["(nothing named)"]);
      return next();
    } catch (error) {
      return next(error);
    }
  };
  gate.permission = need; // read by the guard test
  return gate;
}

/**
 * For the rare handler that learns, only once it has read the record, that the request needs MORE than the route asked
 * (editing an item is one permission; editing it so that its quantity on hand changes is another). Throws the same 403.
 */
function assertPermission(req, key) {
  if (!req.admin) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
  if (!roles.can(req.admin.grants, key)) throw denied(req, [key]);
}

/** A person's own record, or - for anyone else's - the permission. */
function selfOr(need) {
  const inner = requirePermission(need);
  const gate = (req, res, next) => (req.admin && String(req.params.id) === String(req.admin.id) ? next() : inner(req, res, next));
  gate.permission = need;
  gate.selfService = "a person may always read their own record";
  return gate;
}

/** The route needs a signed-in person and nothing more, and says why (their own profile, the status that tells them what they may do). */
function signedIn(reason) {
  if (!reason) throw new Error("signedIn() must say why this route needs no permission");
  const gate = (req, res, next) => (req.admin ? next() : next(new AppError("Authentication required", 401, "AUTH_REQUIRED")));
  gate.selfService = reason;
  return gate;
}

/** The route needs no sign-in at all (sign-in itself, a customer's link, a signed webhook), and says why. */
function publicRoute(reason) {
  if (!reason) throw new Error("publicRoute() must say why this route is open");
  const gate = (req, res, next) => next();
  gate.public = reason;
  return gate;
}

// ---- trade documents: one router, four types

const typeCache = new WeakMap();

/** The type of the trade document a request names by id, looked up once. Undefined when there is none or it is not found. */
async function typeOfStored(req) {
  if (!req.params?.id) return undefined;
  if (typeCache.has(req)) return typeCache.get(req);
  const Transaction = require("../models/modules/transactionModel");
  const found = await Transaction.findById(req.params.id).select("type").lean().catch(() => null);
  typeCache.set(req, found?.type);
  return found?.type;
}

/**
 * The permission for `action` on a trade document, by its type: sales_order and sales_return answer to sales.<action>,
 * the purchase ones to purchase.<action>. A document already stored is judged by its STORED type, never by what the
 * request body claims, so nobody can edit a sales order by calling it a purchase order. A create is judged by the body;
 * when the type cannot be told (a list with no filter) either module's permission passes, and the list itself is then
 * narrowed to the types the person may see.
 */
const byDocumentType = (action) => async (req) => {
  const stored = await typeOfStored(req);
  const type = stored ?? req.body?.type ?? (Array.isArray(req.query?.type) ? undefined : req.query?.type);
  if (type) return `${roles.moduleOfType(type)}.${action}`;
  return [`sales.${action}`, `purchase.${action}`];
};

module.exports = { requirePermission, assertPermission, selfOr, signedIn, publicRoute, byDocumentType };
