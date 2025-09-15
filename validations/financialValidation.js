// middleware/financialValidation.js
const { body, validationResult } = require('express-validator');
const AppError = require('../utils/AppError');

// Validation middleware for voucher creation
exports.validateVoucherCreation = [
  body('voucherType')
    .isIn(['receipt', 'payment', 'journal', 'contra', 'expense'])
    .withMessage('Invalid voucher type'),
  
  body('totalAmount')
    .isNumeric()
    .isFloat({ min: 0.01 })
    .withMessage('Total amount must be greater than 0'),
  
  body('date')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  
  // Receipt voucher validations
  body('customerId')
    .if(body('voucherType').equals('receipt'))
    .notEmpty()
    .withMessage('Customer is required for receipt voucher'),
  
  body('paymentMode')
    .if(body('voucherType').equals('receipt'))
    .isIn(['cash', 'bank', 'cheque', 'online'])
    .withMessage('Invalid payment mode'),
  
  // Payment voucher validations
  body('vendorId')
    .if(body('voucherType').equals('payment'))
    .notEmpty()
    .withMessage('Vendor is required for payment voucher'),
  
  // Journal voucher validations
  body('entries')
    .if(body('voucherType').equals('journal'))
    .isArray({ min: 2 })
    .withMessage('Journal voucher must have at least 2 entries'),
  
  body('entries.*.accountId')
    .if(body('voucherType').equals('journal'))
    .notEmpty()
    .withMessage('Account ID is required for each entry'),
  
  body('entries.*.debitAmount')
    .if(body('voucherType').equals('journal'))
    .optional()
    .isNumeric()
    .withMessage('Debit amount must be numeric'),
  
  body('entries.*.creditAmount')
    .if(body('voucherType').equals('journal'))
    .optional()
    .isNumeric()
    .withMessage('Credit amount must be numeric'),
  
  // Contra voucher validations
  body('fromAccountId')
    .if(body('voucherType').equals('contra'))
    .notEmpty()
    .withMessage('From account is required for contra voucher'),
  
  body('toAccountId')
    .if(body('voucherType').equals('contra'))
    .notEmpty()
    .withMessage('To account is required for contra voucher'),
  
  // Expense voucher validations
  body('expenseCategoryId')
    .if(body('voucherType').equals('expense'))
    .notEmpty()
    .withMessage('Expense category is required for expense voucher'),
  
  body('description')
    .if(body('voucherType').equals('expense'))
    .notEmpty()
    .withMessage('Description is required for expense voucher'),

  // Validation result handler
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const errorMessages = errors.array().map(error => error.msg);
      return next(new AppError(`Validation errors: ${errorMessages.join(', ')}`, 400));
    }
    next();
  }
];

// Validation middleware for voucher updates
exports.validateVoucherUpdate = [
  body('totalAmount')
    .optional()
    .isNumeric()
    .isFloat({ min: 0.01 })
    .withMessage('Total amount must be greater than 0'),
  
  body('date')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  
  body('status')
    .optional()
    .isIn(['draft', 'pending', 'approved', 'rejected', 'cancelled'])
    .withMessage('Invalid status'),

  // Validation result handler
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const errorMessages = errors.array().map(error => error.msg);
      return next(new AppError(`Validation errors: ${errorMessages.join(', ')}`, 400));
    }
    next();
  }
];