const mongoose = require("mongoose");
const Customer = require("../../models/modules/customerModel");
const AppError = require("../../utils/AppError");
const Sequence = require("../../models/modules/sequenceModel");

// Helper to get the next sequence number without saving it
const getNextSequenceNumber = async (year, type, session) => {
  try {
    let sequence = await Sequence.findOne({ year, type }).session(session);

    if (!sequence) {
      const [newSequence] = await Sequence.create(
        [{ year, type, usedNumbers: [], deletedNumbers: [] }],
        { session }
      );
      sequence = newSequence;
    }

    if (!sequence) {
      throw new AppError("Failed to initialize sequence document", 500);
    }

    if (sequence.deletedNumbers && sequence.deletedNumbers.length > 0) {
      return Math.min(...sequence.deletedNumbers);
    }

    return sequence.usedNumbers.length > 0 ? Math.max(...sequence.usedNumbers) + 1 : 1;
  } catch (error) {
    throw new AppError(`Sequence number generation failed: ${error.message}`, 500);
  }
};

// Commit sequence number to usedNumbers after successful customer creation
const commitSequenceNumber = async (year, type, sequenceNumber, session) => {
  try {
    await Sequence.findOneAndUpdate(
      { year, type },
      {
        $pull: { deletedNumbers: sequenceNumber },
        $addToSet: { usedNumbers: sequenceNumber },
      },
      { session }
    );
  } catch (error) {
    throw new AppError(`Failed to commit sequence number: ${error.message}`, 500);
  }
};

// Release a sequence number to deletedNumbers on deletion
const releaseSequenceNumber = async (customerId, session) => {
  try {
    const year = customerId.slice(4, 8); // Extract year from CUSTYYYYNNN
    const sequenceNumber = parseInt(customerId.slice(8), 10); // Extract number
    await Sequence.findOneAndUpdate(
      { year, type: "customer" },
      {
        $pull: { usedNumbers: sequenceNumber },
        $addToSet: { deletedNumbers: sequenceNumber },
      },
      { session }
    );
  } catch (error) {
    throw new AppError(`Failed to release sequence number: ${error.message}`, 500);
  }
};

exports.createCustomer = async (data) => {
  const {
    customerName,
    contactPerson,
    email,
    phone,
    billingAddress,
    shippingAddress,
    creditLimit,
    paymentTerms,
    status,
  } = data;

  // Validate paymentTerms early to avoid sequence allocation
  const validPaymentTerms = ["Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid"];
  if (paymentTerms && !validPaymentTerms.includes(paymentTerms)) {
    throw new AppError(
      `Invalid paymentTerms. Must be one of: ${validPaymentTerms.join(", ")}`,
      400
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const currentYear = new Date().getFullYear().toString();
    const sequenceNumber = await getNextSequenceNumber(currentYear, "customer", session);
    const formattedNumber = sequenceNumber.toString().padStart(3, "0"); // Ensure 3 digits
    const newCustomerId = `CUST${currentYear}${formattedNumber}`;

    const trimmedPhone = phone ? phone.toString().trim().replace(/\s+/g, "") : null;
    const trimmedContactPerson = contactPerson
      ? contactPerson.toString().trim().replace(/\s+/g, "")
      : null;

    const customer = await Customer.create(
      [
        {
          customerId: newCustomerId,
          customerName,
          contactPerson: trimmedContactPerson,
          email,
          phone: trimmedPhone,
          billingAddress,
          shippingAddress,
          creditLimit: Number(creditLimit) || 0,
          paymentTerms: paymentTerms || "Net 30", // Use default if not provided
          status,
        },
      ],
      { session }
    )[0];

    await commitSequenceNumber(currentYear, "customer", sequenceNumber, session);
    await session.commitTransaction();
    return customer;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

exports.getAllCustomers = async (filters) => {
  const query = {};

  if (filters.search) {
    query.$or = [
      { customerId: new RegExp(filters.search, "i") },
      { customerName: new RegExp(filters.search, "i") },
      { contactPerson: new RegExp(filters.search, "i") },
      { email: new RegExp(filters.search, "i") },
    ];
  }

  if (filters.status) {
    query.status = filters.status;
  }

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
  const validPaymentTerms = ["Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid"];
  if (data.paymentTerms && !validPaymentTerms.includes(data.paymentTerms)) {
    throw new AppError(
      `Invalid paymentTerms. Must be one of: ${validPaymentTerms.join(", ")}`,
      400
    );
  }

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
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const customer = await Customer.findByIdAndDelete(id, { session });
    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    await releaseSequenceNumber(customer.customerId, session);
    await session.commitTransaction();
    return customer;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
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
          $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] },
        },
        inactiveCustomers: {
          $sum: { $cond: [{ $eq: ["$status", "Inactive"] }, 1, 0] },
        },
        totalRevenue: { $sum: "$totalSpent" },
        totalOrders: { $sum: "$totalOrders" },
        avgCreditLimit: { $avg: "$creditLimit" },
      },
    },
  ]);

  return stats[0] || {
    totalCustomers: 0,
    activeCustomers: 0,
    inactiveCustomers: 0,
    totalRevenue: 0,
    totalOrders: 0,
    avgCreditLimit: 0,
  };
};

exports.updateCustomerByCustomerId = async (customerId, data) => {
  const validPaymentTerms = ["Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid"];
  if (data.paymentTerms && !validPaymentTerms.includes(data.paymentTerms)) {
    throw new AppError(
      `Invalid paymentTerms. Must be one of: ${validPaymentTerms.join(", ")}`,
      400
    );
  }

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
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const customer = await Customer.findOneAndDelete({ customerId }, { session });
    if (!customer) {
      throw new AppError("Customer not found", 404);
    }

    await releaseSequenceNumber(customer.customerId, session);
    await session.commitTransaction();
    return customer;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

exports.checkCustomerExists = async (customerId) => {
  const customer = await Customer.findOne({ customerId });
  return !!customer;
};