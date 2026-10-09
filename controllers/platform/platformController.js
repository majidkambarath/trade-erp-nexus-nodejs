// Thin: each handler calls one service method and answers { success, data }. The work, and the audit record of
// it, is in services/platform/*.
const catchAsync = require("../../utils/catchAsync");
const Auth = require("../../services/platform/platformAuthService");
const Orgs = require("../../services/platform/platformOrganisationService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const ctx = (req) => ({ by: req.platformUser, ip: req.ip });

exports.login = catchAsync(async (req, res) => ok(res, await Auth.login(req.body?.email, req.body?.password)));
exports.me = catchAsync(async (req, res) => ok(res, req.platformUser.toJSON()));
exports.catalog = catchAsync(async (_req, res) => ok(res, Orgs.catalog()));

// the platform's own people
exports.users = catchAsync(async (_req, res) => ok(res, await Auth.list()));
exports.createUser = catchAsync(async (req, res) => {
  const user = await Auth.create(req.body || {});
  await Orgs.record({ ...ctx(req), action: "PLATFORM_USER_CREATED", summary: `Platform account created for ${user.email}` });
  ok(res, user.toJSON(), 201);
});
exports.updateUser = catchAsync(async (req, res) => {
  const user = await Auth.update(req.params.id, req.body || {}, req.platformUser._id);
  await Orgs.record({ ...ctx(req), action: "PLATFORM_USER_UPDATED", summary: `Platform account ${user.email} changed: ${Object.keys(req.body || {}).map((k) => (k === "password" ? "password reset" : k)).join(", ")}` });
  ok(res, user.toJSON());
});

// organisations
exports.list = catchAsync(async (req, res) => ok(res, await Orgs.list({ status: req.query.status, search: req.query.search, page: Number(req.query.page) || 1, limit: Math.min(Number(req.query.limit) || 25, 100) })));
exports.create = catchAsync(async (req, res) => ok(res, await Orgs.create(req.body || {}, ctx(req)), 201));
exports.detail = catchAsync(async (req, res) => ok(res, await Orgs.detail(req.params.code)));
exports.update = catchAsync(async (req, res) => ok(res, await Orgs.update(req.params.code, req.body || {}, ctx(req))));
exports.extend = catchAsync(async (req, res) => ok(res, await Orgs.extend(req.params.code, req.body || {}, ctx(req))));
exports.status = catchAsync(async (req, res) => ok(res, await Orgs.setStatus(req.params.code, req.body?.status, ctx(req))));
exports.provision = catchAsync(async (req, res) => ok(res, await Orgs.provision(req.params.code, ctx(req))));
exports.profile = catchAsync(async (req, res) => ok(res, await Orgs.updateCompanyProfile(req.params.code, req.body || {}, ctx(req))));

// an organisation's people and branches
exports.orgUsers = catchAsync(async (req, res) => ok(res, await Orgs.listUsers(req.params.code)));
exports.orgRoles = catchAsync(async (req, res) => ok(res, await Orgs.listRoles(req.params.code)));
exports.orgCreateUser = catchAsync(async (req, res) => {
  const user = await Orgs.createUser(req.params.code, req.body || {}, ctx(req));
  ok(res, { id: user._id, name: user.name, email: user.email, type: user.type, role: user.roleKey || user.type, status: user.status }, 201);
});
exports.orgUpdateUser = catchAsync(async (req, res) => {
  const user = await Orgs.updateUser(req.params.code, req.params.id, req.body || {}, ctx(req));
  ok(res, { id: user._id, name: user.name, email: user.email, type: user.type, role: user.roleKey || user.type, status: user.status });
});
exports.branches = catchAsync(async (req, res) => ok(res, await Orgs.listBranches(req.params.code)));
exports.createBranch = catchAsync(async (req, res) => ok(res, await Orgs.createBranch(req.params.code, req.body || {}, ctx(req)), 201));
exports.updateBranch = catchAsync(async (req, res) => ok(res, await Orgs.updateBranch(req.params.code, req.params.branch, req.body || {}, ctx(req))));

exports.audit = catchAsync(async (req, res) => ok(res, await Orgs.auditLog({ organisation: req.query.organisation, page: req.query.page, limit: req.query.limit })));
