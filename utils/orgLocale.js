// The organisation's own currency and time zone, readable anywhere in the code without a request.
//
// An organisation is made with a base currency and a time zone (Organisation.baseCurrency, .timezone). The books are kept in
// that currency and "today", "this month" and "the 5th" mean the days of that zone. The code reads them from here, by the
// organisation in scope (utils/tenantContext.js), so a report, a numbering rule or a delivery date needs no argument threaded
// to it. Outside any scope, and for the one organisation that existed before organisations did, it is AED and Asia/Dubai:
// what the whole system assumed until now.
//
// The values are kept in memory: filled when an organisation is loaded (every request does, the start-up does for all, and the
// services that make or change one do) and refreshed on a short lease so a change made by another instance is seen within a
// minute. An organisation not yet loaded reads as the default for that moment and is loaded in the background.
const tz = require("./tz");
const { ambientTenant } = require("./tenantContext");

const DEFAULT = Object.freeze({ baseCurrency: "AED", timezone: "Asia/Dubai", country: "AE" });
const LEASE_MS = 60 * 1000;
const cache = new Map(); // companyId -> { baseCurrency, timezone, country, at }
let loader = null; // set by the service that can read the registry, so this file never requires a model

const valid = (v) => ({
  baseCurrency: typeof v?.baseCurrency === "string" && v.baseCurrency.trim() ? v.baseCurrency.trim().toUpperCase() : DEFAULT.baseCurrency,
  timezone: tz.validZone(v?.timezone) ? v.timezone : DEFAULT.timezone,
  country: typeof v?.country === "string" && v.country.trim() ? v.country.trim().toUpperCase() : DEFAULT.country,
});

/** Remember an organisation (a registry row, or anything with its code, baseCurrency, timezone and country). */
function warm(org) {
  if (!org?.code) return;
  cache.set(org.code, { ...valid(org), at: Date.now() });
}

/** Forget one (or all, when no code is given): the next read loads it again. */
function forget(code) {
  if (code) cache.delete(code);
  else cache.clear();
}

/** Teach this module how to read an organisation by code. Called once, by the service that owns the registry. */
function useLoader(fn) { loader = fn; }

const refresh = (code) => {
  if (!loader) return;
  Promise.resolve()
    .then(() => loader(code))
    .then((org) => { if (org) warm({ ...org, code }); })
    .catch(() => { /* keep what is known: a failed refresh must never fail a report */ });
};

/** The locale of an organisation by its code, synchronously. */
function forCompany(code) {
  const hit = code ? cache.get(code) : null;
  if (hit) {
    if (Date.now() - hit.at > LEASE_MS) { hit.at = Date.now(); refresh(code); } // serve what we have, read again in the background
    return { baseCurrency: hit.baseCurrency, timezone: hit.timezone, country: hit.country };
  }
  if (code) refresh(code);
  return { ...DEFAULT };
}

/** The locale of the organisation in scope. */
function current() {
  const scope = ambientTenant();
  return forCompany(scope?.companyId);
}

const timezone = () => current().timezone;
const baseCurrency = () => current().baseCurrency;
const country = () => current().country;

// The day helpers of utils/tz.js, already in the organisation's zone.
const dayOf = (instant) => tz.dayOf(instant, timezone());
const today = (now = new Date()) => tz.todayIn(timezone(), now);
const dayStart = (ymd) => tz.dayStart(ymd, timezone());
const dayEnd = (ymd) => tz.dayEnd(ymd, timezone());
const endOfDay = (ymd) => tz.endOfDay(ymd, timezone());
const noonOf = (ymd) => tz.noonOf(ymd, timezone());
const yearOf = (instant) => tz.yearOf(instant, timezone());

module.exports = {
  DEFAULT, warm, forget, useLoader, forCompany, current, timezone, baseCurrency, country,
  dayOf, today, dayStart, dayEnd, endOfDay, noonOf, yearOf,
};
