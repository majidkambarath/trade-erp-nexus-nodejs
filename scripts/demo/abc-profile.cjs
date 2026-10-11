const { api } = require("./abc-lib.cjs");
(async () => {
  const cur = await api("GET", "/accounting/settings");
  console.log("profile now:", JSON.stringify(cur.body?.profile || {}).slice(0, 300));
  const r = await api("PUT", "/accounting/settings", { profile: { legalName: "ABC TRADE LLC", trn: "100456789012345", addressLine1: "Warehouse 14, Ras Al Khor Industrial Area 2", city: "Dubai", emirate: "Dubai", vatRegistered: true } });
  console.log("PUT", r.status, r.ok, r.code || "", r.message || "");
  const after = await api("GET", "/accounting/settings");
  console.log("profile after:", JSON.stringify(after.body?.profile || {}).slice(0, 300));
})().catch((e) => console.log("FAILED", e.message));
