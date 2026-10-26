'use strict';

const express = require('express');
const { MANAGEMENT, WAREHOUSE, STOCK_APPROVERS, HttpError, allow, isStockApprover } = require('../auth');
const v = require('../validate');
const stock = require('../stock');
const { tx } = require('../db');

/**
 * Controlled stock counts.
 *
 *  1. A count lists products in one warehouse and is assigned to one person.
 *  2. They count blind: the system quantity is never shown while the count is open.
 *  3. On submit the system compares. Differences within the tolerance are adjusted
 *     straight away; bigger ones wait for a manager.
 *  4. A manager approves (stock is adjusted) or rejects / asks for a recount.
 *     Nobody can approve a count they did themselves, except a director.
 */

const COUNTERS = [MANAGEMENT, WAREHOUSE];

function getSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'count_%'").all();
  const map = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return { tolerance_units: map.count_tolerance_units ?? 0, tolerance_value: map.count_tolerance_value ?? 0 };
}

function nextRef(db) {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM stock_counts').get();
  return `CNT-${String(row.n).padStart(5, '0')}`;
}

const COUNT_SELECT = `
  SELECT sc.*, w.name AS warehouse_name, a.name AS assigned_name, cb.name AS created_by_name,
    (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = sc.id) AS lines,
    (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = sc.id AND l.counted_qty IS NOT NULL) AS counted_lines,
    (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = sc.id AND l.status = 'pending') AS pending_lines,
    (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = sc.id AND l.variance != 0) AS variance_lines,
    (SELECT COALESCE(SUM(l.variance * l.unit_cost), 0) FROM count_lines l WHERE l.count_id = sc.id
       AND l.status IN ('auto','approved')) AS adjusted_value
  FROM stock_counts sc
  JOIN warehouses w ON w.id = sc.warehouse_id
  JOIN users a ON a.id = sc.assigned_to
  JOIN users cb ON cb.id = sc.created_by`;

/** Warehouse staff only see counts assigned to them; managers see all. */
function countScope(user) {
  if (isStockApprover(user)) return { sql: '1=1', params: [] };
  return { sql: 'sc.assigned_to = ?', params: [user.id] };
}

function loadCount(db, user, id) {
  const scope = countScope(user);
  const count = v.found(db.prepare(`${COUNT_SELECT} WHERE sc.id = ? AND ${scope.sql}`).get(id, ...scope.params), 'Count');
  const approver = isStockApprover(user);
  count.items = db
    .prepare(
      `SELECT l.*, p.sku, p.name AS product_name, p.unit, p.category, p.barcode, d.name AS decided_by_name
       FROM count_lines l JOIN products p ON p.id = l.product_id LEFT JOIN users d ON d.id = l.decided_by
       WHERE l.count_id = ? ORDER BY l.bin IS NULL, l.bin, p.name`,
    )
    .all(id)
    .map((l) => {
      // Blind counting: nobody sees system figures until the count is submitted, and only managers see money
      if (count.status === 'open') {
        delete l.system_qty;
        delete l.variance;
      }
      if (!approver) delete l.unit_cost;
      return l;
    });
  count.can_count = count.status === 'open' && (count.assigned_to === user.id || approver);
  count.can_decide = count.status === 'submitted' && approver && (count.assigned_to !== user.id || user.role === 'director');
  return count;
}

function assertCounter(db, userId) {
  const u = db.prepare("SELECT role, active FROM users WHERE id = ?").get(userId);
  if (!u || !u.active || !['warehouse', 'warehouse_manager', 'director', 'office'].includes(u.role)) {
    throw new HttpError(400, 'Counts can only be assigned to active warehouse or office staff');
  }
}

function createCount(db, { warehouseId, assignedTo, createdBy, kind, note, products }) {
  if (!products.length) throw new HttpError(400, 'No products to count. Choose a different warehouse or filter.');
  const busy = db
    .prepare(
      `SELECT p.sku FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id JOIN products p ON p.id = l.product_id
       WHERE sc.status = 'open' AND sc.warehouse_id = ? AND l.product_id = ?`,
    );
  for (const p of products) {
    const clash = busy.get(warehouseId, p.id);
    if (clash) throw new HttpError(409, `${clash.sku} is already on an open count in this warehouse`);
  }
  const id = db
    .prepare('INSERT INTO stock_counts (ref, warehouse_id, kind, assigned_to, created_by, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nextRef(db), warehouseId, kind, assignedTo, createdBy, note).lastInsertRowid;
  const ins = db.prepare('INSERT INTO count_lines (count_id, product_id, bin) VALUES (?, ?, ?)');
  for (const p of products) ins.run(id, p.id, p.bin || null);
  return id;
}

function postAdjustment(db, count, line, approverId, approverName) {
  stock.adjustBy(db, {
    productId: line.product_id,
    warehouseId: count.warehouse_id,
    delta: line.variance,
    reference: count.ref,
    note: approverName ? `Counted by ${count.assigned_name}, approved by ${approverName}` : `Counted by ${count.assigned_name}, within tolerance`,
    userId: approverId || count.assigned_to,
  });
}

function closeIfDone(db, countId) {
  const pending = db.prepare("SELECT COUNT(*) AS n FROM count_lines WHERE count_id = ? AND status = 'pending'").get(countId).n;
  if (!pending) db.prepare("UPDATE stock_counts SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), countId);
}

function countRoutes(db) {
  const r = express.Router();

  r.get('/settings', allow(COUNTERS), (req, res) => res.json(getSettings(db)));

  r.put('/settings', allow(STOCK_APPROVERS), (req, res) => {
    const units = v.int(req.body.tolerance_units, 'Unit tolerance', { required: true, min: 0, max: 100000 });
    const value = v.num(req.body.tolerance_value, 'Rand tolerance', { required: true, min: 0 });
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
    tx(db, () => {
      upsert.run('count_tolerance_units', String(units));
      upsert.run('count_tolerance_value', String(value));
    });
    res.json(getSettings(db));
  });

  r.get('/', allow(COUNTERS), (req, res) => {
    const scope = countScope(req.user);
    const where = [scope.sql];
    const params = [...scope.params];
    if (req.query.status) {
      const list = String(req.query.status).split(',');
      where.push(`sc.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (req.query.warehouse_id) {
      where.push('sc.warehouse_id = ?');
      params.push(Number(req.query.warehouse_id));
    }
    const rows = db
      .prepare(
        `${COUNT_SELECT} WHERE ${where.join(' AND ')}
         ORDER BY CASE sc.status WHEN 'submitted' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, sc.id DESC LIMIT 300`,
      )
      .all(...params);
    if (!isStockApprover(req.user)) for (const row of rows) delete row.adjusted_value;
    res.json(rows);
  });

  r.get('/:id', allow(COUNTERS), (req, res) => res.json(loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }))));

  /**
   * New count. Managers can assign it to anyone on the floor; staff can start one for themselves.
   * Products: explicit product_ids, or everything stocked in the warehouse matching the filters.
   */
  r.post('/', allow(COUNTERS), (req, res) => {
    const b = req.body;
    const warehouseId = v.int(b.warehouse_id, 'Warehouse', { required: true });
    v.found(db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(warehouseId), 'Warehouse');
    const assignedTo = isStockApprover(req.user) ? v.int(b.assigned_to, 'Counter') ?? req.user.id : req.user.id;
    assertCounter(db, assignedTo);
    const where = ['p.active = 1'];
    const params = [warehouseId];
    if (Array.isArray(b.product_ids) && b.product_ids.length) {
      const ids = b.product_ids.map((x) => v.int(x, 'Product', { required: true }));
      where.push(`p.id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    } else {
      // Everything with a stock record in this warehouse (including items the system thinks are at zero)
      where.push('s.product_id IS NOT NULL');
      if (b.client_id) {
        where.push('p.client_id = ?');
        params.push(v.int(b.client_id, 'Client'));
      }
      if (b.category) {
        where.push('p.category = ?');
        params.push(String(b.category));
      }
      if (b.bin_prefix) {
        where.push("UPPER(COALESCE(s.bin, '')) LIKE ?");
        params.push(`${String(b.bin_prefix).toUpperCase()}%`);
      }
    }
    const products = db
      .prepare(
        `SELECT p.id, s.bin FROM products p LEFT JOIN stock s ON s.product_id = p.id AND s.warehouse_id = ?
         WHERE ${where.join(' AND ')} ORDER BY s.bin, p.name LIMIT 1000`,
      )
      .all(...params);
    const id = tx(db, () =>
      createCount(db, {
        warehouseId,
        assignedTo,
        createdBy: req.user.id,
        kind: v.oneOf(b.kind, 'Kind', ['spot', 'full']) || 'spot',
        note: v.str(b.note, 'Note', { max: 500 }),
        products,
      }),
    );
    res.status(201).json(loadCount(db, req.user, id));
  });

  /**
   * Daily cycle count: the products in a warehouse that were counted longest ago
   * (never-counted first, then highest stock value), so the whole warehouse gets
   * counted regularly without a shutdown.
   */
  r.post('/cycle', allow(STOCK_APPROVERS), (req, res) => {
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const assignedTo = v.int(req.body.assigned_to, 'Counter', { required: true });
    assertCounter(db, assignedTo);
    const size = v.int(req.body.lines, 'Number of products', { min: 1, max: 200 }) ?? 20;
    const products = db
      .prepare(
        `SELECT p.id, s.bin,
           (SELECT MAX(sc.submitted_at) FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id
            WHERE l.product_id = p.id AND sc.warehouse_id = s.warehouse_id AND sc.submitted_at IS NOT NULL) AS last_counted
         FROM stock s JOIN products p ON p.id = s.product_id
         WHERE s.warehouse_id = ? AND p.active = 1 AND s.qty > 0
           AND NOT EXISTS (SELECT 1 FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id
                           WHERE sc.status = 'open' AND sc.warehouse_id = s.warehouse_id AND l.product_id = p.id)
         ORDER BY last_counted IS NOT NULL, last_counted, s.qty * p.unit_cost DESC
         LIMIT ?`,
      )
      .all(warehouseId, size)
      .sort((a, b) => String(a.bin || '~').localeCompare(String(b.bin || '~')));
    const id = tx(db, () =>
      createCount(db, { warehouseId, assignedTo, createdBy: req.user.id, kind: 'cycle', note: v.str(req.body.note, 'Note'), products }),
    );
    res.status(201).json(loadCount(db, req.user, id));
  });

  // Save counted quantities as you go (nothing is compared until submit)
  r.put('/:id/lines', allow(COUNTERS), (req, res) => {
    const count = loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!count.can_count) throw new HttpError(409, `${count.ref} can't be edited now`);
    const ids = new Set(count.items.map((l) => l.id));
    const upd = db.prepare('UPDATE count_lines SET counted_qty = ? WHERE id = ? AND count_id = ?');
    tx(db, () => {
      for (const l of Array.isArray(req.body.lines) ? req.body.lines : []) {
        const lineId = Number(l.id);
        if (!ids.has(lineId)) throw new HttpError(400, 'Line does not belong to this count');
        upd.run(v.int(l.counted_qty, 'Counted quantity', { min: 0 }), lineId, count.id);
      }
    });
    res.json(loadCount(db, req.user, count.id));
  });

  r.post('/:id/submit', allow(COUNTERS), (req, res) => {
    let count = loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!count.can_count) throw new HttpError(409, `${count.ref} can't be submitted now`);
    const missing = count.items.filter((l) => l.counted_qty === null);
    if (missing.length) throw new HttpError(400, `Count every line first (${missing.length} left). Enter 0 if there are none.`);
    const { tolerance_units: tolUnits, tolerance_value: tolValue } = getSettings(db);
    tx(db, () => {
      const now = new Date().toISOString();
      db.prepare("UPDATE stock_counts SET status = 'submitted', submitted_at = ? WHERE id = ?").run(now, count.id);
      count = { ...count, ...db.prepare('SELECT * FROM stock_counts WHERE id = ?').get(count.id) };
      for (const l of db.prepare('SELECT l.*, p.unit_cost FROM count_lines l JOIN products p ON p.id = l.product_id WHERE l.count_id = ?').all(count.id)) {
        const system = stock.warehouseQty(db, l.product_id, count.warehouse_id);
        const variance = l.counted_qty - system;
        const withinTolerance = Math.abs(variance) <= tolUnits && Math.abs(variance * l.unit_cost) <= tolValue;
        const status = variance === 0 ? 'matched' : withinTolerance ? 'auto' : 'pending';
        db.prepare('UPDATE count_lines SET system_qty = ?, variance = ?, unit_cost = ?, status = ?, decided_at = ? WHERE id = ?').run(
          system,
          variance,
          l.unit_cost,
          status,
          status === 'pending' ? null : now,
          l.id,
        );
        if (status === 'auto') postAdjustment(db, count, { ...l, variance }, null, null);
      }
      closeIfDone(db, count.id);
    });
    res.json(loadCount(db, req.user, count.id));
  });

  /** Manager decisions on differences: approve adjusts stock, reject leaves it as it is. */
  r.post('/:id/decide', allow(STOCK_APPROVERS), (req, res) => {
    const count = loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (count.status !== 'submitted') throw new HttpError(409, `${count.ref} has nothing waiting for approval`);
    if (!count.can_decide) throw new HttpError(403, 'You counted this yourself, so another manager needs to approve it');
    const pending = new Map(count.items.filter((l) => l.status === 'pending').map((l) => [l.id, l]));
    const decisions = Array.isArray(req.body.decisions) ? req.body.decisions : [];
    if (!decisions.length) throw new HttpError(400, 'Approve or reject at least one line');
    tx(db, () => {
      const now = new Date().toISOString();
      for (const d of decisions) {
        const line = pending.get(Number(d.line_id));
        if (!line) throw new HttpError(400, 'That line is not waiting for approval');
        const note = v.str(d.note, 'Note', { max: 500 });
        if (d.approve) postAdjustment(db, count, line, req.user.id, req.user.name);
        else if (!note) throw new HttpError(400, 'Give a reason when rejecting a difference');
        db.prepare('UPDATE count_lines SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(
          d.approve ? 'approved' : 'rejected',
          req.user.id,
          now,
          note,
          line.id,
        );
      }
      closeIfDone(db, count.id);
    });
    res.json(loadCount(db, req.user, count.id));
  });

  /** Reject differences and send those products for a fresh blind count, usually by someone else. */
  r.post('/:id/recount', allow(STOCK_APPROVERS), (req, res) => {
    const count = loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!count.can_decide) throw new HttpError(409, `${count.ref} has nothing you can send for recount`);
    const assignedTo = v.int(req.body.assigned_to, 'Recount by', { required: true });
    assertCounter(db, assignedTo);
    const lineIds = new Set((req.body.line_ids || []).map(Number));
    const lines = count.items.filter((l) => l.status === 'pending' && lineIds.has(l.id));
    if (!lines.length) throw new HttpError(400, 'Choose the lines to recount');
    const newId = tx(db, () => {
      const now = new Date().toISOString();
      // Free the products from this count first so they can go on the new one
      for (const l of lines) {
        db.prepare("UPDATE count_lines SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(
          req.user.id,
          now,
          'Sent for recount',
          l.id,
        );
      }
      const id = createCount(db, {
        warehouseId: count.warehouse_id,
        assignedTo,
        createdBy: req.user.id,
        kind: 'spot',
        note: `Recount of ${count.ref}`,
        products: lines.map((l) => ({ id: l.product_id, bin: l.bin })),
      });
      closeIfDone(db, count.id);
      return id;
    });
    res.status(201).json(loadCount(db, req.user, newId));
  });

  r.post('/:id/cancel', allow(COUNTERS), (req, res) => {
    const count = loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (count.status !== 'open') throw new HttpError(409, 'Only open counts can be cancelled');
    if (!isStockApprover(req.user) && count.created_by !== req.user.id) throw new HttpError(403, 'Ask a manager to cancel this count');
    db.prepare("UPDATE stock_counts SET status = 'cancelled', closed_at = ? WHERE id = ?").run(new Date().toISOString(), count.id);
    res.json(loadCount(db, req.user, count.id));
  });

  return r;
}

/** Losses and gains: count adjustments, damage and expired write-offs, by product, warehouse and counter. */
function reportRoutes(db) {
  const r = express.Router();

  r.get('/shrinkage', allow(STOCK_APPROVERS), (req, res) => {
    const from = v.date(req.query.from, 'From') || stock.saToday(-30);
    const to = v.date(req.query.to, 'To') || stock.saToday();
    const wh = req.query.warehouse_id ? v.int(req.query.warehouse_id, 'Warehouse') : null;
    const range = [`${from} 00:00:00`, `${to} 23:59:59`];
    const whMove = wh ? 'AND COALESCE(m.to_warehouse_id, m.from_warehouse_id) = ?' : '';
    const whParams = wh ? [wh] : [];

    // Ledger losses/gains valued at today's unit cost
    const byProduct = db
      .prepare(
        `SELECT p.id, p.sku, p.name, cl.name AS client_name, p.unit_cost,
           COALESCE(SUM(CASE WHEN m.type = 'adjustment' AND m.qty < 0 THEN -m.qty END), 0) AS missing,
           COALESCE(SUM(CASE WHEN m.type = 'adjustment' AND m.qty > 0 THEN m.qty END), 0) AS found,
           COALESCE(SUM(CASE WHEN m.type = 'damage' THEN m.qty END), 0) AS damaged,
           COALESCE(SUM(CASE WHEN m.type = 'write_off' THEN m.qty END), 0) AS expired
         FROM movements m JOIN products p ON p.id = m.product_id JOIN clients cl ON cl.id = p.client_id
         WHERE m.type IN ('adjustment','damage','write_off') AND m.created_at BETWEEN ? AND ? ${whMove}
         GROUP BY p.id ORDER BY (missing + damaged + expired - found) * p.unit_cost DESC`,
      )
      .all(...range, ...whParams)
      .map((x) => ({ ...x, net_loss_value: Math.round((x.missing + x.damaged + x.expired - x.found) * x.unit_cost * 100) / 100 }));

    const byWarehouse = db
      .prepare(
        `SELECT w.id, w.name,
           COALESCE(SUM(CASE WHEN m.type = 'adjustment' THEN -m.qty * p.unit_cost END), 0) AS count_loss_value,
           COALESCE(SUM(CASE WHEN m.type = 'write_off' THEN m.qty * p.unit_cost END), 0) AS expired_value
         FROM warehouses w
         LEFT JOIN movements m ON COALESCE(m.to_warehouse_id, m.from_warehouse_id) = w.id
           AND m.type IN ('adjustment','write_off') AND m.created_at BETWEEN ? AND ?
         LEFT JOIN products p ON p.id = m.product_id
         WHERE w.active = 1 ${wh ? 'AND w.id = ?' : ''}
         GROUP BY w.id ORDER BY w.name`,
      )
      .all(...range, ...whParams);

    // Counting accuracy per person: how often their counts disagreed with the system
    const byCounter = db
      .prepare(
        `SELECT u.id, u.name, u.role, COUNT(*) AS lines,
           SUM(CASE WHEN l.variance = 0 THEN 1 ELSE 0 END) AS exact,
           SUM(CASE WHEN l.variance != 0 THEN 1 ELSE 0 END) AS differences,
           SUM(CASE WHEN l.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           COALESCE(SUM(CASE WHEN l.status IN ('auto','approved') THEN l.variance * l.unit_cost END), 0) AS adjusted_value
         FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id JOIN users u ON u.id = sc.assigned_to
         WHERE sc.submitted_at BETWEEN ? AND ? AND l.variance IS NOT NULL ${wh ? 'AND sc.warehouse_id = ?' : ''}
         GROUP BY u.id ORDER BY differences DESC`,
      )
      .all(`${from}T00:00:00`, `${to}T23:59:59.999Z`, ...whParams)
      .map((x) => ({ ...x, accuracy: x.lines ? Math.round((x.exact / x.lines) * 1000) / 10 : null }));

    const totals = byProduct.reduce(
      (t, x) => ({
        missing_value: t.missing_value + x.missing * x.unit_cost,
        found_value: t.found_value + x.found * x.unit_cost,
        damaged_value: t.damaged_value + x.damaged * x.unit_cost,
        expired_value: t.expired_value + x.expired * x.unit_cost,
      }),
      { missing_value: 0, found_value: 0, damaged_value: 0, expired_value: 0 },
    );
    totals.net_loss_value = totals.missing_value + totals.damaged_value + totals.expired_value - totals.found_value;
    for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;

    res.json({ from, to, totals, by_product: byProduct.filter((x) => x.missing || x.found || x.damaged || x.expired), by_warehouse: byWarehouse, by_counter: byCounter });
  });

  return r;
}

module.exports = { countRoutes, reportRoutes, getSettings };
