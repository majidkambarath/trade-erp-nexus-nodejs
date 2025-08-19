const { body, param, query, validationResult } = require('express-validator');
const AppError = require("../utils/AppError");

// Validation result handler
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(error => ({
      field: error.param,
      message: error.msg,
      value: error.value
    }));
    
    return next(new AppError('Validation failed', 400, 'VALIDATION_ERROR', errorMessages));
  }
  next();
};

// Admin creation validation
const validateCreateAdmin = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2-50 characters'),
  
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  
  body('type')
    .optional()
    .isIn(['super_admin', 'admin', 'manager', 'operator', 'viewer'])
    .withMessage('Invalid admin type'),
  
  // Company info validation
  body('companyInfo.companyName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Company name cannot exceed 100 characters'),
  
  body('companyInfo.addressLine1')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Address line 1 cannot exceed 100 characters'),
  
  body('companyInfo.addressLine2')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Address line 2 cannot exceed 100 characters'),
  
  body('companyInfo.city')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('City cannot exceed 50 characters'),
  
  body('companyInfo.state')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('State/Province cannot exceed 50 characters'),
  
  body('companyInfo.country')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Country cannot exceed 50 characters'),
  
  body('companyInfo.postalCode')
    .optional()
    .trim()
    .isLength({ max: 20 })
    .withMessage('Postal code cannot exceed 20 characters'),
  
  body('companyInfo.phoneNumber')
    .optional()
    .trim()
    .isMobilePhone()
    .withMessage('Please provide a valid phone number'),
  
  body('companyInfo.emailAddress')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid company email'),
  
  body('companyInfo.website')
    .optional()
    .trim()
    .isURL()
    .withMessage('Please provide a valid website URL'),
  
  // Bank details validation
  body('companyInfo.bankDetails.bankName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Bank name cannot exceed 100 characters'),
  
  body('companyInfo.bankDetails.accountNumber')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Account number cannot exceed 50 characters'),
  
  body('companyInfo.bankDetails.accountName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Account name cannot exceed 100 characters'),
  
  body('companyInfo.bankDetails.ibanNumber')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('IBAN number cannot exceed 50 characters'),
  
  body('companyInfo.bankDetails.currency')
    .optional()
    .trim()
    .isLength({ max: 10 })
    .withMessage('Currency cannot exceed 10 characters'),
  
  handleValidationErrors
];

// Admin update validation
const validateUpdateAdmin = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2-50 characters'),
  
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  
  body('type')
    .optional()
    .isIn(['super_admin', 'admin', 'manager', 'operator', 'viewer'])
    .withMessage('Invalid admin type'),
  
  body('status')
    .optional()
    .isIn(['active', 'inactive', 'suspended'])
    .withMessage('Status must be active, inactive, or suspended'),
  
  // Company info validation (same as create but all optional)
  body('companyInfo.companyName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Company name cannot exceed 100 characters'),
  
  body('companyInfo.addressLine1')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Address line 1 cannot exceed 100 characters'),
  
  body('companyInfo.addressLine2')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Address line 2 cannot exceed 100 characters'),
  
  body('companyInfo.city')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('City cannot exceed 50 characters'),
  
  body('companyInfo.state')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('State/Province cannot exceed 50 characters'),
  
  body('companyInfo.country')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Country cannot exceed 50 characters'),
  
  body('companyInfo.postalCode')
    .optional()
    .trim()
    .isLength({ max: 20 })
    .withMessage('Postal code cannot exceed 20 characters'),
  
  body('companyInfo.phoneNumber')
    .optional()
    .trim()
    .isMobilePhone()
    .withMessage('Please provide a valid phone number'),
  
  body('companyInfo.emailAddress')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid company email'),
  
  body('companyInfo.website')
    .optional()
    .trim()
    .isURL()
    .withMessage('Please provide a valid website URL'),
  
  // Bank details validation
  body('companyInfo.bankDetails.bankName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Bank name cannot exceed 100 characters'),
  
  body('companyInfo.bankDetails.accountNumber')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Account number cannot exceed 50 characters'),
  
  body('companyInfo.bankDetails.accountName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Account name cannot exceed 100 characters'),
  
  body('companyInfo.bankDetails.ibanNumber')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('IBAN number cannot exceed 50 characters'),
  
  body('companyInfo.bankDetails.currency')
    .optional()
    .trim()
    .isLength({ max: 10 })
    .withMessage('Currency cannot exceed 10 characters'),
  
  handleValidationErrors
];

// Profile update validation (restricted fields)
const validateProfileUpdate = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2-50 characters'),
  
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  
  // Restrict sensitive fields
  body('type').isEmpty().withMessage('Cannot update admin type'),
  body('permissions').isEmpty().withMessage('Cannot update permissions'),
  body('status').isEmpty().withMessage('Cannot update status'),
  body('isActive').isEmpty().withMessage('Cannot update active status'),
  
  // Company info validation (same as update)
  body('companyInfo.companyName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Company name cannot exceed 100 characters'),
  
  body('companyInfo.addressLine1')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Address line 1 cannot exceed 100 characters'),
  
  body('companyInfo.addressLine2')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Address line 2 cannot exceed 100 characters'),
  
  body('companyInfo.city')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('City cannot exceed 50 characters'),
  
  body('companyInfo.state')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('State/Province cannot exceed 50 characters'),
  
  body('companyInfo.country')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Country cannot exceed 50 characters'),
  
  body('companyInfo.postalCode')
    .optional()
    .trim()
    .isLength({ max: 20 })
    .withMessage('Postal code cannot exceed 20 characters'),
  
  body('companyInfo.phoneNumber')
    .optional()
    .trim()
    .isMobilePhone()
    .withMessage('Please provide a valid phone number'),
  
  body('companyInfo.emailAddress')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid company email'),
  
  body('companyInfo.website')
    .optional()
    .trim()
    .isURL()
    .withMessage('Please provide a valid website URL'),
  
  // Bank details validation
  body('companyInfo.bankDetails.bankName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Bank name cannot exceed 100 characters'),
  
  body('companyInfo.bankDetails.accountNumber')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Account number cannot exceed 50 characters'),
  
  body('companyInfo.bankDetails.accountName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Account name cannot exceed 100 characters'),
  
  body('companyInfo.bankDetails.ibanNumber')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('IBAN number cannot exceed 50 characters'),
  
  body('companyInfo.bankDetails.currency')
    .optional()
    .trim()
    .isLength({ max: 10 })
    .withMessage('Currency cannot exceed 10 characters'),
  
  handleValidationErrors
];

// Login validation
const validateLogin = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  
  handleValidationErrors
];

// Change password validation
const validateChangePassword = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters'),
  
  body('confirmPassword')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('Password confirmation does not match');
      }
      return true;
    }),
  
  handleValidationErrors
];

// ID parameter validation
const validateObjectId = [
  param('id')
    .isMongoId()
    .withMessage('Invalid admin ID'),
  
  handleValidationErrors
];

// Query validation for get all admins
const validateGetAllAdmins = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1-100'),
  
  query('type')
    .optional()
    .isIn(['super_admin', 'admin', 'manager', 'operator', 'viewer'])
    .withMessage('Invalid admin type'),
  
  query('status')
    .optional()
    .isIn(['active', 'inactive', 'suspended'])
    .withMessage('Invalid status'),
  
  query('search')
    .optional()
    .trim()
    .isLength({ min: 1 })
    .withMessage('Search term cannot be empty'),
  
  handleValidationErrors
];

module.exports = {
  validateCreateAdmin,
  validateUpdateAdmin,
  validateProfileUpdate,
  validateLogin,
  validateChangePassword,
  validateObjectId,
  validateGetAllAdmins,
  handleValidationErrors
};