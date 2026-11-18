const { COST_KEYS, MOVEMENT_COST_KEYS, mayViewCost, withoutKeys } = require("../utils/costVisibility");

// Put after authenticateToken in a router that carries cost figures. A caller who holds inventory.viewCost is passed through untouched;
// for anyone else every JSON answer of the router loses the cost fields (utils/costVisibility.js), whatever route produced it.
//   hideCost()                    the item and document cost fields
//   hideCost({ movements: true })  also `totalValue`, which on a stock movement is cost
//   hideCost({ extra: [...] })     more names, for a router where a generic name (value ...) is a cost figure
function hideCost({ movements = false, extra = [] } = {}) {
  const keys = new Set([...(movements ? MOVEMENT_COST_KEYS : COST_KEYS), ...extra]);
  return (req, res, next) => {
    if (mayViewCost(req.admin)) return next();
    const json = res.json.bind(res);
    // a Mongoose document or lean row is turned into plain JSON first, so nothing hides behind a toJSON
    res.json = (body) => json(withoutKeys(JSON.parse(JSON.stringify(body ?? null)), keys));
    next();
  };
}

module.exports = { hideCost };
