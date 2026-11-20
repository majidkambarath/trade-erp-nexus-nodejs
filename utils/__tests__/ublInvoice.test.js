const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parseUbl } = require("../ublInvoice");

const sandbox = fs.readFileSync(path.join(__dirname, "fixtures", "ubl", "sandbox-invoice.xml"), "utf8");

test("the real Wafeq sandbox invoice parses to its number, seller, totals and lines", () => {
  const d = parseUbl(sandbox);
  assert.equal(d.kind, "invoice");
  assert.equal(d.documentId, "WQS-2026-0001");
  assert.equal(d.issueDate, "2026-11-20");
  assert.equal(d.dueDate, "2026-12-20");
  assert.equal(d.invoiceTypeCode, "380");
  assert.equal(d.documentCurrencyCode, "AED");
  assert.equal(d.sellerName, "Sandbox taxpayer 5504");
  assert.equal(d.sellerVatTrn, "171686550400003");
  assert.equal(d.sellerParticipantId, "0235:1716865504");
  assert.equal(d.lineExtensionTotal, 1644);
  assert.equal(d.taxAmount, 82.2);
  assert.equal(d.payableAmount, 1726.2);
  assert.equal(d.lines.length, 3);
  assert.deepEqual(d.lines[0], {
    lineNumber: 1, itemName: "Basmati Rice 25 kg", sellerItemId: undefined, quantity: 10, unitCode: "H87", unitPrice: 95, priceBaseQty: 1,
    lineNetAmount: 950, taxCategory: "S", taxRatePercent: 5, lineTaxAmount: 47.5,
  });
  assert.equal(d.lines.reduce((t, l) => t + l.lineTaxAmount, 0).toFixed(2), "82.20");
});

const creditNote = `<?xml version="1.0"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>CN-77</cbc:ID><cbc:IssueDate>2026-11-21</cbc:IssueDate><cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode><cbc:DocumentCurrencyCode>AED</cbc:DocumentCurrencyCode>
  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-9</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>
  <cac:AccountingSupplierParty><cac:Party><cbc:EndpointID schemeID="0235">1234567890</cbc:EndpointID><cac:PartyName><cbc:Name>Gulf Grain</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>123456789000003</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="AED">5.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="AED">100.00</cbc:LineExtensionAmount><cbc:PayableAmount currencyID="AED">105.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:CreditNoteLine><cbc:ID>1</cbc:ID><cbc:CreditedQuantity unitCode="KGM">4</cbc:CreditedQuantity><cbc:LineExtensionAmount currencyID="AED">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Rice</cbc:Name><cac:SellersItemIdentification><cbc:ID>RICE-25</cbc:ID></cac:SellersItemIdentification><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>5</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="AED">25</cbc:PriceAmount></cac:Price></cac:CreditNoteLine>
</CreditNote>`;

test("a credit note keeps its kind, the invoice it credits and its seller's item code", () => {
  const d = parseUbl(creditNote);
  assert.equal(d.kind, "credit_note");
  assert.equal(d.documentId, "CN-77");
  assert.equal(d.invoiceRef, "INV-9");
  assert.equal(d.invoiceTypeCode, "381");
  assert.equal(d.lines[0].quantity, 4);
  assert.equal(d.lines[0].sellerItemId, "RICE-25");
  assert.equal(d.lines[0].lineTaxAmount, 5); // no per-line tax element: worked out from the rate
  assert.equal(d.payableAmount, 105);
});

test("a document wrapped in a StandardBusinessDocument is found", () => {
  const wrapped = `<?xml version="1.0"?><sbd:StandardBusinessDocument xmlns:sbd="http://www.unece.org/cefact/namespaces/StandardBusinessDocumentHeader"><sbd:StandardBusinessDocumentHeader><sbd:HeaderVersion>1.0</sbd:HeaderVersion></sbd:StandardBusinessDocumentHeader>${sandbox.replace(/<\?xml[^>]*\?>/, "")}</sbd:StandardBusinessDocument>`;
  assert.equal(parseUbl(wrapped).documentId, "WQS-2026-0001");
});

test("junk is refused with a clear UBL_INVALID error, never a half-read document", () => {
  for (const bad of ["", "   ", "not xml at all", "<root><a/></root>", "<Invoice xmlns='urn:x'><x/></Invoice>"]) {
    assert.throws(() => parseUbl(bad), { code: "UBL_INVALID" });
  }
  assert.throws(() => parseUbl(null), { code: "UBL_INVALID" });
});
