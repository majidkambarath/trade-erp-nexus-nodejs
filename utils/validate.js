const { validationResult } = require("express-validator");
const AppError = require("../utils/AppError");

module.exports = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map((validation) => validation.run(req)));

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return next(new AppError("Validation Failed", 400));
    }
    next();
  };
};
