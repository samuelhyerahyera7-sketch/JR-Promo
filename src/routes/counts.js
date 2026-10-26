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
 *  3. On submit the system compares. Differences within the unit tolerance are
 *     adjusted straight away; bigger ones wait for a manager.
 *  4. A manager approves (stock is adjusted) or rejects / asks for a recount.
 *     Nobody can approve a count they did themselves, except a director.
 */

const COUNTERS = [MANAGEMENT, WAREHOUSE];

async function getSettings(db) {
  const rows = (await db.all("SELECT key, value FROM settings WHERE key LIKE 'count_%'"));
  const map = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  return { tolerance_units: map.count_tolerance_units ?? 0 };
}

async function nextRef(db) {
  const row = (await db.get('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM stock_counts'));
  return `CNT-${String(row.n).padStart(5, '0')}`;
}

const COUNT_SELECT = `
  SELECT sc.*, w.name AS warehouse_name, a.name AS assigned_name, cb.name AS created_by_name,
    (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = sc.id) AS lines,
    (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = sc.id AND l.counted_qty IS NOT NULL) AS counted_lines,
    (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = sc.id AND l.status = 'pending') AS pending_lines,
    (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = sc.id AND l.variance != 0) AS variance_lines,
    (SELECT COALESCE(SUM(l.variance), 0) FROM count_lines l WHERE l.count_id = sc.id
       AND l.status IN ('auto','approved')) AS adjusted_units
  FROM stock_counts sc
  JOIN warehouses w ON w.id = sc.warehouse_id
  JOIN users a ON a.id = sc.assigned_to
  JOIN users cb ON cb.id = sc.created_by`;

/** Warehouse staff only see counts assigned to them; managers see all. */
function countScope(user) {
  if (isStockApprover(user)) return { sql: '1=1', params: [] };
  return { sql: 'sc.assigned_to = ?', params: [user.id] };
}

async function loadCount(db, user, id) {
  const scope = countScope(user);
  const count = v.found((await db.get(`${COUNT_SELECT} WHERE sc.id = ? AND ${scope.sql}`, id, ...scope.params)), 'Count');
  const approver = isStockApprover(user);
  count.items = (await db.all(`SELECT l.*, p.sku, p.name AS product_name, p.unit, p.category, p.barcode, d.name AS decided_by_name
       FROM count_lines l JOIN products p ON p.id = l.product_id LEFT JOIN users d ON d.id = l.decided_by
       WHERE l.count_id = ? ORDER BY l.bin IS NULL, l.bin, p.name`, id))
    .map((l) => {
      // Blind counting: nobody sees system figures until the count is submitted, and only managers see money
      if (count.status === 'open') {
        delete l.system_qty;
        delete l.variance;
      }
      delete l.unit_cost;
      return l;
    });
  count.can_count = count.status === 'open' && (count.assigned_to === user.id || approver);
  count.can_decide = count.status === 'submitted' && approver && (count.assigned_to !== user.id || user.role === 'director');
  return count;
}

async function assertCounter(db, userId) {
  const u = (await db.get("SELECT role, active FROM users WHERE id = ?", userId));
  if (!u || !u.active || !['warehouse', 'warehouse_manager', 'director', 'office'].includes(u.role)) {
    throw new HttpError(400, 'Counts can only be assigned to active warehouse or office staff');
  }
}

async function createCount(db, { warehouseId, assignedTo, createdBy, kind, note, products }) {
  if (!products.length) throw new HttpError(400, 'No products to count. Choose a different warehouse or filter.');
  const busy = db
    .stmt(
      `SELECT p.sku FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id JOIN products p ON p.id = l.product_id
       WHERE sc.status = 'open' AND sc.warehouse_id = ? AND l.product_id = ?`,
    );
  for (const p of products) {
    const clash = await busy.get(warehouseId, p.id);
    if (clash) throw new HttpError(409, `${clash.sku} is already on an open count in this warehouse`);
  }
  const id = (await db.insert('INSERT INTO stock_counts (ref, warehouse_id, kind, assigned_to, created_by, note) VALUES (?, ?, ?, ?, ?, ?)', await nextRef(db), warehouseId, kind, assignedTo, createdBy, note));
  const ins = db.stmt('INSERT INTO count_lines (count_id, product_id, bin) VALUES (?, ?, ?)');
  for (const p of products) await ins.run(id, p.id, p.bin || null);
  return id;
}

async function postAdjustment(db, count, line, approverId, approverName) {
  await stock.adjustBy(db, {
    productId: line.product_id,
    warehouseId: count.warehouse_id,
    delta: line.variance,
    reference: count.ref,
    note: approverName ? `Counted by ${count.assigned_name}, approved by ${approverName}` : `Counted by ${count.assigned_name}, within tolerance`,
    userId: approverId || count.assigned_to,
  });
}

async function closeIfDone(db, countId) {
  const pending = (await db.get("SELECT COUNT(*) AS n FROM count_lines WHERE count_id = ? AND status = 'pending'", countId)).n;
  if (!pending) (await db.run("UPDATE stock_counts SET status = 'closed', closed_at = ? WHERE id = ?", new Date().toISOString(), countId));
}

function countRoutes(db) {
  const r = express.Router();

  r.get('/settings', allow(COUNTERS), async (req, res) => res.json(await getSettings(db)));

  r.put('/settings', allow(STOCK_APPROVERS), async (req, res) => {
    const units = v.int(req.body.tolerance_units, 'Unit tolerance', { required: true, min: 0, max: 100000 });
    (await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', 'count_tolerance_units',
      String(units)));
    res.json(await getSettings(db));
  });

  r.get('/', allow(COUNTERS), async (req, res) => {
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
    const rows = (await db.all(`${COUNT_SELECT} WHERE ${where.join(' AND ')}
         ORDER BY CASE sc.status WHEN 'submitted' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, sc.id DESC LIMIT 300`, ...params));
    res.json(rows);
  });

  r.get('/:id', allow(COUNTERS), async (req, res) => res.json(await loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }))));

  /**
   * New count. Managers can assign it to anyone on the floor; staff can start one for themselves.
   * Products: explicit product_ids, or everything stocked in the warehouse matching the filters.
   */
  r.post('/', allow(COUNTERS), async (req, res) => {
    const b = req.body;
    const warehouseId = v.int(b.warehouse_id, 'Warehouse', { required: true });
    v.found((await db.get('SELECT 1 FROM warehouses WHERE id = ? AND active = 1', warehouseId)), 'Warehouse');
    const assignedTo = isStockApprover(req.user) ? v.int(b.assigned_to, 'Counter') ?? req.user.id : req.user.id;
    await assertCounter(db, assignedTo);
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
    const products = (await db.all(`SELECT p.id, s.bin FROM products p LEFT JOIN stock s ON s.product_id = p.id AND s.warehouse_id = ?
         WHERE ${where.join(' AND ')} ORDER BY s.bin, p.name LIMIT 1000`, ...params));
    const id = await tx(db, async () =>
      await createCount(db, {
        warehouseId,
        assignedTo,
        createdBy: req.user.id,
        kind: v.oneOf(b.kind, 'Kind', ['spot', 'full']) || 'spot',
        note: v.str(b.note, 'Note', { max: 500 }),
        products,
      }),
    );
    res.status(201).json(await loadCount(db, req.user, id));
  });

  /**
   * Daily cycle count: the products in a warehouse that were counted longest ago
   * (never-counted first, then the most units on the shelf), so the whole warehouse gets
   * counted regularly without a shutdown.
   */
  r.post('/cycle', allow(STOCK_APPROVERS), async (req, res) => {
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const assignedTo = v.int(req.body.assigned_to, 'Counter', { required: true });
    await assertCounter(db, assignedTo);
    const size = v.int(req.body.lines, 'Number of products', { min: 1, max: 200 }) ?? 20;
    const products = (await db.all(`SELECT * FROM (SELECT p.id, s.bin, s.qty,
           (SELECT MAX(sc.submitted_at) FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id
            WHERE l.product_id = p.id AND sc.warehouse_id = s.warehouse_id AND sc.submitted_at IS NOT NULL) AS last_counted
         FROM stock s JOIN products p ON p.id = s.product_id
         WHERE s.warehouse_id = ? AND p.active = 1 AND s.qty > 0
           AND NOT EXISTS (SELECT 1 FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id
                           WHERE sc.status = 'open' AND sc.warehouse_id = s.warehouse_id AND l.product_id = p.id)) x
         ORDER BY x.last_counted IS NOT NULL, x.last_counted, x.qty DESC
         LIMIT ?`, warehouseId, size))
      .sort((a, b) => String(a.bin || '~').localeCompare(String(b.bin || '~')));
    const id = await tx(db, async () =>
      await createCount(db, { warehouseId, assignedTo, createdBy: req.user.id, kind: 'cycle', note: v.str(req.body.note, 'Note'), products }),
    );
    res.status(201).json(await loadCount(db, req.user, id));
  });

  // Save counted quantities as you go (nothing is compared until submit)
  r.put('/:id/lines', allow(COUNTERS), async (req, res) => {
    const count = await loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!count.can_count) throw new HttpError(409, `${count.ref} can't be edited now`);
    const ids = new Set(count.items.map((l) => l.id));
    const upd = db.stmt('UPDATE count_lines SET counted_qty = ? WHERE id = ? AND count_id = ?');
    await tx(db, async () => {
      for (const l of Array.isArray(req.body.lines) ? req.body.lines : []) {
        const lineId = Number(l.id);
        if (!ids.has(lineId)) throw new HttpError(400, 'Line does not belong to this count');
        await upd.run(v.int(l.counted_qty, 'Counted quantity', { min: 0 }), lineId, count.id);
      }
    });
    res.json(await loadCount(db, req.user, count.id));
  });

  r.post('/:id/submit', allow(COUNTERS), async (req, res) => {
    let count = await loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!count.can_count) throw new HttpError(409, `${count.ref} can't be submitted now`);
    const missing = count.items.filter((l) => l.counted_qty === null);
    if (missing.length) throw new HttpError(400, `Count every line first (${missing.length} left). Enter 0 if there are none.`);
    const { tolerance_units: tolUnits } = await getSettings(db);
    await tx(db, async () => {
      const now = new Date().toISOString();
      (await db.run("UPDATE stock_counts SET status = 'submitted', submitted_at = ? WHERE id = ?", now, count.id));
      count = { ...count, ...(await db.get('SELECT * FROM stock_counts WHERE id = ?', count.id)) };
      for (const l of (await db.all('SELECT l.*, p.unit_cost FROM count_lines l JOIN products p ON p.id = l.product_id WHERE l.count_id = ?', count.id))) {
        const system = await stock.warehouseQty(db, l.product_id, count.warehouse_id);
        const variance = l.counted_qty - system;
        const withinTolerance = Math.abs(variance) <= tolUnits;
        const status = variance === 0 ? 'matched' : withinTolerance ? 'auto' : 'pending';
        (await db.run('UPDATE count_lines SET system_qty = ?, variance = ?, unit_cost = ?, status = ?, decided_at = ? WHERE id = ?', system,
          variance,
          l.unit_cost,
          status,
          status === 'pending' ? null : now,
          l.id));
        if (status === 'auto') await postAdjustment(db, count, { ...l, variance }, null, null);
      }
      await closeIfDone(db, count.id);
    });
    res.json(await loadCount(db, req.user, count.id));
  });

  /** Manager decisions on differences: approve adjusts stock, reject leaves it as it is. */
  r.post('/:id/decide', allow(STOCK_APPROVERS), async (req, res) => {
    const count = await loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (count.status !== 'submitted') throw new HttpError(409, `${count.ref} has nothing waiting for approval`);
    if (!count.can_decide) throw new HttpError(403, 'You counted this yourself, so another manager needs to approve it');
    const pending = new Map(count.items.filter((l) => l.status === 'pending').map((l) => [l.id, l]));
    const decisions = Array.isArray(req.body.decisions) ? req.body.decisions : [];
    if (!decisions.length) throw new HttpError(400, 'Approve or reject at least one line');
    await tx(db, async () => {
      const now = new Date().toISOString();
      for (const d of decisions) {
        const line = pending.get(Number(d.line_id));
        if (!line) throw new HttpError(400, 'That line is not waiting for approval');
        const note = v.str(d.note, 'Note', { max: 500 });
        if (d.approve) await postAdjustment(db, count, line, req.user.id, req.user.name);
        else if (!note) throw new HttpError(400, 'Give a reason when rejecting a difference');
        (await db.run('UPDATE count_lines SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?', d.approve ? 'approved' : 'rejected',
          req.user.id,
          now,
          note,
          line.id));
      }
      await closeIfDone(db, count.id);
    });
    res.json(await loadCount(db, req.user, count.id));
  });

  /** Reject differences and send those products for a fresh blind count, usually by someone else. */
  r.post('/:id/recount', allow(STOCK_APPROVERS), async (req, res) => {
    const count = await loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!count.can_decide) throw new HttpError(409, `${count.ref} has nothing you can send for recount`);
    const assignedTo = v.int(req.body.assigned_to, 'Recount by', { required: true });
    await assertCounter(db, assignedTo);
    const lineIds = new Set((req.body.line_ids || []).map(Number));
    const lines = count.items.filter((l) => l.status === 'pending' && lineIds.has(l.id));
    if (!lines.length) throw new HttpError(400, 'Choose the lines to recount');
    const newId = await tx(db, async () => {
      const now = new Date().toISOString();
      // Free the products from this count first so they can go on the new one
      for (const l of lines) {
        (await db.run("UPDATE count_lines SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?", req.user.id,
          now,
          'Sent for recount',
          l.id));
      }
      const id = await createCount(db, {
        warehouseId: count.warehouse_id,
        assignedTo,
        createdBy: req.user.id,
        kind: 'spot',
        note: `Recount of ${count.ref}`,
        products: lines.map((l) => ({ id: l.product_id, bin: l.bin })),
      });
      await closeIfDone(db, count.id);
      return id;
    });
    res.status(201).json(await loadCount(db, req.user, newId));
  });

  r.post('/:id/cancel', allow(COUNTERS), async (req, res) => {
    const count = await loadCount(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (count.status !== 'open') throw new HttpError(409, 'Only open counts can be cancelled');
    if (!isStockApprover(req.user) && count.created_by !== req.user.id) throw new HttpError(403, 'Ask a manager to cancel this count');
    (await db.run("UPDATE stock_counts SET status = 'cancelled', closed_at = ? WHERE id = ?", new Date().toISOString(), count.id));
    res.json(await loadCount(db, req.user, count.id));
  });

  return r;
}

/** Losses and gains: count adjustments, damage and expired write-offs, by product, warehouse and counter. */
function reportRoutes(db) {
  const r = express.Router();

  r.get('/shrinkage', allow(STOCK_APPROVERS), async (req, res) => {
    const from = v.date(req.query.from, 'From') || stock.saToday(-30);
    const to = v.date(req.query.to, 'To') || stock.saToday();
    const wh = req.query.warehouse_id ? v.int(req.query.warehouse_id, 'Warehouse') : null;
    const range = [`${from} 00:00:00`, `${to} 23:59:59`];
    const whMove = wh ? 'AND COALESCE(m.to_warehouse_id, m.from_warehouse_id) = ?' : '';
    const whParams = wh ? [wh] : [];

    // Ledger losses and gains, in units
    const byProduct = (await db.all(`SELECT * FROM (SELECT p.id, p.sku, p.name, cl.name AS client_name,
           COALESCE(SUM(CASE WHEN m.type = 'adjustment' AND m.qty < 0 THEN -m.qty END), 0) AS missing,
           COALESCE(SUM(CASE WHEN m.type = 'adjustment' AND m.qty > 0 THEN m.qty END), 0) AS found,
           COALESCE(SUM(CASE WHEN m.type = 'damage' THEN m.qty END), 0) AS damaged,
           COALESCE(SUM(CASE WHEN m.type = 'write_off' THEN m.qty END), 0) AS expired
         FROM movements m JOIN products p ON p.id = m.product_id JOIN clients cl ON cl.id = p.client_id
         WHERE m.type IN ('adjustment','damage','write_off') AND m.created_at BETWEEN ? AND ? ${whMove}
         GROUP BY p.id, cl.name) x ORDER BY (x.missing + x.damaged + x.expired - x.found) DESC, x.name`, ...range, ...whParams))
      .map((x) => ({ ...x, net_loss: x.missing + x.damaged + x.expired - x.found }));

    const byWarehouse = (await db.all(`SELECT w.id, w.name,
           COALESCE(SUM(CASE WHEN m.type = 'adjustment' AND m.qty < 0 THEN -m.qty END), 0) AS missing,
           COALESCE(SUM(CASE WHEN m.type = 'adjustment' AND m.qty > 0 THEN m.qty END), 0) AS found,
           COALESCE(SUM(CASE WHEN m.type = 'write_off' THEN m.qty END), 0) AS expired
         FROM warehouses w
         LEFT JOIN movements m ON COALESCE(m.to_warehouse_id, m.from_warehouse_id) = w.id
           AND m.type IN ('adjustment','write_off') AND m.created_at BETWEEN ? AND ?
         WHERE w.active = 1 ${wh ? 'AND w.id = ?' : ''}
         GROUP BY w.id ORDER BY w.name`, ...range, ...whParams));

    // Counting accuracy per person: how often their counts disagreed with the system
    const byCounter = (await db.all(`SELECT u.id, u.name, u.role, COUNT(*) AS lines,
           SUM(CASE WHEN l.variance = 0 THEN 1 ELSE 0 END) AS exact,
           SUM(CASE WHEN l.variance != 0 THEN 1 ELSE 0 END) AS differences,
           SUM(CASE WHEN l.status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           COALESCE(SUM(CASE WHEN l.status IN ('auto','approved') THEN l.variance END), 0) AS adjusted_units
         FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id JOIN users u ON u.id = sc.assigned_to
         WHERE sc.submitted_at BETWEEN ? AND ? AND l.variance IS NOT NULL ${wh ? 'AND sc.warehouse_id = ?' : ''}
         GROUP BY u.id ORDER BY differences DESC`, `${from}T00:00:00`, `${to}T23:59:59.999Z`, ...whParams))
      .map((x) => ({ ...x, accuracy: x.lines ? Math.round((x.exact / x.lines) * 1000) / 10 : null }));

    const totals = byProduct.reduce(
      (t, x) => ({ missing: t.missing + x.missing, found: t.found + x.found, damaged: t.damaged + x.damaged, expired: t.expired + x.expired }),
      { missing: 0, found: 0, damaged: 0, expired: 0 },
    );
    totals.net_loss = totals.missing + totals.damaged + totals.expired - totals.found;

    res.json({ from, to, totals, by_product: byProduct.filter((x) => x.missing || x.found || x.damaged || x.expired), by_warehouse: byWarehouse, by_counter: byCounter });
  });

  return r;
}

module.exports = { countRoutes, reportRoutes, getSettings };
