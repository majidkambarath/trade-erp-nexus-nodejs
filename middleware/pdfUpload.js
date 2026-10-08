// Takes the one PDF that comes with a send (multipart field "pdf") into memory. Never to disk: the
// server's disk is not durable, and the file is only wanted for the length of a send. A request with no
// file, or one that is plain JSON (a link-only send), passes straight through.
//
// The size cap is 4 MB: an A4 sheet drawn by the browser is normally 0.1 to 1.5 MB, and base64 in the
// email adds a third. The first bytes are checked, because the declared type is only the browser's word.
const multer = require("multer");
const AppError = require("../utils/AppError");

const MAX_BYTES = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

const pdfUpload = (req, res, next) => {
  upload.single("pdf")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") return next(new AppError(`The PDF is larger than ${MAX_BYTES / 1024 / 1024} MB.`, 413, "PDF_TOO_LARGE"));
      if (err instanceof multer.MulterError) return next(new AppError("The upload could not be read.", 400, "UPLOAD_INVALID"));
      return next(err);
    }
    const file = req.file;
    if (file && file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return next(new AppError("That file is not a PDF.", 415, "PDF_INVALID"));
    }
    return next();
  });
};

module.exports = { pdfUpload, MAX_BYTES };
