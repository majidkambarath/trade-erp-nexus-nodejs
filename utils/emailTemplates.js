// The email that carries a document to a customer. Pure: it is handed the data and returns
// { subject, html, text }, so it is tested without a database or a network and a change to the wording
// is a change to one file.
//
// Deliberately plain: one column, inline styles, system fonts, no script, no remote CSS and NO
// tracking pixel. An invoice should not quietly report when it was read; the document link is the
// signal, and the customer chooses to click it. A text part is always produced: some mail systems
// score a message with no text part as spam, and it is what the history keeps as a preview.

const DOC_LABEL = {
  tax_invoice: "Tax invoice",
  quotation: "Quotation",
  delivery_note: "Delivery note",
  statement: "Statement of account",
};

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// 6 Oct 2026, in Dubai time: the day a UAE customer would say.
const fmtDay = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" }).format(d);
};

const fmtMoney = (n, currency = "AED") => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
};

const periodText = (p) => (p?.from && p?.to ? `${fmtDay(p.from)} to ${fmtDay(p.to)}` : "");

function subjectFor({ docType, documentNo, company, validUntil, period }) {
  const label = DOC_LABEL[docType] || "Document";
  const from = company?.companyName ? ` from ${company.companyName}` : "";
  if (docType === "statement") return `${label}${periodText(period) ? ` - ${periodText(period)}` : ""}${from}`;
  const base = `${label} ${documentNo}${from}`;
  return docType === "quotation" && validUntil ? `${base} - valid until ${fmtDay(validUntil)}` : base;
}

// The one factual sentence, per kind.
function factLine(d) {
  const label = (DOC_LABEL[d.docType] || "document").toLowerCase();
  const money = fmtMoney(d.total, d.currency);
  switch (d.docType) {
    case "tax_invoice":
      return `Please find ${label} ${d.documentNo} dated ${fmtDay(d.date)} for ${money}.${d.dueDate ? ` It is due on ${fmtDay(d.dueDate)}.` : ""}`;
    case "quotation":
      return `Please find ${label} ${d.documentNo} dated ${fmtDay(d.date)} for ${money}${d.validUntil ? `, valid until ${fmtDay(d.validUntil)}` : ""}.`;
    case "delivery_note":
      return `Please find ${label} ${d.documentNo} dated ${fmtDay(d.date)} for the goods delivered to you.`;
    case "statement":
      return `Please find your ${label}${periodText(d.period) ? ` for ${periodText(d.period)}` : ""}. The balance at the end of the period is ${money}.`;
    default:
      return `Please find ${label} ${d.documentNo}.`;
  }
}

const companyLines = (c = {}) => {
  const address = [c.addressLine1, c.addressLine2].filter(Boolean).join(", ");
  const contact = [c.phoneNumber && `Tel ${c.phoneNumber}`, c.email, c.website].filter(Boolean).join("  |  ");
  return [c.companyName, address, contact, c.vatNumber && `TRN ${c.vatNumber}`].filter(Boolean);
};

function renderDocumentEmail(d) {
  const subject = subjectFor(d);
  const greeting = `Dear ${d.contactPerson || d.partyName || "customer"},`;
  const fact = factLine(d);
  const note = String(d.note || "").trim();
  const attached = d.hasAttachment ? "A PDF copy is attached." : "";
  const expiry = d.shareUrl && d.shareExpiresAt ? `This link works until ${fmtDay(d.shareExpiresAt)}.` : "";
  const company = companyLines(d.company);
  const signature = String(d.signature || "").trim();
  const logo = typeof d.company?.logo === "string" && /^https:\/\//i.test(d.company.logo) ? d.company.logo : "";

  const text = [
    greeting,
    "",
    fact,
    note && `\n${note}`,
    d.shareUrl && `\nView the document online:\n${d.shareUrl}`,
    attached && `\n${attached}`,
    signature && `\n${signature}`,
    company.length && `\n--\n${company.join("\n")}`,
    expiry && `\n${expiry}`,
    "\nReply to this email if you have a question.",
  ].filter((x) => x !== "" && x !== false && x !== undefined).join("\n");

  const p = (inner, style = "") => `<p style="margin:0 0 14px;line-height:1.55;${style}">${inner}</p>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e3df;border-radius:8px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1c1c1a;">
<tr><td style="padding:24px 28px 8px;">
${logo ? `<img src="${escapeHtml(logo)}" alt="" height="40" style="display:block;margin:0 0 16px;max-height:40px;width:auto;">` : ""}
${p(escapeHtml(greeting))}
${p(escapeHtml(fact))}
${note ? p(escapeHtml(note).replace(/\r?\n/g, "<br>")) : ""}
${d.shareUrl ? `<p style="margin:18px 0 18px;"><a href="${escapeHtml(d.shareUrl)}" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;">View document</a></p>` : ""}
${attached ? p(escapeHtml(attached), "color:#55554f;") : ""}
${signature ? p(escapeHtml(signature).replace(/\r?\n/g, "<br>")) : ""}
</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #ecece8;font-size:12.5px;color:#6b6b64;line-height:1.5;">
${company.map((l, i) => `<div${i === 0 ? ' style="font-weight:600;color:#3d3d38;"' : ""}>${escapeHtml(l)}</div>`).join("\n")}
${expiry ? `<div style="margin-top:8px;">${escapeHtml(expiry)}</div>` : ""}
<div style="margin-top:8px;">Reply to this email if you have a question.</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, html, text };
}

module.exports = { renderDocumentEmail, subjectFor, escapeHtml, fmtDay, fmtMoney, DOC_LABEL };
