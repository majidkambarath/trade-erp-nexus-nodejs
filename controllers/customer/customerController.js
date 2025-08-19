const CustomerService = require("../../services/customer/customerService");
const catchAsync = require("../../utils/catchAsync");

exports.createCustomer = catchAsync(async (req, res) => {
  const customer = await CustomerService.createCustomer(req.body);
  res.status(201).json({ 
    success: true, 
    message: "Customer created successfully",
    data: customer 
  });
});

exports.getAllCustomers = catchAsync(async (req, res) => {
  const { search, status, paymentTerms } = req.query;
  console.log("first")
  const customers = await CustomerService.getAllCustomers({ 
    search, 
    status, 
    paymentTerms 
  });
  console.log(customers)
  res.json({ 
    success: true, 
    count: customers.length,
    data: customers 
  });
});

exports.getCustomerById = catchAsync(async (req, res) => {
  const customer = await CustomerService.getCustomerById(req.params.id);
  res.json({ 
    success: true, 
    data: customer 
  });
});

exports.getCustomerByCustomerId = catchAsync(async (req, res) => {
  const customer = await CustomerService.getCustomerByCustomerId(req.params.customerId);
  res.json({ 
    success: true, 
    data: customer 
  });
});

exports.updateCustomer = catchAsync(async (req, res) => {
  const customer = await CustomerService.updateCustomer(req.params.id, req.body);
  res.json({ 
    success: true, 
    message: "Customer updated successfully",
    data: customer 
  });
});

exports.deleteCustomer = catchAsync(async (req, res) => {
  await CustomerService.deleteCustomer(req.params.id);
  res.json({ 
    success: true, 
    message: "Customer deleted successfully" 
  });
});

exports.updateCustomerStats = catchAsync(async (req, res) => {
  const customer = await CustomerService.updateCustomerStats(
    req.params.id, 
    req.body
  );
  res.json({ 
    success: true, 
    message: "Customer statistics updated successfully",
    data: customer 
  });
});

exports.getCustomerStats = catchAsync(async (req, res) => {
  const stats = await CustomerService.getCustomerStats();
  res.json({ 
    success: true, 
    data: stats 
  });
});

exports.getCustomersByStatus = catchAsync(async (req, res) => {
  const { status } = req.params;
  const customers = await CustomerService.getAllCustomers({ status });
  res.json({ 
    success: true, 
    count: customers.length,
    data: customers 
  });
});

exports.searchCustomers = catchAsync(async (req, res) => {
  const { q } = req.query; // search query
  const customers = await CustomerService.getAllCustomers({ search: q });
  res.json({ 
    success: true, 
    count: customers.length,
    data: customers 
  });
});