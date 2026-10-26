'use strict';

const { HttpError, isStockApprover } = require('./auth');
const v = require('./validate');

/**
 * Label codes. The part before the first '|' is what the system reads; anything
 * after it is readable text (name, pack size, expiry) so an ordinary phone
 * camera shows what the label is.
 *   JRP:<SKU>[:<batch>]          one unit
 *   JRK:<SKU>:<qty>[:<batch>]    a pack (6-pack, box of 24…) counts as <qty> units
 * A pack's or product's printed barcode (from the supplier) works too.
 */
const codePart = (raw) => String(raw || '').split('|')[0].trim();

async function resolveStockCode(db, raw) {
  const code = codePart(raw);
  const bySku = async (sku) => (await db.get('SELECT id, sku, name, category FROM products WHERE sku = ?', String(sku || '').toUpperCase()));
  const byId = async (id) => (await db.get('SELECT id, sku, name, category FROM products WHERE id = ?', id));
  const [prefix, a, b, c] = code.split(':');
  if (prefix === 'JRK') {
    const product = await bySku(a);
    const pack = product && (await db.get('SELECT * FROM product_packs WHERE product_id = ? AND qty = ? AND active = 1', product.id, Number(b)));
    return pack ? { product, pack, units: pack.qty, batch_no: c || null } : null;
  }
  if (prefix === 'JRP') {
    const product = await bySku(a);
    return product ? { product, pack: null, units: 1, batch_no: b || null } : null;
  }
  if (code.includes(':')) return null;
  const pack = (await db.get('SELECT * FROM product_packs WHERE barcode = ? AND active = 1', code));
  if (pack) return { product: await byId(pack.product_id), pack, units: pack.qty, batch_no: null };
  const product = await bySku(code) || (await db.get('SELECT id, sku, name, category FROM products WHERE barcode = ?', code));
  return product ? { product, pack: null, units: 1, batch_no: null } : null;
}

/**
 * Stock leaving the warehouse must be scanned out. `expected` maps product id to
 * units going out; `scans` is every code scanned, in order. If the scans don't add
 * up, only a stock approver (warehouse manager, office, director) can release it,
 * with a reason. Call inside the transaction that moves the stock.
 */
async function checkScansOut(db, user, { kind, reference, warehouseId, expected, scans, override }) {
  if (scans !== undefined && !Array.isArray(scans)) throw new HttpError(400, 'Scans must be a list');
  const list = (scans || []).map((s) => v.str(s, 'Scanned code', { required: true, max: 200 }));
  if (list.length > 10000) throw new HttpError(400, 'Too many scans');
  const resolved = [];
  for (const code of list) {
    const hit = await resolveStockCode(db, code);
    if (!hit) throw new HttpError(400, `Unknown label "${codePart(code)}"`);
    resolved.push({ code: codePart(code), ...hit });
  }
  const scanned = new Map();
  for (const s of resolved) scanned.set(s.product.id, (scanned.get(s.product.id) || 0) + s.units);

  const differences = [];
  const sku = async (id) => ((await db.get('SELECT sku FROM products WHERE id = ?', id)) || {}).sku || `#${id}`;
  for (const id of new Set([...expected.keys(), ...scanned.keys()])) {
    const want = expected.get(id) || 0;
    const got = scanned.get(id) || 0;
    if (want !== got) differences.push(want ? `${await sku(id)}: scanned ${got} of ${want}` : `${await sku(id)}: ${got} scanned but not going out`);
  }
  const reason = v.str(override, 'Reason for releasing without a full scan', { max: 300 });
  if (differences.length) {
    if (!reason) throw new HttpError(409, `Scan check: ${differences.join('; ')}. Scan every item or pack going out.`);
    if (!isStockApprover(user)) throw new HttpError(403, 'Only the warehouse manager can release stock that was not fully scanned');
  }

  const ins = db.stmt(
    'INSERT INTO scans_out (kind, reference, warehouse_id, code, product_id, pack_id, units, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const s of resolved) await ins.run(kind, reference, warehouseId, s.code, s.product.id, s.pack ? s.pack.id : null, s.units, user.id);
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  (await db.run(`INSERT INTO scan_checks (kind, reference, warehouse_id, expected_units, scanned_units, matched, override_reason, differences, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, kind, reference, warehouseId, sum(expected), sum(scanned), differences.length ? 0 : 1, differences.length ? reason : null, differences.join('; ') || null, user.id));
}

/** The latest scan check for a load-out, for display. */
async function scanCheckFor(db, kind, reference) {
  return (
    (await db.get(`SELECT sc.*, u.name AS user_name FROM scan_checks sc JOIN users u ON u.id = sc.user_id
         WHERE sc.kind = ? AND sc.reference = ? ORDER BY sc.id DESC LIMIT 1`, kind, reference)) || null
  );
}

module.exports = { codePart, resolveStockCode, checkScansOut, scanCheckFor };
