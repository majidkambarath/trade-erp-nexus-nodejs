// The functions behind the data-bleed sweep (tenantBleedHttp.test.js), kept apart from any server or database so that
// leakCrawlerSelfTest.test.js can run the SAME code against a tiny app that leaks on purpose, and prove it catches the leak.
// Test support only: lives in a subfolder, so `npm test` does not run it.
//
//   makeMarkers      what must never appear in another organisation's response (canary strings, distinctive amounts, record ids)
//   findLeaks        scan one response body for those markers
//   crawl            send a list of requests as the SPY and collect every response that leaked, crashed or hung
//   snapshotDiff     compare two snapshots of the victim's data: what the spy must not have changed
const HEX24 = /[0-9a-f]{24}/gi;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * strings: exact text (canary names, the organisation's code, tax numbers, e-mail addresses ...)
 * numbers: distinctive amounts, matched as whole numbers (7391.47 is found in `"price":7391.47`, not in `17391.47`)
 * ids:     every record id the victim owns; a 24-character id in a response is a leak unless the spy put that id in the request
 */
function makeMarkers({ strings = [], numbers = [], ids = [] }) {
  return {
    strings: [...new Set(strings.filter((s) => s && String(s).length >= 4).map(String))],
    numberRes: [...new Set(numbers.map(String))].map((n) => ({ value: n, re: new RegExp(`(?<![\\d.])${escapeRe(n)}(?!\\d)`) })),
    ids: new Set(ids.map((i) => String(i).toLowerCase())),
  };
}

/** Everything in `text` that belongs to the victim. `requestText` is what the spy sent: an id it supplied itself may be echoed back. */
function findLeaks(text, markers, requestText = "") {
  const found = new Set();
  if (!text) return [];
  for (const s of markers.strings) if (text.includes(s)) found.add(`text:${s}`);
  for (const { value, re } of markers.numberRes) if (re.test(text)) found.add(`amount:${value}`);
  const asked = requestText.toLowerCase();
  for (const m of text.matchAll(HEX24)) {
    const id = m[0].toLowerCase();
    if (markers.ids.has(id) && !asked.includes(id)) found.add(`id:${id}`);
  }
  return [...found];
}

/**
 * Send every request in `requests` ({ method, url, body?, headers?, label? }) with `call`, `concurrency` at a time, and
 * report. A response leaks when findLeaks finds a marker in it. `slowMs` flags a request that hung (a regex that never ends).
 * -> { sent, leaks: [{ label, status, found }], serverErrors: [{ label, status }], slow: [{ label, ms }], statuses: { 404: n, ... } }
 */
async function crawl({ call, requests, token, markers, concurrency = 12, slowMs = 8000, pool }) {
  const run = pool || (async (items, limit, fn) => {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
    }));
    return out;
  });
  const rows = await run(requests, concurrency, async (r) => {
    const res = await call(r.method, r.url, { token, body: r.body, headers: r.headers, form: r.form });
    const sent = `${r.url} ${r.body === undefined ? "" : JSON.stringify(r.body)} ${JSON.stringify(r.headers || {})}`;
    return { r, res, found: findLeaks(res.text, markers, sent) };
  });
  const out = { sent: rows.length, leaks: [], serverErrors: [], slow: [], statuses: {}, rows };
  for (const { r, res, found } of rows) {
    const label = r.label || `${r.method} ${r.url}`;
    out.statuses[res.status] = (out.statuses[res.status] || 0) + 1;
    if (found.length) out.leaks.push({ label, status: res.status, found });
    if (res.status >= 500 || res.status === 0) out.serverErrors.push({ label, status: res.status, text: String(res.text).slice(0, 140) });
    if (res.ms > slowMs) out.slow.push({ label, ms: res.ms });
  }
  return out;
}

/** What changed between two snapshots ({ collection: { count, digest } }). Empty means nothing changed. */
function snapshotDiff(before, after) {
  const changes = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[name] || { count: 0, digest: "" };
    const b = after[name] || { count: 0, digest: "" };
    if (a.count !== b.count) changes.push(`${name}: ${a.count} -> ${b.count} documents`);
    else if (a.digest !== b.digest) changes.push(`${name}: same ${a.count} documents, content changed`);
  }
  return changes;
}

/** Fill a route's :params from `valuesFor(name)` (a list), taking the product but never more than `cap` URLs. */
function expandPath(path, valuesFor, cap = 12) {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  let combos = [{}];
  for (const n of names) {
    const options = valuesFor(n);
    const next = [];
    for (const c of combos) for (const v of options) { next.push({ ...c, [n]: v }); if (next.length >= cap * 4) break; }
    combos = next;
  }
  const seen = new Set();
  const urls = [];
  for (const c of combos) {
    const u = path.replace(/:([A-Za-z0-9_]+)/g, (_, n) => encodeURIComponent(c[n]));
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
    if (urls.length >= cap) break;
  }
  return urls;
}

module.exports = { makeMarkers, findLeaks, crawl, snapshotDiff, expandPath, HEX24 };
