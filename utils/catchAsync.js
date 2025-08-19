// Wrapper to avoid repetitive try/catch in controllers
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
