const Customer = require("../../models/modules/customerModel");
const AppError = require("../../utils/AppError");

exports.createCustomer = async (data) => {
  const { 
    customerId, 
    customerName, 
    contactPerson, 
    email, 
    phone, 
    billingAddress, 
    shippingAddress, 
    creditLimit, 
    paymentTerms, 
    status 
  } = data;

  // Generate customerId if not provided
  const newCustomerId =
    customerId ||
    `CUST${new Date().toISOString().slice(0, 5).replace(/-/g, "")}-${String(
      Math.floor(Math.random() * 1000) + 1
    ).padStart(3, "0")}`;

  const customer = await Customer.create({
    customerId: newCustomerId,
    customerName,
    contactPerson,
    email,
    phone,
    billingAddress,
    shippingAddress,
    creditLimit: Number(creditLimit) || 0,
    paymentTerms,
    status,
  });

  return customer;
};

exports.getAllCustomers = async (filters) => {
  const query = {};
  
  // Search functionality
  if (filters.search) {
    query.$or = [
      { customerId: new RegExp(filters.search, "i") },
      { customerName: new RegExp(filters.search, "i") },
      { contactPerson: new RegExp(filters.search, "i") },
      { email: new RegExp(filters.search, "i") },
    ];
  }
  
  // Filter by status
  if (filters.status) {
    query.status = filters.status;
  }
  
  // Filter by payment terms
  if (filters.paymentTerms) {
    query.paymentTerms = filters.paymentTerms;
  }

  return Customer.find(query).sort({ createdAt: -1 });
};

exports.getCustomerById = async (id) => {
  const customer = await Customer.findById(id);
  if (!customer) {
    throw new AppError("Customer not found", 404);
  }
  return customer;
};

exports.getCustomerByCustomerId = async (customerId) => {
  const customer = await Customer.findOne({ customerId });
  if (!customer) {
    throw new AppError("Customer not found", 404);
  }
  return customer;
};

exports.updateCustomer = async (id, data) => {
  const customer = await Customer.findByIdAndUpdate(
    id, 
    { ...data, updatedAt: Date.now() }, 
    { new: true, runValidators: true }
  );
  
  if (!customer) {
    throw new AppError("Customer not found", 404);
  }
  
  return customer;
};

exports.deleteCustomer = async (id) => {
  const customer = await Customer.findByIdAndDelete(id);
  if (!customer) {
    throw new AppError("Customer not found", 404);
  }
  return customer;
};

exports.updateCustomerStats = async (id, orderData) => {
  const { orderAmount, isNewOrder = true } = orderData;
  
  const customer = await Customer.findById(id);
  if (!customer) {
    throw new AppError("Customer not found", 404);
  }

  if (isNewOrder) {
    customer.totalOrders += 1;
    customer.totalSpent += Number(orderAmount) || 0;
    customer.lastOrder = new Date();
  }

  await customer.save();
  return customer;
};

exports.getCustomerStats = async () => {
  const stats = await Customer.aggregate([
    {
      $group: {
        _id: null,
        totalCustomers: { $sum: 1 },
        activeCustomers: {
          $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] }
        },
        inactiveCustomers: {
          $sum: { $cond: [{ $eq: ["$status", "Inactive"] }, 1, 0] }
        },
        totalRevenue: { $sum: "$totalSpent" },
        totalOrders: { $sum: "$totalOrders" },
        avgCreditLimit: { $avg: "$creditLimit" }
      }
    }
  ]);

  return stats[0] || {
    totalCustomers: 0,
    activeCustomers: 0,
    inactiveCustomers: 0,
    totalRevenue: 0,
    totalOrders: 0,
    avgCreditLimit: 0
  };
};

// Additional helper methods
exports.updateCustomerByCustomerId = async (customerId, data) => {
  const customer = await Customer.findOneAndUpdate(
    { customerId },
    { ...data, updatedAt: Date.now() },
    { new: true, runValidators: true }
  );
  
  if (!customer) {
    throw new AppError("Customer not found", 404);
  }
  
  return customer;
};

exports.deleteCustomerByCustomerId = async (customerId) => {
  const customer = await Customer.findOneAndDelete({ customerId });
  if (!customer) {
    throw new AppError("Customer not found", 404);
  }
  return customer;
};

exports.checkCustomerExists = async (customerId) => {
  const customer = await Customer.findOne({ customerId });
  return !!customer;
};