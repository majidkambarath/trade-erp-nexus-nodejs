const UOMService = require("../../services/unit/uomService");
const catchAsync = require("../../utils/catchAsync");

// UOM Controllers
exports.createUOM = catchAsync(async (req, res) => {
  const uom = await UOMService.createUOM(req.body);
  res.status(201).json({ 
    success: true, 
    message: "UOM created successfully",
    data: uom 
  });
});

exports.getAllUOMs = catchAsync(async (req, res) => {
  const { search, status, type, category } = req.query;
  const uoms = await UOMService.getAllUOMs({ search, status, type, category });
  console.log(uoms)
  res.json({ 
    success: true, 
    count: uoms.length,
    data: uoms 
  });
});

exports.getUOMById = catchAsync(async (req, res) => {
  const uom = await UOMService.getUOMById(req.params.id);
  res.json({ 
    success: true, 
    data: uom 
  });
});

exports.updateUOM = catchAsync(async (req, res) => {
  const uom = await UOMService.updateUOM(req.params.id, req.body);
  res.json({ 
    success: true, 
    message: "UOM updated successfully",
    data: uom 
  });
});

exports.deleteUOM = catchAsync(async (req, res) => {
  await UOMService.deleteUOM(req.params.id);
  res.json({ 
    success: true, 
    message: "UOM deleted successfully" 
  });
});

// UOM Conversion Controllers
exports.createUOMConversion = catchAsync(async (req, res) => {
  console.log(req.body)
  const conversion = await UOMService.createUOMConversion(req.body);
  res.status(201).json({ 
    success: true, 
    message: "UOM Conversion created successfully",
    data: conversion 
  });
});

exports.getAllUOMConversions = catchAsync(async (req, res) => {
  const { search, status, category } = req.query;
  const conversions = await UOMService.getAllUOMConversions({ search, status, category });
  res.json({ 
    success: true, 
    count: conversions.length,
    data: conversions 
  });
});

exports.getUOMConversionById = catchAsync(async (req, res) => {
  const conversion = await UOMService.getUOMConversionById(req.params.id);
  res.json({ 
    success: true, 
    data: conversion 
  });
});

exports.updateUOMConversion = catchAsync(async (req, res) => {
  const conversion = await UOMService.updateUOMConversion(req.params.id, req.body);
  res.json({ 
    success: true, 
    message: "UOM Conversion updated successfully",
    data: conversion 
  });
});

exports.deleteUOMConversion = catchAsync(async (req, res) => {
  await UOMService.deleteUOMConversion(req.params.id);
  res.json({ 
    success: true, 
    message: "UOM Conversion deleted successfully" 
  });
});

// Utility endpoint for unit conversion
exports.convertUnits = catchAsync(async (req, res) => {
  const { fromUOM, toUOM, quantity } = req.body;
  const convertedQuantity = await UOMService.convertUnits(fromUOM, toUOM, quantity);
  res.json({ 
    success: true, 
    data: {
      originalQuantity: quantity,
      convertedQuantity,
      fromUOM,
      toUOM
    }
  });
});