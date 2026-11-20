// UBL (PINT-AE) Invoice / CreditNote XML -> the flat shape InboundService.normalise takes. Pure: no I/O.
//
// A supplier's e-invoice reaches us as the XML Wafeq stores (GET /invoices/{id}/xml): a bare <Invoice> or <CreditNote>, or one wrapped in a
// Peppol StandardBusinessDocument. Namespace prefixes are dropped, so cbc:ID and cac:Party read as ID and Party whatever prefix the sender chose.
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: true,
});

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v === undefined || v === null ? "" : typeof v === "object" ? String(v["#text"] ?? "").trim() : String(v).trim());
const num = (v) => { const n = Number(text(v)); return Number.isFinite(n) ? n : 0; };
const fail = (message) => Object.assign(new Error(message), { code: "UBL_INVALID" });

// the document element, wherever it sits (bare, or inside StandardBusinessDocument / other wrappers)
function findDocument(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  for (const key of ["Invoice", "CreditNote"]) if (node[key] && typeof node[key] === "object") return { kind: key === "CreditNote" ? "credit_note" : "invoice", doc: node[key] };
  for (const v of Object.values(node)) {
    const hit = findDocument(Array.isArray(v) ? v[0] : v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const participant = (ep) => {
  const id = text(ep);
  if (!id) return "";
  const scheme = ep && typeof ep === "object" ? String(ep["@_schemeID"] || "").trim() : "";
  return scheme ? `${scheme}:${id}` : id;
};

/** xml: the text of a UBL document -> { kind, documentId, issueDate, dueDate, invoiceTypeCode, documentCurrencyCode, seller..., totals, lines[] } */
function parseUbl(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw fail("The e-invoice is empty");
  let tree;
  try { tree = parser.parse(xml); } catch (err) { throw fail(`The e-invoice is not readable XML: ${err.message}`); }
  const found = findDocument(tree);
  if (!found) throw fail("No Invoice or CreditNote was found in the XML");
  const { kind, doc } = found;
  const documentId = text(doc.ID);
  if (!documentId) throw fail("The e-invoice has no number (cbc:ID)");

  const party = list(doc.AccountingSupplierParty)[0]?.Party || {};
  const tax = list(party.PartyTaxScheme)[0] || {};
  const legal = list(party.PartyLegalEntity)[0] || {};
  const lineKey = kind === "credit_note" ? "CreditNoteLine" : "InvoiceLine";
  const lines = list(doc[lineKey]).map((l, i) => {
    const item = l.Item || {};
    const cat = list(item.ClassifiedTaxCategory)[0] || {};
    const price = l.Price || {};
    const net = round2(num(l.LineExtensionAmount));
    const pct = num(cat.Percent);
    const ext = l.ItemPriceExtension?.TaxTotal?.TaxAmount;
    return {
      lineNumber: Number(text(l.ID)) || i + 1,
      itemName: text(item.Name) || text(item.Description),
      sellerItemId: text(item.SellersItemIdentification?.ID) || undefined,
      quantity: num(l.InvoicedQuantity ?? l.CreditedQuantity),
      unitCode: (l.InvoicedQuantity ?? l.CreditedQuantity)?.["@_unitCode"] || undefined,
      unitPrice: num(price.PriceAmount),
      priceBaseQty: num(price.BaseQuantity) || 1,
      lineNetAmount: net,
      taxCategory: text(cat.ID),
      taxRatePercent: pct,
      lineTaxAmount: ext !== undefined ? round2(num(ext)) : round2((net * pct) / 100),
    };
  });
  const money = doc.LegalMonetaryTotal || {};
  const taxAmount = round2(num(list(doc.TaxTotal)[0]?.TaxAmount));
  const lineExtensionTotal = money.LineExtensionAmount !== undefined ? round2(num(money.LineExtensionAmount)) : round2(lines.reduce((t, l) => t + l.lineNetAmount, 0));
  return {
    kind,
    documentId,
    issueDate: text(doc.IssueDate) || undefined,
    dueDate: text(doc.DueDate) || undefined,
    invoiceTypeCode: text(doc.InvoiceTypeCode || doc.CreditNoteTypeCode) || (kind === "credit_note" ? "381" : "380"),
    documentCurrencyCode: text(doc.DocumentCurrencyCode) || "AED",
    sellerName: text(party.PartyName?.Name) || text(legal.RegistrationName),
    sellerVatTrn: text(tax.CompanyID) || undefined,
    sellerParticipantId: participant(party.EndpointID) || undefined,
    invoiceRef: text(list(doc.BillingReference)[0]?.InvoiceDocumentReference?.ID) || undefined,
    lineExtensionTotal,
    taxAmount,
    payableAmount: round2(num(money.PayableAmount ?? money.TaxInclusiveAmount)),
    lines,
  };
}

module.exports = { parseUbl };
