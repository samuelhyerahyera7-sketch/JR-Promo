'use strict';

const express = require('express');
const { MANAGEMENT, HttpError, allow, isManagement } = require('../auth');
const v = require('../validate');
const stock = require('../stock');
const { tx } = require('../db');
const { clientScope } = require('../access');
const { toCsv } = require('../csv');

const CATEGORIES = ['Sample', 'Giveaway', 'POS Material', 'Merchandise', 'Equipment', 'Uniform', 'Other'];
const STOCK_ROLES = [MANAGEMENT, 'account_manager', 'warehouse'];
const OPERATORS = [MANAGEMENT, 'warehouse'];

function productQuery(user, query) {
  const scope = clientScope(user);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.client_id) {
    where.push('p.client_id = ?');
    params.push(Number(query.client_id));
  }
  if (query.category) {
    where.push('p.category = ?');
    params.push(query.category);
  }
  if (query.q) {
    where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.barcode = ?)');
    params.push(`%${query.q}%`, `%${query.q}%`, query.q);
  }
  if (query.active !== 'all') where.push('p.active = 1');
  let having = '';
  if (query.low === '1') having = 'HAVING on_hand <= p.reorder_level';
  return {
    sql: `SELECT p.*, cl.name AS client_name,
            COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand,
            COALESCE((SELECT SUM(qty) FROM field_stock f WHERE f.product_id = p.id), 0) AS in_field,
            COALESCE((SELECT SUM(ri.qty_approved) FROM request_items ri JOIN requests r ON r.id = ri.request_id
                      WHERE ri.product_id = p.id AND r.status IN ('approved','picking')), 0) AS allocated
          FROM products p JOIN clients cl ON cl.id = p.client_id
          WHERE ${where.join(' AND ')}
          GROUP BY p.id ${having}
          ORDER BY cl.name, p.name`,
    params,
  };
}

function productRoutes(db) {
  const r = express.Router();

  r.get('/categories', (req, res) => res.json(CATEGORIES));

  r.get('/', allow(STOCK_ROLES), (req, res) => {
    const q = productQuery(req.user, req.query);
    const rows = db.prepare(q.sql).all(...q.params);
    const levels = db.prepare('SELECT product_id, warehouse_id, qty, bin FROM stock WHERE qty > 0').all();
    const byProduct = new Map();
    for (const l of levels) {
      if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
      byProduct.get(l.product_id).push(l);
    }
    for (const row of rows) {
      row.available = row.on_hand - row.allocated;
      row.levels = byProduct.get(row.id) || [];
    }
    res.json(rows);
  });

  r.get('/:id', allow(STOCK_ROLES), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const q = productQuery(req.user, { active: 'all' });
    const product = v.found(
      db.prepare(q.sql.replace('GROUP BY', 'AND p.id = ? GROUP BY')).get(...q.params, id),
      'Product',
    );
    product.levels = db
      .prepare(
        `SELECT s.warehouse_id, w.name AS warehouse_name, s.qty, s.bin FROM stock s
         JOIN warehouses w ON w.id = s.warehouse_id WHERE s.product_id = ? ORDER BY w.name`,
      )
      .all(id);
    product.field = db
      .prepare(
        `SELECT f.promoter_id, u.name AS promoter_name, f.campaign_id, c.name AS campaign_name, f.qty
         FROM field_stock f JOIN users u ON u.id = f.promoter_id JOIN campaigns c ON c.id = f.campaign_id
         WHERE f.product_id = ? AND f.qty > 0 ORDER BY u.name`,
      )
      .all(id);
    product.movements = db
      .prepare(`${MOVEMENT_SELECT} WHERE m.product_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 50`)
      .all(id);
    res.json(product);
  });

  const fields = (b) => [
    v.str(b.sku, 'SKU', { required: true, max: 40 }).toUpperCase(),
    v.str(b.name, 'Product name', { required: true }),
    v.int(b.client_id, 'Client', { required: true }),
    v.oneOf(b.category, 'Category', CATEGORIES, { required: true }),
    v.str(b.unit, 'Unit') || 'unit',
    v.num(b.unit_cost, 'Unit cost', { min: 0 }) ?? 0,
    v.int(b.reorder_level, 'Reorder level', { min: 0 }) ?? 0,
    v.str(b.barcode, 'Barcode'),
    b.active === undefined ? 1 : b.active ? 1 : 0,
  ];

  const assertClient = (user, clientId) => {
    const client = v.found(db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId), 'Client');
    if (user.role === 'account_manager' && client.account_manager_id !== user.id) {
      throw new HttpError(403, 'You can only manage products for your own clients');
    }
  };

  r.post('/', allow(MANAGEMENT, 'account_manager'), (req, res) => {
    const f = fields(req.body);
    assertClient(req.user, f[2]);
    if (db.prepare('SELECT 1 FROM products WHERE sku = ?').get(f[0])) throw new HttpError(409, `SKU ${f[0]} already exists`);
    const info = db
      .prepare(
        `INSERT INTO products (sku, name, client_id, category, unit, unit_cost, reorder_level, barcode, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...f);
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/:id', allow(MANAGEMENT, 'account_manager'), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const existing = v.found(db.prepare('SELECT * FROM products WHERE id = ?').get(id), 'Product');
    assertClient(req.user, existing.client_id);
    const f = fields(req.body);
    assertClient(req.user, f[2]);
    if (db.prepare('SELECT 1 FROM products WHERE sku = ? AND id != ?').get(f[0], id)) {
      throw new HttpError(409, `SKU ${f[0]} already exists`);
    }
    db.prepare(
      `UPDATE products SET sku=?, name=?, client_id=?, category=?, unit=?, unit_cost=?, reorder_level=?, barcode=?, active=?
       WHERE id=?`,
    ).run(...f, id);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  });

  return r;
}

const MOVEMENT_SELECT = `
  SELECT m.*, p.sku, p.name AS product_name, cl.name AS client_name,
         fw.name AS from_warehouse, tw.name AS to_warehouse,
         pr.name AS promoter_name, c.name AS campaign_name, u.name AS user_name
  FROM movements m
  JOIN products p ON p.id = m.product_id
  JOIN clients cl ON cl.id = p.client_id
  LEFT JOIN warehouses fw ON fw.id = m.from_warehouse_id
  LEFT JOIN warehouses tw ON tw.id = m.to_warehouse_id
  LEFT JOIN users pr ON pr.id = m.promoter_id
  LEFT JOIN campaigns c ON c.id = m.campaign_id
  JOIN users u ON u.id = m.user_id`;

function movementQuery(user, query) {
  const scope = clientScope(user);
  const where = [scope.sql];
  const params = [...scope.params];
  const add = (sql, value) => {
    where.push(sql);
    params.push(value);
  };
  if (query.type) add('m.type = ?', query.type);
  if (query.product_id) add('m.product_id = ?', Number(query.product_id));
  if (query.client_id) add('p.client_id = ?', Number(query.client_id));
  if (query.campaign_id) add('m.campaign_id = ?', Number(query.campaign_id));
  if (query.warehouse_id) {
    where.push('(m.from_warehouse_id = ? OR m.to_warehouse_id = ?)');
    params.push(Number(query.warehouse_id), Number(query.warehouse_id));
  }
  if (query.from) add('m.created_at >= ?', `${query.from} 00:00:00`);
  if (query.to) add('m.created_at <= ?', `${query.to} 23:59:59`);
  return { sql: `${MOVEMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC`, params };
}

function stockRoutes(db) {
  const r = express.Router();

  // Promoters: what am I currently holding, per campaign
  r.get('/mine', allow('promoter'), (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT f.product_id, p.sku, p.name AS product_name, p.unit, f.campaign_id, c.name AS campaign_name, f.qty
           FROM field_stock f JOIN products p ON p.id = f.product_id JOIN campaigns c ON c.id = f.campaign_id
           WHERE f.promoter_id = ? AND f.qty > 0 ORDER BY c.name, p.name`,
        )
        .all(req.user.id),
    );
  });

  // Everything currently out with promoters
  r.get('/field', allow(STOCK_ROLES), (req, res) => {
    const scope = clientScope(req.user);
    res.json(
      db
        .prepare(
          `SELECT f.*, p.sku, p.name AS product_name, p.unit_cost, cl.name AS client_name,
                  u.name AS promoter_name, u.region, c.name AS campaign_name, c.status AS campaign_status
           FROM field_stock f JOIN products p ON p.id = f.product_id JOIN clients cl ON cl.id = p.client_id
           JOIN users u ON u.id = f.promoter_id JOIN campaigns c ON c.id = f.campaign_id
           WHERE f.qty > 0 AND ${scope.sql} ORDER BY u.name, c.name, p.name`,
        )
        .all(...scope.params),
    );
  });

  r.post('/receive', allow(OPERATORS), (req, res) => {
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const reference = v.str(req.body.reference, 'Reference (GRN / delivery note)', { required: true, max: 80 });
    const note = v.str(req.body.note, 'Note');
    const lines = v.items(req.body.items);
    tx(db, () => {
      for (const line of lines) {
        stock.receive(db, {
          productId: v.int(line.product_id, 'Product', { required: true }),
          warehouseId,
          qty: v.int(line.qty, 'Quantity', { required: true, min: 1 }),
          reference,
          note,
          userId: req.user.id,
        });
        if (line.bin) {
          db.prepare('UPDATE stock SET bin = ? WHERE product_id = ? AND warehouse_id = ?').run(
            v.str(line.bin, 'Bin', { max: 30 }),
            line.product_id,
            warehouseId,
          );
        }
      }
    });
    res.status(201).json({ ok: true, lines: lines.length });
  });

  r.post('/transfer', allow(OPERATORS), (req, res) => {
    const fromWarehouseId = v.int(req.body.from_warehouse_id, 'From warehouse', { required: true });
    const toWarehouseId = v.int(req.body.to_warehouse_id, 'To warehouse', { required: true });
    const reference = v.str(req.body.reference, 'Reference', { max: 80 }) || `TRF-${Date.now().toString(36).toUpperCase()}`;
    const note = v.str(req.body.note, 'Note');
    const lines = v.items(req.body.items);
    tx(db, () => {
      for (const line of lines) {
        stock.transfer(db, {
          productId: v.int(line.product_id, 'Product', { required: true }),
          fromWarehouseId,
          toWarehouseId,
          qty: v.int(line.qty, 'Quantity', { required: true, min: 1 }),
          reference,
          note,
          userId: req.user.id,
        });
      }
    });
    res.status(201).json({ ok: true, reference });
  });

  // Stock take: submit counted quantities, system records the variance
  r.post('/count', allow(OPERATORS), (req, res) => {
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const note = v.str(req.body.note, 'Note') || 'Stock take';
    const lines = v.items(req.body.items);
    const variances = tx(db, () =>
      lines.map((line) => {
        const productId = v.int(line.product_id, 'Product', { required: true });
        const delta = stock.adjustTo(db, {
          productId,
          warehouseId,
          countedQty: v.int(line.counted, 'Counted quantity', { required: true, min: 0 }),
          note,
          userId: req.user.id,
        });
        return { product_id: productId, variance: delta };
      }),
    );
    res.json({ ok: true, variances });
  });

  r.get('/movements', allow(STOCK_ROLES), (req, res) => {
    const q = movementQuery(req.user, req.query);
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(db.prepare(`${q.sql} LIMIT ${limit}`).all(...q.params));
  });

  r.get('/movements.csv', allow(STOCK_ROLES), (req, res) => {
    const q = movementQuery(req.user, req.query);
    const rows = db.prepare(q.sql).all(...q.params);
    sendCsv(res, 'movements.csv', rows, [
      ['Date', 'created_at'],
      ['Type', 'type'],
      ['Reference', 'reference'],
      ['SKU', 'sku'],
      ['Product', 'product_name'],
      ['Client', 'client_name'],
      ['Qty', 'qty'],
      ['From', 'from_warehouse'],
      ['To', 'to_warehouse'],
      ['Promoter', 'promoter_name'],
      ['Campaign', 'campaign_name'],
      ['Captured by', 'user_name'],
      ['Note', 'note'],
    ]);
  });

  r.get('/levels.csv', allow(STOCK_ROLES), (req, res) => {
    const q = productQuery(req.user, req.query);
    const rows = db.prepare(q.sql).all(...q.params);
    const showCost = isManagement(req.user) || req.user.role === 'account_manager';
    const columns = [
      ['SKU', 'sku'],
      ['Product', 'name'],
      ['Client', 'client_name'],
      ['Category', 'category'],
      ['On hand', 'on_hand'],
      ['Allocated', 'allocated'],
      ['In field', 'in_field'],
      ['Reorder level', 'reorder_level'],
    ];
    if (showCost) {
      for (const row of rows) row.value = (row.on_hand * row.unit_cost).toFixed(2);
      columns.push(['Unit cost (ZAR)', 'unit_cost'], ['Value (ZAR)', 'value']);
    }
    sendCsv(res, 'stock-levels.csv', rows, columns);
  });

  return r;
}

function sendCsv(res, filename, rows, columns) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(rows, columns));
}

module.exports = { productRoutes, stockRoutes, MOVEMENT_SELECT, CATEGORIES, sendCsv };
