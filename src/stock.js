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

function productInfo(db, productId) {
  const p = db.prepare('SELECT id, sku, name, category, tracks_expiry FROM products WHERE id = ?').get(productId);
  if (!p) throw new HttpError(400, `Product #${productId} not found`);
  return p;
}

const label = (p) => `${p.sku} (${p.name})`;

function warehouseQty(db, productId, warehouseId) {
  const row = db.prepare('SELECT qty FROM stock WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId);
  return row ? row.qty : 0;
}

/** Units in a warehouse that are past their expiry date. */
function expiredQty(db, productId, warehouseId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS n FROM stock_batches
       WHERE product_id = ? AND warehouse_id = ? AND expiry_date IS NOT NULL AND expiry_date < ?`,
    )
    .get(productId, warehouseId, saToday()).n;
}

function fieldQty(db, productId, promoterId, campaignId) {
  const row = db
    .prepare('SELECT qty FROM field_stock WHERE product_id = ? AND promoter_id = ? AND campaign_id = ?')
    .get(productId, promoterId, campaignId);
  return row ? row.qty : 0;
}

function laundryQty(db, productId, warehouseId) {
  const row = db.prepare('SELECT qty FROM laundry_stock WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId);
  return row ? row.qty : 0;
}

/** Add delta to a quantity row, creating it if needed. (UPSERT can't be used: CHECK fires before conflict resolution.) */
function bump(db, table, keys, delta) {
  const cols = Object.keys(keys);
  const where = cols.map((c) => `${c} = ?`).join(' AND ');
  const updated = db.prepare(`UPDATE ${table} SET qty = qty + ? WHERE ${where}`).run(delta, ...Object.values(keys));
  if (updated.changes === 0) {
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}, qty) VALUES (${cols.map(() => '?').join(', ')}, ?)`).run(
      ...Object.values(keys),
      delta,
    );
  }
}

function addBatch(db, productId, warehouseId, batchNo, expiryDate, qty) {
  const existing = db
    .prepare('SELECT id, expiry_date FROM stock_batches WHERE product_id = ? AND warehouse_id = ? AND batch_no = ?')
    .get(productId, warehouseId, batchNo);
  if (existing) {
    db.prepare('UPDATE stock_batches SET qty = qty + ?, expiry_date = COALESCE(expiry_date, ?) WHERE id = ?').run(
      qty,
      expiryDate,
      existing.id,
    );
  } else {
    db.prepare('INSERT INTO stock_batches (product_id, warehouse_id, batch_no, expiry_date, qty) VALUES (?, ?, ?, ?, ?)').run(
      productId,
      warehouseId,
      batchNo,
      expiryDate,
      qty,
    );
  }
}

/** Remove qty from batches, earliest expiry first. Returns the batches taken. */
function takeBatches(db, p, warehouseId, qty, { skipExpired }) {
  const rows = db
    .prepare(
      `SELECT id, batch_no, expiry_date, qty FROM stock_batches
       WHERE product_id = ? AND warehouse_id = ? AND qty > 0 ${skipExpired ? 'AND (expiry_date IS NULL OR expiry_date >= ?)' : ''}
       ORDER BY expiry_date IS NULL, expiry_date, id`,
    )
    .all(...(skipExpired ? [p.id, warehouseId, saToday()] : [p.id, warehouseId]));
  const usable = rows.reduce((n, r) => n + r.qty, 0);
  if (usable < qty) {
    throw new HttpError(409, `Only ${usable} unexpired units of ${label(p)} in that warehouse, ${qty} needed`);
  }
  const parts = [];
  let remaining = qty;
  for (const r of rows) {
    if (remaining === 0) break;
    const take = Math.min(r.qty, remaining);
    db.prepare('UPDATE stock_batches SET qty = qty - ? WHERE id = ?').run(take, r.id);
    parts.push({ batchNo: r.batch_no, expiryDate: r.expiry_date, qty: take });
    remaining -= take;
  }
  db.prepare('DELETE FROM stock_batches WHERE qty = 0').run();
  return parts;
}

/**
 * Change warehouse stock by delta. Returns the batch parts affected as
 * [{batchNo, expiryDate, qty}] with positive quantities.
 */
function changeWarehouse(db, productId, warehouseId, delta, { batchNo, expiryDate, skipExpired = false } = {}) {
  const p = productInfo(db, productId);
  const current = warehouseQty(db, productId, warehouseId);
  if (current + delta < 0) {
    const wh = db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouseId);
    throw new HttpError(409, `Not enough stock of ${label(p)} in ${wh ? wh.name : 'warehouse'}: ${current} on hand, ${-delta} needed`);
  }
  let parts;
  if (!p.tracks_expiry) {
    parts = [{ batchNo: null, expiryDate: null, qty: Math.abs(delta) }];
  } else if (delta > 0) {
    const batch = batchNo || 'UNBATCHED';
    addBatch(db, productId, warehouseId, batch, expiryDate || null, delta);
    parts = [{ batchNo: batch, expiryDate: expiryDate || null, qty: delta }];
  } else {
    parts = takeBatches(db, p, warehouseId, -delta, { skipExpired });
  }
  bump(db, 'stock', { product_id: productId, warehouse_id: warehouseId }, delta);
  return parts;
}

function changeField(db, productId, promoterId, campaignId, delta) {
  const current = fieldQty(db, productId, promoterId, campaignId);
  if (current + delta < 0) {
    const p = productInfo(db, productId);
    throw new HttpError(409, `Promoter only holds ${current} of ${label(p)} for this campaign, ${-delta} needed`);
  }
  bump(db, 'field_stock', { product_id: productId, promoter_id: promoterId, campaign_id: campaignId }, delta);
}

function record(db, m) {
  db.prepare(
    `INSERT INTO movements (type, product_id, qty, from_warehouse_id, to_warehouse_id, promoter_id, campaign_id,
       batch_no, expiry_date, reference, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.type,
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
    m.userId,
  );
}

/** Goods received into a warehouse from a client or supplier. */
function receive(db, { productId, warehouseId, qty, batchNo, expiryDate, reference, note, userId }) {
  const p = productInfo(db, productId);
  if (p.tracks_expiry && !expiryDate) throw new HttpError(400, `${p.sku} needs an expiry date`);
  const parts = changeWarehouse(db, productId, warehouseId, qty, { batchNo: batchNo || reference, expiryDate });
  for (const part of parts) {
    record(db, { type: 'receipt', productId, qty: part.qty, toWarehouseId: warehouseId, batchNo: part.batchNo, expiryDate: part.expiryDate, reference, note, userId });
  }
}

/** Move stock between two warehouses (e.g. JHB -> CPT). Batches travel with the stock. */
function transfer(db, { productId, fromWarehouseId, toWarehouseId, qty, reference, note, userId }) {
  if (fromWarehouseId === toWarehouseId) throw new HttpError(400, 'Choose two different warehouses');
  for (const part of changeWarehouse(db, productId, fromWarehouseId, -qty)) {
    changeWarehouse(db, productId, toWarehouseId, part.qty, part);
    record(db, { type: 'transfer', productId, qty: part.qty, fromWarehouseId, toWarehouseId, batchNo: part.batchNo, expiryDate: part.expiryDate, reference, note, userId });
  }
}

/** Stock-take correction: set the counted quantity, ledger records the difference. */
function adjustTo(db, { productId, warehouseId, countedQty, note, userId }) {
  const delta = countedQty - warehouseQty(db, productId, warehouseId);
  if (delta === 0) return 0;
  const parts = changeWarehouse(db, productId, warehouseId, delta, { batchNo: 'COUNT-ADJ' });
  for (const part of parts) {
    record(db, {
      type: 'adjustment',
      productId,
      qty: delta > 0 ? part.qty : -part.qty,
      toWarehouseId: warehouseId,
      batchNo: part.batchNo,
      expiryDate: part.expiryDate,
      reference: 'STOCK-TAKE',
      note,
      userId,
    });
  }
  return delta;
}

/** Warehouse sends stock out to a promoter for a campaign. Expired batches are never sent. */
function dispatch(db, { productId, warehouseId, promoterId, campaignId, qty, reference, userId }) {
  const parts = changeWarehouse(db, productId, warehouseId, -qty, { skipExpired: true });
  changeField(db, productId, promoterId, campaignId, qty);
  for (const part of parts) {
    record(db, { type: 'dispatch', productId, qty: part.qty, fromWarehouseId: warehouseId, promoterId, campaignId, batchNo: part.batchNo, expiryDate: part.expiryDate, reference, userId });
  }
}

/** The batch a promoter's stock most likely came from, so returns keep their expiry date. */
function lastDispatchedBatch(db, productId, promoterId, campaignId) {
  return db
    .prepare(
      `SELECT batch_no AS batchNo, expiry_date AS expiryDate FROM movements
       WHERE type = 'dispatch' AND product_id = ? AND promoter_id = ? AND campaign_id = ? AND batch_no IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(productId, promoterId, campaignId);
}

/**
 * Promoter stock comes back into a warehouse. Good units go back on the shelf,
 * uniforms that need washing/ironing go to laundry, damaged units are written off.
 */
function returnToWarehouse(db, { productId, warehouseId, promoterId, campaignId, qtyGood, qtyDamaged, qtyLaundry = 0, reference, userId }) {
  changeField(db, productId, promoterId, campaignId, -(qtyGood + qtyDamaged + qtyLaundry));
  if (qtyGood > 0) {
    const batch = lastDispatchedBatch(db, productId, promoterId, campaignId) || { batchNo: 'RETURNED', expiryDate: null };
    for (const part of changeWarehouse(db, productId, warehouseId, qtyGood, batch)) {
      record(db, { type: 'return', productId, qty: part.qty, toWarehouseId: warehouseId, promoterId, campaignId, batchNo: part.batchNo, expiryDate: part.expiryDate, reference, userId });
    }
  }
  if (qtyLaundry > 0) {
    bump(db, 'laundry_stock', { product_id: productId, warehouse_id: warehouseId }, qtyLaundry);
    record(db, { type: 'laundry', productId, qty: qtyLaundry, toWarehouseId: warehouseId, promoterId, campaignId, reference, note: 'Needs washing / ironing', userId });
  }
  if (qtyDamaged > 0) {
    record(db, { type: 'damage', productId, qty: qtyDamaged, promoterId, campaignId, reference, note: 'Damaged on return', userId });
  }
}

/** Washed and ironed uniforms go back into usable stock. */
function launder(db, { productId, warehouseId, qty, userId }) {
  const held = laundryQty(db, productId, warehouseId);
  if (qty > held) throw new HttpError(409, `Only ${held} of ${label(productInfo(db, productId))} are at the laundry`);
  bump(db, 'laundry_stock', { product_id: productId, warehouse_id: warehouseId }, -qty);
  changeWarehouse(db, productId, warehouseId, qty);
  record(db, { type: 'laundered', productId, qty, toWarehouseId: warehouseId, reference: 'LAUNDRY', note: 'Clean and ironed', userId });
}

/** Remove every expired unit of a product from a warehouse. Returns units written off. */
function writeOffExpired(db, { productId, warehouseId, note, userId }) {
  const rows = db
    .prepare(
      `SELECT id, batch_no, expiry_date, qty FROM stock_batches
       WHERE product_id = ? AND warehouse_id = ? AND expiry_date IS NOT NULL AND expiry_date < ? AND qty > 0`,
    )
    .all(productId, warehouseId, saToday());
  let total = 0;
  for (const r of rows) {
    db.prepare('UPDATE stock_batches SET qty = 0 WHERE id = ?').run(r.id);
    bump(db, 'stock', { product_id: productId, warehouse_id: warehouseId }, -r.qty);
    record(db, { type: 'write_off', productId, qty: r.qty, fromWarehouseId: warehouseId, batchNo: r.batch_no, expiryDate: r.expiry_date, reference: 'EXPIRED', note: note || 'Expired stock written off', userId });
    total += r.qty;
  }
  db.prepare('DELETE FROM stock_batches WHERE qty = 0').run();
  return total;
}

/** Promoter hands out / uses stock at an activation. */
function consume(db, { productId, promoterId, campaignId, qtyUsed, qtyDamaged, reference, userId }) {
  changeField(db, productId, promoterId, campaignId, -(qtyUsed + qtyDamaged));
  if (qtyUsed > 0) record(db, { type: 'usage', productId, qty: qtyUsed, promoterId, campaignId, reference, userId });
  if (qtyDamaged > 0) {
    record(db, { type: 'damage', productId, qty: qtyDamaged, promoterId, campaignId, reference, note: 'Damaged in field', userId });
  }
}

/**
 * Switch expiry tracking on or off for a product. Turning it on puts existing
 * stock into an OPENING batch with no expiry so totals stay consistent.
 */
function setTracking(db, productId, on) {
  if (on) {
    const levels = db.prepare('SELECT warehouse_id, qty FROM stock WHERE product_id = ? AND qty > 0').all(productId);
    for (const l of levels) {
      const batched = db
        .prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM stock_batches WHERE product_id = ? AND warehouse_id = ?')
        .get(productId, l.warehouse_id).n;
      if (l.qty > batched) addBatch(db, productId, l.warehouse_id, 'OPENING', null, l.qty - batched);
    }
  } else {
    db.prepare('DELETE FROM stock_batches WHERE product_id = ?').run(productId);
  }
}

module.exports = {
  saToday,
  warehouseQty,
  expiredQty,
  fieldQty,
  laundryQty,
  receive,
  transfer,
  adjustTo,
  dispatch,
  returnToWarehouse,
  launder,
  writeOffExpired,
  consume,
  setTracking,
};
