const catchAsync = require("../../utils/catchAsync");
const UserService = require("../../services/core/userService");
const RoleService = require("../../services/core/roleService");
const AuditService = require("../../services/core/auditService");

// Thin: each handler asks one service and answers { success, data }. Who may do what is decided by the route's permission
// and, for a person or a role, by rank inside the service.
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

exports.users = catchAsync(async (req, res) => ok(res, await UserService.list(req.query)));

exports.createUser = catchAsync(async (req, res) => {
  const user = await UserService.create(req.body || {}, req);
  await AuditService.log({ req, action: "USER_CREATED", entity: "Admin", entityId: user.id, summary: `${user.email} added as ${user.role.name || user.role.key}` });
  ok(res, user, 201);
});

exports.updateUser = catchAsync(async (req, res) => {
  const user = await UserService.update(req.params.id, req.body || {}, req);
  const what = Object.keys(req.body || {}).map((k) => (k === "password" ? "password reset" : k)).join(", ");
  await AuditService.log({ req, action: "USER_UPDATED", entity: "Admin", entityId: user.id, summary: `${user.email} changed: ${what}` });
  ok(res, user);
});

exports.resetTwoFactor = catchAsync(async (req, res) => {
  const user = await UserService.resetTwoFactor(req.params.id, req);
  await AuditService.log({ req, action: "TWO_FACTOR_RESET_BY_ADMIN", entity: "Admin", entityId: user.id, summary: `${user.email}'s two-factor sign-in was reset by ${req.admin.email}; their sign-ins were ended` });
  ok(res, user);
});

exports.roles = catchAsync(async (req, res) => ok(res, await RoleService.list()));

exports.createRole = catchAsync(async (req, res) => {
  const role = await RoleService.create(req.body || {}, req);
  await AuditService.log({ req, action: "ROLE_CREATED", entity: "Role", entityId: role.key, summary: `Role "${role.name}" created` });
  ok(res, role, 201);
});

exports.updateRole = catchAsync(async (req, res) => {
  const role = await RoleService.update(req.params.key, req.body || {}, req);
  await AuditService.log({ req, action: "ROLE_UPDATED", entity: "Role", entityId: role.key, summary: `Role "${role.name}" changed: ${Object.keys(req.body || {}).join(", ")}` });
  ok(res, role);
});

exports.removeRole = catchAsync(async (req, res) => {
  const out = await RoleService.remove(req.params.key, req);
  await AuditService.log({ req, action: "ROLE_REMOVED", entity: "Role", entityId: out.key, summary: `Role "${out.key}" removed` });
  ok(res, out);
});
