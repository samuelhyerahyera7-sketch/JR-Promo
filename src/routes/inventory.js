'use strict';

const express = require('express');
const { MANAGEMENT, WAREHOUSE, STOCK_APPROVERS, HttpError, allow, isManagement } = require('../auth');
const v = require('../validate');
const stock = require('../stock');
const { tx } = require('../db');
const { clientScope } = require('../access');
const { toCsv } = require('../csv');

const CATEGORIES = [
  'Sample',
  'Giveaway',
  'POS Material',
  'Merchandise',
  'Uniform',
  'Promoter Table',
  'Setup & Display',
  'Equipment',
  'Other',
];
const GENDERS = ['female', 'male', 'unisex'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const STOCK_ROLES = [MANAGEMENT, 'account_manager', WAREHOUSE];
const OPERATORS = [MANAGEMENT, WAREHOUSE];

function productQuery(user, query) {
  const scope = clientScope(user);
  const where = [scope.sql];
  const params = [stock.saToday(), stock.saToday(30), ...scope.params];
  const add = (sql, value) => {
    where.push(sql);
    params.push(value);
  };
  if (query.client_id) add('p.client_id = ?', Number(query.client_id));
  if (query.category) add('p.category = ?', query.category);
  if (query.style) add('p.style = ?', query.style);
  if (query.gender) add('p.gender = ?', query.gender);
  if (query.size) add('p.size = ?', query.size);
  if (query.q) {
    where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.barcode = ? OR p.colour LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`, query.q, `%${query.q}%`);
  }
  if (query.active !== 'all') where.push('p.active = 1');
  let having = '';
  if (query.low === '1') having = 'HAVING on_hand <= p.reorder_level';
  if (query.expiring === '1') having = 'HAVING expiring > 0 OR expired > 0';
  return {
    sql: `SELECT p.*, cl.name AS client_name, cl.is_house,
            COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand,
            COALESCE((SELECT SUM(qty) FROM field_stock f WHERE f.product_id = p.id), 0) AS in_field,
            COALESCE((SELECT SUM(qty) FROM laundry_stock l WHERE l.product_id = p.id), 0) AS in_laundry,
            COALESCE((SELECT SUM(ri.qty_approved) FROM request_items ri JOIN requests r ON r.id = ri.request_id
                      WHERE ri.product_id = p.id AND r.status IN ('approved','picking')), 0) AS allocated,
            COALESCE((SELECT SUM(qty) FROM stock_batches b WHERE b.product_id = p.id AND b.expiry_date < ?1), 0) AS expired,
            COALESCE((SELECT SUM(qty) FROM stock_batches b WHERE b.product_id = p.id
                      AND b.expiry_date >= ?1 AND b.expiry_date <= ?2), 0) AS expiring,
            (SELECT MIN(expiry_date) FROM stock_batches b WHERE b.product_id = p.id AND b.qty > 0 AND b.expiry_date >= ?1) AS next_expiry
          FROM products p JOIN clients cl ON cl.id = p.client_id
          WHERE ${where.join(' AND ')}
          GROUP BY p.id ${having}
          ORDER BY cl.is_house DESC, cl.name, p.style, p.name`,
    params,
  };
}

/** Numbered parameters (?1, ?2) mean positional params must be numbered too; convert plain ? after them. */
function prepareNumbered(db, sql) {
  let n = 0;
  const numbered = sql.replace(/\?(\d*)/g, (m, d) => {
    if (d) {
      n = Math.max(n, Number(d));
      return m;
    }
    n += 1;
    return `?${n}`;
  });
  return db.prepare(numbered);
}

function productRoutes(db) {
  const r = express.Router();

  r.get('/categories', (req, res) => res.json(CATEGORIES));
  r.get('/sizes', (req, res) => res.json(SIZES));

  r.get('/', allow(STOCK_ROLES), (req, res) => {
    const q = productQuery(req.user, req.query);
    const rows = prepareNumbered(db, q.sql).all(...q.params);
    const levels = db.prepare('SELECT product_id, warehouse_id, qty, bin FROM stock WHERE qty > 0').all();
    const byProduct = new Map();
    for (const l of levels) {
      if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
      byProduct.get(l.product_id).push(l);
    }
    for (const row of rows) {
      row.available = row.on_hand - row.allocated - row.expired;
      row.levels = byProduct.get(row.id) || [];
    }
    res.json(rows);
  });

  r.get('/:id', allow(STOCK_ROLES), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const q = productQuery(req.user, { active: 'all' });
    const product = v.found(
      prepareNumbered(db, q.sql.replace('GROUP BY', 'AND p.id = ? GROUP BY')).get(...q.params, id),
      'Product',
    );
    product.available = product.on_hand - product.allocated - product.expired;
    product.levels = db
      .prepare(
        `SELECT s.warehouse_id, w.name AS warehouse_name, s.qty, s.bin,
           COALESCE((SELECT qty FROM laundry_stock l WHERE l.product_id = s.product_id AND l.warehouse_id = s.warehouse_id), 0) AS laundry
         FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.product_id = ? ORDER BY w.name`,
      )
      .all(id);
    product.batches = db
      .prepare(
        `SELECT b.*, w.name AS warehouse_name FROM stock_batches b JOIN warehouses w ON w.id = b.warehouse_id
         WHERE b.product_id = ? AND b.qty > 0 ORDER BY b.expiry_date IS NULL, b.expiry_date, w.name`,
      )
      .all(id);
    product.field = db
      .prepare(
        `SELECT f.promoter_id, u.name AS promoter_name, f.campaign_id, c.name AS campaign_name, f.qty
         FROM field_stock f JOIN users u ON u.id = f.promoter_id JOIN campaigns c ON c.id = f.campaign_id
         WHERE f.product_id = ? AND f.qty > 0 ORDER BY u.name`,
      )
      .all(id);
    product.variants = product.style
      ? db
          .prepare(
            `SELECT p.id, p.sku, p.gender, p.size, p.colour,
               COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand
             FROM products p WHERE p.style = ? AND p.client_id = ? AND p.active = 1`,
          )
          .all(product.style, product.client_id)
      : [];
    product.movements = db
      .prepare(`${MOVEMENT_SELECT} WHERE m.product_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 50`)
      .all(id);
    res.json(product);
  });

  const fields = (b) => {
    const category = v.oneOf(b.category, 'Category', CATEGORIES, { required: true });
    const isUniform = category === 'Uniform';
    return {
      sku: v.str(b.sku, 'SKU', { required: true, max: 40 }).toUpperCase(),
      name: v.str(b.name, 'Product name', { required: true }),
      client_id: v.int(b.client_id, 'Client', { required: true }),
      category,
      unit: v.str(b.unit, 'Unit') || 'unit',
      unit_cost: v.num(b.unit_cost, 'Unit cost', { min: 0 }) ?? 0,
      reorder_level: v.int(b.reorder_level, 'Reorder level', { min: 0 }) ?? 0,
      barcode: v.str(b.barcode, 'Barcode'),
      gender: isUniform ? v.oneOf(b.gender, 'Gender', GENDERS) : null,
      size: isUniform ? v.str(b.size, 'Size', { max: 10 }) : null,
      colour: isUniform ? v.str(b.colour, 'Colour', { max: 30 }) : null,
      style: v.str(b.style, 'Style / range', { max: 80 }),
      tracks_expiry: b.tracks_expiry ? 1 : 0,
      active: b.active === undefined ? 1 : b.active ? 1 : 0,
    };
  };
  const COLS = ['sku', 'name', 'client_id', 'category', 'unit', 'unit_cost', 'reorder_level', 'barcode', 'gender', 'size', 'colour', 'style', 'tracks_expiry', 'active'];

  const assertClient = (user, clientId) => {
    const client = v.found(db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId), 'Client');
    if (user.role === 'account_manager' && client.account_manager_id !== user.id) {
      throw new HttpError(403, 'You can only manage products for your own clients');
    }
  };

  const insertProduct = (f) =>
    db
      .prepare(`INSERT INTO products (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`)
      .run(...COLS.map((c) => f[c])).lastInsertRowid;

  r.post('/', allow(MANAGEMENT, 'account_manager', 'warehouse_manager'), (req, res) => {
    const f = fields(req.body);
    assertClient(req.user, f.client_id);
    if (db.prepare('SELECT 1 FROM products WHERE sku = ?').get(f.sku)) throw new HttpError(409, `SKU ${f.sku} already exists`);
    const id = insertProduct(f);
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  });

  /**
   * Create a uniform range in one go: every gender x colour x size combination
   * becomes its own SKU, e.g. JRU-POLO-F-BLACK-M.
   */
  r.post('/range', allow(MANAGEMENT, 'account_manager', 'warehouse_manager'), (req, res) => {
    const b = req.body;
    const prefix = v.str(b.sku_prefix, 'SKU prefix', { required: true, max: 20 }).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const style = v.str(b.style, 'Style name', { required: true, max: 80 });
    const clientId = v.int(b.client_id, 'Client', { required: true });
    assertClient(req.user, clientId);
    const genders = (Array.isArray(b.genders) ? b.genders : []).map((g) => v.oneOf(g, 'Gender', GENDERS, { required: true }));
    const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map((s) => v.str(s, 'Size', { required: true, max: 10 }).toUpperCase());
    const colours = (Array.isArray(b.colours) ? b.colours : String(b.colours || '').split(','))
      .map((c) => String(c).trim())
      .filter(Boolean);
    if (!genders.length || !sizes.length || !colours.length) throw new HttpError(400, 'Choose at least one gender, size and colour');
    if (genders.length * sizes.length * colours.length > 300) throw new HttpError(400, 'That is more than 300 variants; split the range up');
    const created = [];
    const skipped = [];
    tx(db, () => {
      for (const gender of genders) {
        for (const colour of colours) {
          for (const size of sizes) {
            const sku = `${prefix}-${gender[0].toUpperCase()}-${colour.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}-${size}`;
            if (db.prepare('SELECT 1 FROM products WHERE sku = ?').get(sku)) {
              skipped.push(sku);
              continue;
            }
            const genderLabel = { female: 'Ladies', male: 'Mens', unisex: 'Unisex' }[gender];
            insertProduct({
              sku,
              name: `${style} (${genderLabel} · ${colour} · ${size})`,
              client_id: clientId,
              category: 'Uniform',
              unit: 'unit',
              unit_cost: v.num(b.unit_cost, 'Unit cost', { min: 0 }) ?? 0,
              reorder_level: v.int(b.reorder_level, 'Reorder level', { min: 0 }) ?? 0,
              barcode: null,
              gender,
              size,
              colour,
              style,
              tracks_expiry: 0,
              active: 1,
            });
            created.push(sku);
          }
        }
      }
    });
    res.status(201).json({ created, skipped });
  });

  r.put('/:id', allow(MANAGEMENT, 'account_manager', 'warehouse_manager'), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const existing = v.found(db.prepare('SELECT * FROM products WHERE id = ?').get(id), 'Product');
    assertClient(req.user, existing.client_id);
    const f = fields(req.body);
    assertClient(req.user, f.client_id);
    if (db.prepare('SELECT 1 FROM products WHERE sku = ? AND id != ?').get(f.sku, id)) {
      throw new HttpError(409, `SKU ${f.sku} already exists`);
    }
    tx(db, () => {
      db.prepare(`UPDATE products SET ${COLS.map((c) => `${c}=?`).join(', ')} WHERE id=?`).run(...COLS.map((c) => f[c]), id);
      if (f.tracks_expiry !== existing.tracks_expiry) stock.setTracking(db, id, !!f.tracks_expiry);
    });
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
          `SELECT f.product_id, p.sku, p.name AS product_name, p.unit, p.category, f.campaign_id, c.name AS campaign_name, f.qty
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
          `SELECT f.*, p.sku, p.name AS product_name, p.unit_cost, p.category, cl.name AS client_name,
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
          batchNo: v.str(line.batch_no, 'Batch number', { max: 40 }),
          expiryDate: v.date(line.expiry_date, 'Expiry date'),
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
    res.status(201).json({ ok: true, lines: lines.length, reference });
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

  // Batches that have expired or expire within `days` (default 60)
  r.get('/expiry', allow(STOCK_ROLES), (req, res) => {
    const scope = clientScope(req.user);
    const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 3650);
    res.json(
      db
        .prepare(
          `SELECT b.*, p.sku, p.name AS product_name, p.unit_cost, cl.name AS client_name, w.name AS warehouse_name,
             CAST(julianday(b.expiry_date) - julianday(?) AS INTEGER) AS days_left
           FROM stock_batches b JOIN products p ON p.id = b.product_id JOIN clients cl ON cl.id = p.client_id
           JOIN warehouses w ON w.id = b.warehouse_id
           WHERE b.qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ? AND ${scope.sql}
           ORDER BY b.expiry_date, p.name`,
        )
        .all(stock.saToday(), stock.saToday(days), ...scope.params),
    );
  });

  r.post('/write-off-expired', allow(STOCK_APPROVERS), (req, res) => {
    const productId = v.int(req.body.product_id, 'Product', { required: true });
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const units = tx(db, () =>
      stock.writeOffExpired(db, { productId, warehouseId, note: v.str(req.body.note, 'Note'), userId: req.user.id }),
    );
    if (!units) throw new HttpError(409, 'Nothing has expired for that product in that warehouse');
    res.json({ ok: true, units });
  });

  // Uniforms waiting to be washed and ironed
  r.get('/laundry', allow(STOCK_ROLES), (req, res) => {
    const scope = clientScope(req.user);
    res.json(
      db
        .prepare(
          `SELECT l.*, p.sku, p.name AS product_name, p.size, p.colour, p.gender, cl.name AS client_name, w.name AS warehouse_name
           FROM laundry_stock l JOIN products p ON p.id = l.product_id JOIN clients cl ON cl.id = p.client_id
           JOIN warehouses w ON w.id = l.warehouse_id
           WHERE l.qty > 0 AND ${scope.sql} ORDER BY w.name, p.name`,
        )
        .all(...scope.params),
    );
  });

  r.post('/laundry/clean', allow(OPERATORS), (req, res) => {
    const lines = v.items(req.body.items);
    tx(db, () => {
      for (const line of lines) {
        stock.launder(db, {
          productId: v.int(line.product_id, 'Product', { required: true }),
          warehouseId: v.int(line.warehouse_id, 'Warehouse', { required: true }),
          qty: v.int(line.qty, 'Quantity', { required: true, min: 1 }),
          userId: req.user.id,
        });
      }
    });
    res.json({ ok: true });
  });

  // Direct correction by a manager (e.g. after an investigation). Day-to-day counting goes through /counts.
  r.post('/count', allow(STOCK_APPROVERS), (req, res) => {
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const note = v.str(req.body.note, 'Reason for the correction', { required: true });
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
      ['Batch', 'batch_no'],
      ['Expiry', 'expiry_date'],
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
    const rows = prepareNumbered(db, q.sql).all(...q.params);
    const showCost = isManagement(req.user) || req.user.role === 'account_manager';
    const columns = [
      ['SKU', 'sku'],
      ['Product', 'name'],
      ['Client', 'client_name'],
      ['Category', 'category'],
      ['Gender', 'gender'],
      ['Size', 'size'],
      ['Colour', 'colour'],
      ['On hand', 'on_hand'],
      ['Expired', 'expired'],
      ['Next expiry', 'next_expiry'],
      ['At laundry', 'in_laundry'],
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

module.exports = { productRoutes, stockRoutes, MOVEMENT_SELECT, CATEGORIES, sendCsv, prepareNumbered };
