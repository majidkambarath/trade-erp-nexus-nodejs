const catchAsync = require("../../utils/catchAsync");
const StaffService = require("../../services/staff/staffService");
const AppError = require("../../utils/AppError");
const { uploadFields } = require("../../middleware/upload");

exports.createStaff = catchAsync(async (req, res, next) => {
  const upload = uploadFields([
    { name: "idProof", maxCount: 1 },
    { name: "addressProof", maxCount: 1 },
  ]);

  upload(req, res, async (err) => {
    if (err) return next(err);

    try {
      const createdBy = req.user?.id || req.body.createdBy || "system";
      const staff = await StaffService.createStaff(
        req.body,
        req.files,
        createdBy
      );

      res.status(201).json({
        status: "success",
        data: {
          staff,
        },
      });
    } catch (error) {
      next(error);
    }
  });
});

exports.getAllStaff = catchAsync(async (req, res) => {
  const staff = await StaffService.getAllStaff(req.query);

  res.status(200).json({
    status: "success",
    results: staff.length,
    data: {
      staff,
    },
  });
});

exports.getStaffById = catchAsync(async (req, res) => {
  const staff = await StaffService.getStaffById(req.params.id);

  res.status(200).json({
    status: "success",
    data: {
      staff,
    },
  });
});

exports.getStaffByStaffId = catchAsync(async (req, res) => {
  const staff = await StaffService.getStaffByStaffId(req.params.staffId);

  res.status(200).json({
    status: "success",
    data: {
      staff,
    },
  });
});

exports.updateStaff = catchAsync(async (req, res, next) => {
  const upload = uploadFields([
    { name: "idProof", maxCount: 1 },
    { name: "addressProof", maxCount: 1 },
  ]);

  upload(req, res, async (err) => {
    if (err) return next(err);

    try {
      const createdBy = req.user?.id || req.body.createdBy || "system";
      const staff = await StaffService.updateStaff(
        req.params.id,
        req.body,
        req.files,
        createdBy
      );

      res.status(200).json({
        status: "success",
        data: {
          staff,
        },
      });
    } catch (error) {
      next(error);
    }
  });
});

exports.deleteStaff = catchAsync(async (req, res) => {
  await StaffService.deleteStaff(req.params.id);

  res.status(204).json({
    status: "success",
    data: null,
  });
});

exports.getStaffStats = catchAsync(async (req, res) => {
  const stats = await StaffService.getStaffStats();

  res.status(200).json({
    status: "success",
    data: {
      stats,
    },
  });
});
