'use strict';

const { HttpError } = require('./auth');

/**
 * Core stock ledger operations. Every change to on-hand quantities goes
 * through here so the stock tables and the movements ledger never drift.
 * Callers are expected to wrap multi-step operations in db.tx().
 */

function productLabel(db, productId) {
  const p = db.prepare('SELECT sku, name FROM products WHERE id = ?').get(productId);
  return p ? `${p.sku} (${p.name})` : `product #${productId}`;
}

function warehouseQty(db, productId, warehouseId) {
  const row = db.prepare('SELECT qty FROM stock WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId);
  return row ? row.qty : 0;
}

function fieldQty(db, productId, promoterId, campaignId) {
  const row = db
    .prepare('SELECT qty FROM field_stock WHERE product_id = ? AND promoter_id = ? AND campaign_id = ?')
    .get(productId, promoterId, campaignId);
  return row ? row.qty : 0;
}

function changeWarehouse(db, productId, warehouseId, delta) {
  const current = warehouseQty(db, productId, warehouseId);
  if (current + delta < 0) {
    const wh = db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouseId);
    throw new HttpError(
      409,
      `Not enough stock of ${productLabel(db, productId)} in ${wh ? wh.name : 'warehouse'}: ${current} on hand, ${-delta} needed`,
    );
  }
  const updated = db
    .prepare('UPDATE stock SET qty = qty + ? WHERE product_id = ? AND warehouse_id = ?')
    .run(delta, productId, warehouseId);
  if (updated.changes === 0) {
    db.prepare('INSERT INTO stock (product_id, warehouse_id, qty) VALUES (?, ?, ?)').run(productId, warehouseId, delta);
  }
}

function changeField(db, productId, promoterId, campaignId, delta) {
  const current = fieldQty(db, productId, promoterId, campaignId);
  if (current + delta < 0) {
    throw new HttpError(
      409,
      `Promoter only holds ${current} of ${productLabel(db, productId)} for this campaign, ${-delta} needed`,
    );
  }
  const updated = db
    .prepare('UPDATE field_stock SET qty = qty + ? WHERE product_id = ? AND promoter_id = ? AND campaign_id = ?')
    .run(delta, productId, promoterId, campaignId);
  if (updated.changes === 0) {
    db.prepare('INSERT INTO field_stock (product_id, promoter_id, campaign_id, qty) VALUES (?, ?, ?, ?)').run(
      productId,
      promoterId,
      campaignId,
      delta,
    );
  }
}

function record(db, m) {
  db.prepare(
    `INSERT INTO movements (type, product_id, qty, from_warehouse_id, to_warehouse_id, promoter_id, campaign_id, reference, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.type,
    m.productId,
    m.qty,
    m.fromWarehouseId ?? null,
    m.toWarehouseId ?? null,
    m.promoterId ?? null,
    m.campaignId ?? null,
    m.reference ?? null,
    m.note ?? null,
    m.userId,
  );
}

/** Goods received into a warehouse from a client or supplier. */
function receive(db, { productId, warehouseId, qty, reference, note, userId }) {
  changeWarehouse(db, productId, warehouseId, qty);
  record(db, { type: 'receipt', productId, qty, toWarehouseId: warehouseId, reference, note, userId });
}

/** Move stock between two warehouses (e.g. JHB -> CPT). */
function transfer(db, { productId, fromWarehouseId, toWarehouseId, qty, reference, note, userId }) {
  if (fromWarehouseId === toWarehouseId) throw new HttpError(400, 'Choose two different warehouses');
  changeWarehouse(db, productId, fromWarehouseId, -qty);
  changeWarehouse(db, productId, toWarehouseId, qty);
  record(db, { type: 'transfer', productId, qty, fromWarehouseId, toWarehouseId, reference, note, userId });
}

/** Stock-take correction: set the counted quantity, ledger records the difference. */
function adjustTo(db, { productId, warehouseId, countedQty, note, userId }) {
  const delta = countedQty - warehouseQty(db, productId, warehouseId);
  if (delta === 0) return 0;
  changeWarehouse(db, productId, warehouseId, delta);
  record(db, { type: 'adjustment', productId, qty: delta, toWarehouseId: warehouseId, reference: 'STOCK-TAKE', note, userId });
  return delta;
}

/** Warehouse sends stock out to a promoter for a campaign. */
function dispatch(db, { productId, warehouseId, promoterId, campaignId, qty, reference, userId }) {
  changeWarehouse(db, productId, warehouseId, -qty);
  changeField(db, productId, promoterId, campaignId, qty);
  record(db, { type: 'dispatch', productId, qty, fromWarehouseId: warehouseId, promoterId, campaignId, reference, userId });
}

/** Promoter stock comes back into a warehouse. Damaged units are written off. */
function returnToWarehouse(db, { productId, warehouseId, promoterId, campaignId, qtyGood, qtyDamaged, reference, userId }) {
  changeField(db, productId, promoterId, campaignId, -(qtyGood + qtyDamaged));
  if (qtyGood > 0) {
    changeWarehouse(db, productId, warehouseId, qtyGood);
    record(db, { type: 'return', productId, qty: qtyGood, toWarehouseId: warehouseId, promoterId, campaignId, reference, userId });
  }
  if (qtyDamaged > 0) {
    record(db, { type: 'damage', productId, qty: qtyDamaged, promoterId, campaignId, reference, note: 'Damaged on return', userId });
  }
}

/** Promoter hands out / uses stock at an activation. */
function consume(db, { productId, promoterId, campaignId, qtyUsed, qtyDamaged, reference, userId }) {
  changeField(db, productId, promoterId, campaignId, -(qtyUsed + qtyDamaged));
  if (qtyUsed > 0) record(db, { type: 'usage', productId, qty: qtyUsed, promoterId, campaignId, reference, userId });
  if (qtyDamaged > 0) {
    record(db, { type: 'damage', productId, qty: qtyDamaged, promoterId, campaignId, reference, note: 'Damaged in field', userId });
  }
}

module.exports = {
  warehouseQty,
  fieldQty,
  receive,
  transfer,
  adjustTo,
  dispatch,
  returnToWarehouse,
  consume,
};
