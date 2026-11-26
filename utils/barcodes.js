// What an item's barcode may be. Pure: no database, so the item service, the spreadsheet import and the tests share it.
//
// A barcode is what a scanner types: printable characters, no line breaks, at most 64 of them (an EAN-13 is 13, a
// Code 128 label rarely past 40). Blank means "none given", and the item service then uses the SKU, which is what the
// item form has always drawn as the barcode. A barcode is matched exactly, so letters keep their case.

const MAX_LENGTH = 64;

// A barcode as given -> { value } (the trimmed text, "" for none) or { error } (a sentence a person can act on).
// Only a string or a number is a barcode: an object or a list from a request body reads as an error, never as text.
function cleanBarcode(input) {
  if (input === undefined || input === null) return { value: "" };
  if (typeof input !== "string" && typeof input !== "number") return { error: "A barcode is text." };
  const value = String(input).trim();
  if (!value) return { value: "" };
  if (value.length > MAX_LENGTH) return { error: `A barcode is at most ${MAX_LENGTH} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { error: "A barcode cannot hold line breaks or control characters." };
  return { value };
}

module.exports = { MAX_LENGTH, cleanBarcode };
