'use strict';

const { HttpError } = require('./auth');

/**
 * Core stock ledger operations. Every change to on-hand quantities goes
 * through here so the stock tables and the movements ledger never drift.
 * Callers are expected to wrap multi-step operations in db.tx().
 *
 * Products with tracks_expiry hold their warehouse stock in stock_batches;
 * stock.qty is always the sum of the batches. Outgoing stock is taken
 * first-expiry-first-out, and dispatches skip expired batches.
 */

/** Today's date in South Africa, YYYY-MM-DD. */
function saToday(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(d);
}

async function productInfo(db, productId) {
  const p = (await db.get('SELECT id, sku, name, category, tracks_expiry FROM products WHERE id = ?', productId));
  if (!p) throw new HttpError(400, `Product #${productId} not found`);
  return p;
}

const label = (p) => `${p.sku} (${p.name})`;

async function warehouseQty(db, productId, warehouseId) {
  const row = (await db.get('SELECT qty FROM stock WHERE product_id = ? AND warehouse_id = ?', productId, warehouseId));
  return row ? row.qty : 0;
}

/** Units in a warehouse that are past their expiry date. */
async function expiredQty(db, productId, warehouseId) {
  return (await db.get(`SELECT COALESCE(SUM(qty), 0) AS n FROM stock_batches
       WHERE product_id = ? AND warehouse_id = ? AND expiry_date IS NOT NULL AND expiry_date < ?`, productId, warehouseId, saToday())).n;
}

async function fieldQty(db, productId, promoterId, campaignId) {
  const row = (await db.get('SELECT qty FROM field_stock WHERE product_id = ? AND promoter_id = ? AND campaign_id = ?', productId, promoterId, campaignId));
  return row ? row.qty : 0;
}

async function laundryQty(db, productId, warehouseId) {
  const row = (await db.get('SELECT qty FROM laundry_stock WHERE product_id = ? AND warehouse_id = ?', productId, warehouseId));
  return row ? row.qty : 0;
}

/** Add delta to a quantity row, creating it if needed. (UPSERT can't be used: CHECK fires before conflict resolution.) */
async function bump(db, table, keys, delta) {
  const cols = Object.keys(keys);
  const where = cols.map((c) => `${c} = ?`).join(' AND ');
  const updated = (await db.run(`UPDATE ${table} SET qty = qty + ? WHERE ${where}`, delta, ...Object.values(keys)));
  if (updated.changes === 0) {
    (await db.run(`INSERT INTO ${table} (${cols.join(', ')}, qty) VALUES (${cols.map(() => '?').join(', ')}, ?)`, ...Object.values(keys),
      delta));
  }
}

async function addBatch(db, productId, warehouseId, batchNo, expiryDate, qty) {
  const existing = (await db.get('SELECT id, expiry_date FROM stock_batches WHERE product_id = ? AND warehouse_id = ? AND batch_no = ?', productId, warehouseId, batchNo));
  if (existing) {
    (await db.run('UPDATE stock_batches SET qty = qty + ?, expiry_date = COALESCE(expiry_date, ?) WHERE id = ?', qty,
      expiryDate,
      existing.id));
  } else {
    (await db.run('INSERT INTO stock_batches (product_id, warehouse_id, batch_no, expiry_date, qty) VALUES (?, ?, ?, ?, ?)', productId,
      warehouseId,
      batchNo,
      expiryDate,
      qty));
  }
}

/** Remove qty from batches, earliest expiry first. Returns the batches taken. */
async function takeBatches(db, p, warehouseId, qty, { skipExpired }) {
  const rows = (await db.all(`SELECT id, batch_no, expiry_date, qty FROM stock_batches
       WHERE product_id = ? AND warehouse_id = ? AND qty > 0 ${skipExpired ? 'AND (expiry_date IS NULL OR expiry_date >= ?)' : ''}
       ORDER BY expiry_date IS NULL, expiry_date, id`, ...(skipExpired ? [p.id, warehouseId, saToday()] : [p.id, warehouseId])));
  const usable = rows.reduce((n, r) => n + r.qty, 0);
  if (usable < qty) {
    throw new HttpError(409, `Only ${usable} unexpired units of ${label(p)} in that warehouse, ${qty} needed`);
  }
  const parts = [];
  let remaining = qty;
  for (const r of rows) {
    if (remaining === 0) break;
    const take = Math.min(r.qty, remaining);
    (await db.run('UPDATE stock_batches SET qty = qty - ? WHERE id = ?', take, r.id));
    parts.push({ batchNo: r.batch_no, expiryDate: r.expiry_date, qty: take });
    remaining -= take;
  }
  (await db.run('DELETE FROM stock_batches WHERE qty = 0'));
  return parts;
}

/**
 * Change warehouse stock by delta. Returns the batch parts affected as
 * [{batchNo, expiryDate, qty}] with positive quantities.
 */
async function changeWarehouse(db, productId, warehouseId, delta, { batchNo, expiryDate, skipExpired = false } = {}) {
  const p = await productInfo(db, productId);
  const current = await warehouseQty(db, productId, warehouseId);
  if (current + delta < 0) {
    const wh = (await db.get('SELECT name FROM warehouses WHERE id = ?', warehouseId));
    throw new HttpError(409, `Not enough stock of ${label(p)} in ${wh ? wh.name : 'warehouse'}: ${current} on hand, ${-delta} needed`);
  }
  let parts;
  if (!p.tracks_expiry) {
    parts = [{ batchNo: null, expiryDate: null, qty: Math.abs(delta) }];
  } else if (delta > 0) {
    const batch = batchNo || 'UNBATCHED';
    await addBatch(db, productId, warehouseId, batch, expiryDate || null, delta);
    parts = [{ batchNo: batch, expiryDate: expiryDate || null, qty: delta }];
  } else {
    parts = await takeBatches(db, p, warehouseId, -delta, { skipExpired });
  }
  await bump(db, 'stock', { product_id: productId, warehouse_id: warehouseId }, delta);
  return parts;
}

async function changeField(db, productId, promoterId, campaignId, delta) {
  const current = await fieldQty(db, productId, promoterId, campaignId);
  if (current + delta < 0) {
    const p = await productInfo(db, productId);
    throw new HttpError(409, `Promoter only holds ${current} of ${label(p)} for this campaign, ${-delta} needed`);
  }
  await bump(db, 'field_stock', { product_id: productId, promoter_id: promoterId, campaign_id: campaignId }, delta);
}

async function record(db, m) {
  (await db.run(`INSERT INTO movements (type, product_id, qty, from_warehouse_id, to_warehouse_id, promoter_id, campaign_id,
       batch_no, expiry_date, reference, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.type,
    m.productId,
    m.qty,
    m.fromWarehouseId ?? null,
    m.toWarehouseId ?? null,
    m.promoterId ?? null,
    m.campaignId ?? null,
    m.batchNo ?? null,
    m.expiryDate ?? null,
    m.reference ?? null,
    m.note ?? null,
    m.userId));
}

/** Goods received into a warehouse from a client or supplier. */
async function receive(db, { productId, warehouseId, qty, batchNo, expiryDate, reference, note, userId }) {
  const p = await productInfo(db, productId);
  if (p.tracks_expiry && !expiryDate) throw new HttpError(400, `${p.sku} needs an expiry date`);
  const parts = await changeWarehouse(db, productId, warehouseId, qty, { batchNo: batchNo || reference, expiryDate });
  for (const part of parts) {
    await record(db, { type: 'receipt', productId, qty: part.qty, toWarehouseId: warehouseId, batchNo: part.batchNo, expiryDate: part.expiryDate, reference, note, userId });
  }
}

/** Move stock between two warehouses (e.g. JHB -> CPT). Batches travel with the stock. */
async function transfer(db, { productId, fromWarehouseId, toWarehouseId, qty, reference, note, userId }) {
  if (fromWarehouseId === toWarehouseId) throw new HttpError(400, 'Choose two different warehouses');
  for (const part of await changeWarehouse(db, productId, fromWarehouseId, -qty)) {
    await changeWarehouse(db, productId, toWarehouseId, part.qty, part);
    await record(db, { type: 'transfer', productId, qty: part.qty, fromWarehouseId, toWarehouseId, batchNo: part.batchNo, expiryDate: part.expiryDate, reference, note, userId });
  }
}

/** Count correction by a known difference (found +, missing -). The ledger records it as an adjustment. */
async function adjustBy(db, { productId, warehouseId, delta, reference = 'STOCK-TAKE', note, userId }) {
  if (delta === 0) return 0;
  const parts = await changeWarehouse(db, productId, warehouseId, delta, { batchNo: 'COUNT-ADJ' });
  for (const part of parts) {
    await record(db, {
      type: 'adjustment',
      productId,
      qty: delta > 0 ? part.qty : -part.qty,
      toWarehouseId: warehouseId,
      batchNo: part.batchNo,
      expiryDate: part.expiryDate,
      reference,
      note,
      userId,
    });
  }
  return delta;
}

/** Stock-take correction: set the counted quantity, ledger records the difference. */
async function adjustTo(db, { productId, warehouseId, countedQty, note, userId }) {
  return await adjustBy(db, { productId, warehouseId, delta: countedQty - await warehouseQty(db, productId, warehouseId), note, userId });
}

/** Warehouse sends stock out to a promoter for a campaign. Expired batches are never sent. */
async function dispatch(db, { productId, warehouseId, promoterId, campaignId, qty, reference, userId }) {
  const parts = await changeWarehouse(db, productId, warehouseId, -qty, { skipExpired: true });
  await changeField(db, productId, promoterId, campaignId, qty);
  for (const part of parts) {
    await record(db, { type: 'dispatch', productId, qty: part.qty, fromWarehouseId: warehouseId, promoterId, campaignId, batchNo: part.batchNo, expiryDate: part.expiryDate, reference, userId });
  }
}

/** The batch a promoter's stock most likely came from, so returns keep their expiry date. */
async function lastDispatchedBatch(db, productId, promoterId, campaignId) {
  return (await db.get(`SELECT batch_no AS batchNo, expiry_date AS expiryDate FROM movements
       WHERE type = 'dispatch' AND product_id = ? AND promoter_id = ? AND campaign_id = ? AND batch_no IS NOT NULL
       ORDER BY id DESC LIMIT 1`, productId, promoterId, campaignId));
}

// Ledger notes that tell damage on return apart from damage in the field (the BA form reports them separately)
const DAMAGED_ON_RETURN = 'Damaged on return';
const DAMAGED_IN_FIELD = 'Damaged in field';

/**
 * Promoter stock comes back into a warehouse. Good units go back on the shelf,
 * uniforms that need washing/ironing go to laundry, damaged units are written off.
 */
async function returnToWarehouse(db, { productId, warehouseId, promoterId, campaignId, qtyGood, qtyDamaged, qtyLaundry = 0, reference, userId }) {
  await changeField(db, productId, promoterId, campaignId, -(qtyGood + qtyDamaged + qtyLaundry));
  if (qtyGood > 0) {
    const batch = await lastDispatchedBatch(db, productId, promoterId, campaignId) || { batchNo: 'RETURNED', expiryDate: null };
    for (const part of await changeWarehouse(db, productId, warehouseId, qtyGood, batch)) {
      await record(db, { type: 'return', productId, qty: part.qty, toWarehouseId: warehouseId, promoterId, campaignId, batchNo: part.batchNo, expiryDate: part.expiryDate, reference, userId });
    }
  }
  if (qtyLaundry > 0) {
    await bump(db, 'laundry_stock', { product_id: productId, warehouse_id: warehouseId }, qtyLaundry);
    await record(db, { type: 'laundry', productId, qty: qtyLaundry, toWarehouseId: warehouseId, promoterId, campaignId, reference, note: 'Needs washing / ironing', userId });
  }
  if (qtyDamaged > 0) {
    await record(db, { type: 'damage', productId, qty: qtyDamaged, promoterId, campaignId, reference, note: DAMAGED_ON_RETURN, userId });
  }
}

/** Washed and ironed uniforms go back into usable stock. */
async function launder(db, { productId, warehouseId, qty, userId }) {
  const held = await laundryQty(db, productId, warehouseId);
  if (qty > held) throw new HttpError(409, `Only ${held} of ${label(await productInfo(db, productId))} are at the laundry`);
  await bump(db, 'laundry_stock', { product_id: productId, warehouse_id: warehouseId }, -qty);
  await changeWarehouse(db, productId, warehouseId, qty);
  await record(db, { type: 'laundered', productId, qty, toWarehouseId: warehouseId, reference: 'LAUNDRY', note: 'Clean and ironed', userId });
}

/** Remove every expired unit of a product from a warehouse. Returns units written off. */
async function writeOffExpired(db, { productId, warehouseId, note, userId }) {
  const rows = (await db.all(`SELECT id, batch_no, expiry_date, qty FROM stock_batches
       WHERE product_id = ? AND warehouse_id = ? AND expiry_date IS NOT NULL AND expiry_date < ? AND qty > 0`, productId, warehouseId, saToday()));
  let total = 0;
  for (const r of rows) {
    (await db.run('UPDATE stock_batches SET qty = 0 WHERE id = ?', r.id));
    await bump(db, 'stock', { product_id: productId, warehouse_id: warehouseId }, -r.qty);
    await record(db, { type: 'write_off', productId, qty: r.qty, fromWarehouseId: warehouseId, batchNo: r.batch_no, expiryDate: r.expiry_date, reference: 'EXPIRED', note: note || 'Expired stock written off', userId });
    total += r.qty;
  }
  (await db.run('DELETE FROM stock_batches WHERE qty = 0'));
  return total;
}

/** Promoter hands out / uses stock at an activation. */
async function consume(db, { productId, promoterId, campaignId, qtyUsed, qtyDamaged, reference, userId }) {
  await changeField(db, productId, promoterId, campaignId, -(qtyUsed + qtyDamaged));
  if (qtyUsed > 0) await record(db, { type: 'usage', productId, qty: qtyUsed, promoterId, campaignId, reference, userId });
  if (qtyDamaged > 0) {
    await record(db, { type: 'damage', productId, qty: qtyDamaged, promoterId, campaignId, reference, note: DAMAGED_IN_FIELD, userId });
  }
}

/**
 * Switch expiry tracking on or off for a product. Turning it on puts existing
 * stock into an OPENING batch with no expiry so totals stay consistent.
 */
async function setTracking(db, productId, on) {
  if (on) {
    const levels = (await db.all('SELECT warehouse_id, qty FROM stock WHERE product_id = ? AND qty > 0', productId));
    for (const l of levels) {
      const batched = (await db.get('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_batches WHERE product_id = ? AND warehouse_id = ?', productId, l.warehouse_id)).n;
      if (l.qty > batched) await addBatch(db, productId, l.warehouse_id, 'OPENING', null, l.qty - batched);
    }
  } else {
    (await db.run('DELETE FROM stock_batches WHERE product_id = ?', productId));
  }
}

module.exports = {
  DAMAGED_ON_RETURN,
  DAMAGED_IN_FIELD,
  saToday,
  warehouseQty,
  expiredQty,
  fieldQty,
  laundryQty,
  receive,
  transfer,
  adjustTo,
  adjustBy,
  dispatch,
  returnToWarehouse,
  launder,
  writeOffExpired,
  consume,
  setTracking,
};
