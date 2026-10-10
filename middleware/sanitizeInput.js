// Removes, from the body of every request, the keys no honest client ever sends and several attacks rely on:
//
//   __proto__, constructor, prototype   a JSON body can carry "__proto__" as an OWN key. Anything that copies the body onto an object with
//                                       Object.assign / a deep merge then re-parents that object (or, with a naive merge, pollutes
//                                       Object.prototype for the whole server). An update that did this answered 500 for the one request.
//   $anything                           a key that starts with $ is a database operator ($set, $ne, $where ...). A body is data: where a
//                                       service passes a body, or a part of it, to a query or an update, an operator in it would run.
//
// The keys are dropped, not rejected: the rest of the request is judged on its own merits. Query strings are not touched - Express 5 parses
// them with Node's querystring, which gives plain keys ("a[$ne]" stays a key called "a[$ne]") on an object with no prototype.
// A multipart form is read later, by the route's own upload middleware, and its fields are text.
const BAD = new Set(["__proto__", "constructor", "prototype"]);

function clean(root) {
  if (!root || typeof root !== "object") return 0;
  let dropped = 0;
  const stack = [root];
  const seen = new Set(); // a body is a tree, but never loop on one that is not
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) if (child && typeof child === "object") stack.push(child);
      continue;
    }
    for (const key of Object.keys(node)) {
      if (BAD.has(key) || key.startsWith("$")) {
        delete node[key];
        dropped += 1;
      } else if (node[key] && typeof node[key] === "object") {
        stack.push(node[key]);
      }
    }
  }
  return dropped;
}

function sanitizeInput(req, _res, next) {
  clean(req.body);
  next();
}

module.exports = sanitizeInput;
module.exports.clean = clean;
