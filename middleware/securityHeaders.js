// Standard response headers for an API that serves JSON (and the odd download), no web pages.
//
//   X-Content-Type-Options: nosniff        a download is never reinterpreted as script or markup by the browser
//   X-Frame-Options: DENY + frame-ancestors  no page may put this API (or a file from it) in a frame: no click-jacking, no overlay
//   Content-Security-Policy: default-src 'none'   if a response is ever opened as a document, it can load and run nothing
//   Referrer-Policy: no-referrer           the address of a page (a reset link, a document link) is never passed on to another site
//   Cache-Control: no-store                what the API says is about one person's books: no browser, proxy or shared cache keeps it
//                                          (a route that wants something else sets its own, later, and wins)
//   Strict-Transport-Security              production, over HTTPS: the browser stays on HTTPS for this host
//   Permissions-Policy / COOP              nothing here needs the camera, the location or a window handle on another origin
//
// There is no web page on this origin, so a strict policy costs nothing. The FRONTEND is a separate static site with its own headers
// (trade erp/render.yaml, public/_headers).
const isProduction = () => process.env.NODE_ENV === "production";

const POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const PERMISSIONS = "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()";

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", POLICY);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", PERMISSIONS);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (isProduction() && (req.secure || req.headers["x-forwarded-proto"] === "https")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

module.exports = securityHeaders;
module.exports.POLICY = POLICY;
