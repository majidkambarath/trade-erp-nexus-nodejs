// The mail the SYSTEM sends to a person about their own account (not a document for a customer: that is
// utils/emailTemplates.js). Pure: handed the data, returns { subject, html, text }.
//
// Plain on purpose: one column, inline styles, no images, no tracking pixel, and always a text part. The reset mail says what
// to do if the person did not ask, because that is the case that matters most.
const PRODUCT = () => process.env.SYSTEM_MAIL_PRODUCT_NAME || "Zarvia";

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const frame = (inner) => `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1c1917">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:28px">${inner}
<p style="margin:24px 0 0;font-size:12px;color:#78716c">${escapeHtml(PRODUCT())}</p></div></body></html>`;

function passwordResetMail({ name, url, minutes = 30 }) {
  const hello = name ? `Hello ${name},` : "Hello,";
  const subject = `Reset your ${PRODUCT()} password`;
  const text = [
    hello,
    "",
    `Someone asked to reset the password of your ${PRODUCT()} account. If that was you, open this link and choose a new password. It works once, and for ${minutes} minutes:`,
    "",
    url,
    "",
    "If you did not ask for this, ignore this mail: your password has not changed and nobody can use the link without this mail.",
  ].join("\n");
  const html = frame(`<h1 style="margin:0 0 12px;font-size:20px;font-weight:600">Reset your password</h1>
<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(hello)}</p>
<p style="margin:0 0 20px;font-size:14px;line-height:1.5">Someone asked to reset the password of your ${escapeHtml(PRODUCT())} account. If that was you, choose a new one. The link works once, and for ${minutes} minutes.</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:12px 22px;border-radius:999px">Choose a new password</a></p>
<p style="margin:0 0 8px;font-size:12px;color:#78716c;line-height:1.5">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(url)}</span></p>
<p style="margin:0;font-size:12px;color:#78716c;line-height:1.5">If you did not ask for this, ignore this mail: your password has not changed.</p>`);
  return { subject, html, text };
}

// A short notice that something about the account's security changed, so a change nobody made is noticed.
function securityNoticeMail({ name, headline, detail }) {
  const hello = name ? `Hello ${name},` : "Hello,";
  const subject = `${headline} - ${PRODUCT()}`;
  const text = [hello, "", `${headline}.`, ...(detail ? [detail] : []), "", "If this was not you, reset your password now and ask your administrator to check your account."].join("\n");
  const html = frame(`<h1 style="margin:0 0 12px;font-size:20px;font-weight:600">${escapeHtml(headline)}</h1>
<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(hello)}</p>
${detail ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(detail)}</p>` : ""}
<p style="margin:0;font-size:12px;color:#78716c;line-height:1.5">If this was not you, reset your password now and ask your administrator to check your account.</p>`);
  return { subject, html, text };
}

module.exports = { passwordResetMail, securityNoticeMail, escapeHtml };
