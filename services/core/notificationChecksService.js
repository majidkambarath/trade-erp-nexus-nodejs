// Scheduled checks that raise or resolve notifications for conditions nobody actively watches today (the
// Stage 4 automation audit: "no reorder or expiry alerts"). Each check is one function, independent of the
// others - a registry/plugin shape is worth building once there are several more than this; one trigger
// does not earn the abstraction yet. processDue() runs every live organisation's checks inside its own
// scope (services/core/organisationService.js `forEach`), from the setInterval in server.js.
const StockService = require("../stock/stockService");
const OrganisationService = require("./organisationService");
const NotificationService = require("./notificationService");

class NotificationChecksService {
  /** Anything at or below its reorder level gets (or keeps) one open notification; anything no longer low
   * is resolved, so restocking an item quietly closes its own alert instead of leaving a stale one read. */
  static async checkLowStock(now = new Date()) {
    const items = await StockService.getLowStockItems();
    const active = [];
    for (const item of items) {
      const dedupeKey = `low_stock:${item._id}`;
      active.push(dedupeKey);
      const name = item.itemName || item.sku || "An item";
      await NotificationService.raise({
        kind: "low_stock",
        severity: item.currentStock <= 0 ? "critical" : "warning",
        title: `${name} is low on stock`,
        body: `${item.currentStock} left, at or below the reorder level of ${item.reorderLevel}.`,
        link: "/stock",
        dedupeKey,
        permission: "inventory.view",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "low_stock", activeDedupeKeys: active, now });
    return { checked: items.length };
  }

  static async runAll(now = new Date()) {
    const results = {};
    for (const [key, fn] of Object.entries({ lowStock: this.checkLowStock })) {
      try {
        results[key] = await fn.call(this, now);
      } catch (err) {
        results[key] = { error: err.message };
      }
    }
    return results;
  }

  /** The background pass, every few minutes from server.js: run every live organisation's checks inside
   * its own scope. Not gated behind an optional feature - a notification feed is a core capability, like
   * the approvals queue, not an add-on - so every organisation that can still write gets it. */
  static async processDue(now = new Date()) {
    return OrganisationService.forEach((code) => this.runAll(now), { label: "notification checks", now });
  }
}

module.exports = NotificationChecksService;
