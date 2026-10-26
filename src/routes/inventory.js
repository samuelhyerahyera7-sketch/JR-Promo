'use strict';

const express = require('express');
const { MANAGEMENT, WAREHOUSE, STOCK_APPROVERS, HttpError, allow } = require('../auth');
const v = require('../validate');
const stock = require('../stock');
const { tx } = require('../db');
const { clientScope } = require('../access');
const { toCsv } = require('../csv');
const { checkScansOut } = require('../scanout');

const CATEGORIES = [
  'Sample',
  'Giveaway',
  'POS Material',
  'Merchandise',
  'Uniform',
  'Promoter Table',
  'Gazebo',
  'Backwall Banner',
  'Pull-up Banner',
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
  if (query.campaign_id) add('p.campaign_id = ?', Number(query.campaign_id));
  if (query.q) {
    where.push('(p.sku ILIKE ? OR p.name ILIKE ? OR p.barcode = ? OR p.colour ILIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`, query.q, `%${query.q}%`);
  }
  if (query.active !== 'all') where.push('p.active = 1');
  if (query.id) add('p.id = ?', Number(query.id));
  // Filters on the totals apply to the outer query, where the totals have names
  let having = 'TRUE';
  if (query.low === '1') having = 'x.on_hand <= x.reorder_level';
  if (query.expiring === '1') having = 'x.expiring > 0 OR x.expired > 0';
  return {
    sql: `SELECT * FROM (SELECT p.*, cl.name AS client_name, cl.is_house, sc.name AS shelf_campaign, sc.colour AS shelf_colour,
            COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand,
            COALESCE((SELECT SUM(qty) FROM field_stock f WHERE f.product_id = p.id), 0) AS in_field,
            COALESCE((SELECT SUM(qty) FROM laundry_stock l WHERE l.product_id = p.id), 0) AS in_laundry,
            COALESCE((SELECT SUM(ri.qty_approved) FROM request_items ri JOIN requests r ON r.id = ri.request_id
                      WHERE ri.product_id = p.id AND r.status IN ('approved','picking')), 0) AS allocated,
            COALESCE((SELECT SUM(qty) FROM stock_batches b WHERE b.product_id = p.id AND b.expiry_date < ?1), 0) AS expired,
            COALESCE((SELECT SUM(qty) FROM stock_batches b WHERE b.product_id = p.id
                      AND b.expiry_date >= ?1 AND b.expiry_date <= ?2), 0) AS expiring,
            (SELECT MIN(expiry_date) FROM stock_batches b WHERE b.product_id = p.id AND b.qty > 0 AND b.expiry_date >= ?1) AS next_expiry
          FROM products p JOIN clients cl ON cl.id = p.client_id LEFT JOIN campaigns sc ON sc.id = p.campaign_id
          WHERE ${where.join(' AND ')}) x
          WHERE ${having}
          ORDER BY x.is_house DESC, x.client_name, x.style NULLS FIRST, x.name`,
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
  return db.stmt(numbered);
}

/** A product can only be shelved under a campaign of its own client (or any campaign, for company stock). */
async function assertShelfCampaign(db, campaignId, clientId) {
  if (!campaignId) return;
  const c = (await db.get('SELECT client_id FROM campaigns WHERE id = ?', campaignId));
  if (!c) throw new HttpError(400, 'Shelf campaign not found');
  const house = (await db.get('SELECT is_house FROM clients WHERE id = ?', clientId));
  if (c.client_id !== clientId && !(house && house.is_house)) throw new HttpError(400, "That campaign is for a different client");
}

/** SKUs go into QR codes, so they can't contain the code separators. */
function skuOf(value) {
  const sku = v.str(value, 'SKU', { required: true, max: 40 }).toUpperCase();
  if (/[:|\s]/.test(sku)) throw new HttpError(400, 'SKU cannot contain spaces, ":" or "|"');
  return sku;
}

/** Active packs (6-pack, box of 24…) per product: Map(productId → [{id, name, qty, barcode}]). */
async function packsByProduct(db, productId) {
  const rows = (await db.all(`SELECT id, product_id, name, qty, barcode FROM product_packs WHERE active = 1 ${productId ? 'AND product_id = ?' : ''} ORDER BY qty`, ...(productId ? [productId] : [])));
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.product_id)) map.set(r.product_id, []);
    map.get(r.product_id).push(r);
  }
  return map;
}

/**
 * Replace a product's packs. Packs are matched on size, so a pack's QR code
 * (JRK:<SKU>:<qty>) keeps working when it is renamed. Removed packs are retired,
 * not deleted, because past scans refer to them.
 */
async function savePacks(db, productId, list) {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new HttpError(400, 'Packs must be a list');
  const packs = list.map((p) => {
    const qty = v.int(p.qty, 'Units per pack', { required: true, min: 2, max: 10000 });
    return { qty, name: v.str(p.name, 'Pack name', { max: 40 }) || `Pack of ${qty}`, barcode: v.str(p.barcode, 'Pack barcode', { max: 60 }) };
  });
  if (new Set(packs.map((p) => p.qty)).size !== packs.length) throw new HttpError(400, 'Two packs have the same number of units');
  for (const p of packs) {
    if (!p.barcode) continue;
    const clash =
      (await db.get('SELECT 1 FROM product_packs WHERE barcode = ? AND product_id != ?', p.barcode, productId)) ||
      (await db.get('SELECT 1 FROM products WHERE barcode = ?', p.barcode));
    if (clash) throw new HttpError(409, `Barcode ${p.barcode} is already used`);
  }
  (await db.run('UPDATE product_packs SET active = 0 WHERE product_id = ?', productId));
  const up = db.stmt(
    `INSERT INTO product_packs (product_id, name, qty, barcode, active) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (product_id, qty) DO UPDATE SET name = excluded.name, barcode = excluded.barcode, active = 1`,
  );
  // Clear barcodes first so swapping a barcode between two packs doesn't trip the unique index
  (await db.run('UPDATE product_packs SET barcode = NULL WHERE product_id = ?', productId));
  for (const p of packs) await up.run(productId, p.name, p.qty, p.barcode);
}

function productRoutes(db) {
  const r = express.Router();

  r.get('/categories', (req, res) => res.json(CATEGORIES));
  r.get('/sizes', (req, res) => res.json(SIZES));

  r.get('/', allow(STOCK_ROLES), async (req, res) => {
    const q = productQuery(req.user, req.query);
    const rows = await prepareNumbered(db, q.sql).all(...q.params);
    const levels = (await db.all('SELECT product_id, warehouse_id, qty, bin FROM stock WHERE qty > 0'));
    const byProduct = new Map();
    for (const l of levels) {
      if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
      byProduct.get(l.product_id).push(l);
    }
    const packs = await packsByProduct(db);
    for (const row of rows) {
      row.available = row.on_hand - row.allocated - row.expired;
      row.levels = byProduct.get(row.id) || [];
      row.packs = packs.get(row.id) || [];
    }
    res.json(rows);
  });

  r.get('/:id', allow(STOCK_ROLES), async (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const q = productQuery(req.user, { active: 'all', id });
    const product = v.found(await prepareNumbered(db, q.sql).get(...q.params), 'Product');
    product.available = product.on_hand - product.allocated - product.expired;
    product.packs = (await packsByProduct(db, id)).get(id) || [];
    product.levels = (await db.all(`SELECT s.warehouse_id, w.name AS warehouse_name, s.qty, s.bin,
           COALESCE((SELECT qty FROM laundry_stock l WHERE l.product_id = s.product_id AND l.warehouse_id = s.warehouse_id), 0) AS laundry
         FROM stock s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.product_id = ? ORDER BY w.name`, id));
    product.batches = (await db.all(`SELECT b.*, w.name AS warehouse_name FROM stock_batches b JOIN warehouses w ON w.id = b.warehouse_id
         WHERE b.product_id = ? AND b.qty > 0 ORDER BY b.expiry_date IS NULL, b.expiry_date, w.name`, id));
    product.field = (await db.all(`SELECT f.promoter_id, u.name AS promoter_name, f.campaign_id, c.name AS campaign_name, f.qty
         FROM field_stock f JOIN users u ON u.id = f.promoter_id JOIN campaigns c ON c.id = f.campaign_id
         WHERE f.product_id = ? AND f.qty > 0 ORDER BY u.name`, id));
    product.variants = product.style
      ? (await db.all(`SELECT p.id, p.sku, p.gender, p.size, p.colour,
               COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand
             FROM products p WHERE p.style = ? AND p.client_id = ? AND p.active = 1`, product.style, product.client_id))
      : [];
    product.movements = (await db.all(`${MOVEMENT_SELECT} WHERE m.product_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 50`, id));
    res.json(product);
  });

  const fields = (b) => {
    const category = v.oneOf(b.category, 'Category', CATEGORIES, { required: true });
    const isUniform = category === 'Uniform';
    return {
      sku: skuOf(b.sku),
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
      campaign_id: v.int(b.campaign_id, 'Shelf campaign'),
      tracks_expiry: b.tracks_expiry ? 1 : 0,
      active: b.active === undefined ? 1 : b.active ? 1 : 0,
    };
  };
  const COLS = ['sku', 'name', 'client_id', 'category', 'unit', 'unit_cost', 'reorder_level', 'barcode', 'gender', 'size', 'colour', 'style', 'campaign_id', 'tracks_expiry', 'active'];

  const assertClient = async (user, clientId) => {
    const client = v.found((await db.get('SELECT * FROM clients WHERE id = ?', clientId)), 'Client');
    if (user.role === 'account_manager' && client.account_manager_id !== user.id) {
      throw new HttpError(403, 'You can only manage products for your own clients');
    }
  };

  const insertProduct = async (f) =>
    (await db.insert(`INSERT INTO products (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`, ...COLS.map((c) => f[c])));

  r.post('/', allow(MANAGEMENT, 'account_manager', 'warehouse_manager'), async (req, res) => {
    const f = fields(req.body);
    await assertClient(req.user, f.client_id);
    await assertShelfCampaign(db, f.campaign_id, f.client_id);
    if ((await db.get('SELECT 1 FROM products WHERE sku = ?', f.sku))) throw new HttpError(409, `SKU ${f.sku} already exists`);
    const id = await tx(db, async () => {
      const newId = await insertProduct(f);
      await savePacks(db, newId, req.body.packs);
      return newId;
    });
    res.status(201).json({ ...(await db.get('SELECT * FROM products WHERE id = ?', id)), packs: (await packsByProduct(db, id)).get(id) || [] });
  });

  /**
   * Create a uniform range in one go: every gender x colour x size combination
   * becomes its own SKU, e.g. JRU-POLO-F-BLACK-M.
   */
  r.post('/range', allow(MANAGEMENT, 'account_manager', 'warehouse_manager'), async (req, res) => {
    const b = req.body;
    const prefix = v.str(b.sku_prefix, 'SKU prefix', { required: true, max: 20 }).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const style = v.str(b.style, 'Style name', { required: true, max: 80 });
    const clientId = v.int(b.client_id, 'Client', { required: true });
    await assertClient(req.user, clientId);
    const genders = (Array.isArray(b.genders) ? b.genders : []).map((g) => v.oneOf(g, 'Gender', GENDERS, { required: true }));
    const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map((s) => v.str(s, 'Size', { required: true, max: 10 }).toUpperCase());
    const colours = (Array.isArray(b.colours) ? b.colours : String(b.colours || '').split(','))
      .map((c) => String(c).trim())
      .filter(Boolean);
    if (!genders.length || !sizes.length || !colours.length) throw new HttpError(400, 'Choose at least one gender, size and colour');
    if (genders.length * sizes.length * colours.length > 300) throw new HttpError(400, 'That is more than 300 variants; split the range up');
    const created = [];
    const skipped = [];
    await tx(db, async () => {
      for (const gender of genders) {
        for (const colour of colours) {
          for (const size of sizes) {
            const sku = `${prefix}-${gender[0].toUpperCase()}-${colour.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}-${size}`;
            if ((await db.get('SELECT 1 FROM products WHERE sku = ?', sku))) {
              skipped.push(sku);
              continue;
            }
            const genderLabel = { female: 'Ladies', male: 'Mens', unisex: 'Unisex' }[gender];
            await insertProduct({
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
              campaign_id: null,
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

  r.put('/:id', allow(MANAGEMENT, 'account_manager', 'warehouse_manager'), async (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const existing = v.found((await db.get('SELECT * FROM products WHERE id = ?', id)), 'Product');
    await assertClient(req.user, existing.client_id);
    // Fields the screens don't edit keep their stored values
    const f = fields({ unit_cost: existing.unit_cost, campaign_id: existing.campaign_id, ...req.body });
    await assertClient(req.user, f.client_id);
    await assertShelfCampaign(db, f.campaign_id, f.client_id);
    if ((await db.get('SELECT 1 FROM products WHERE sku = ? AND id != ?', f.sku, id))) {
      throw new HttpError(409, `SKU ${f.sku} already exists`);
    }
    await tx(db, async () => {
      (await db.run(`UPDATE products SET ${COLS.map((c) => `${c}=?`).join(', ')} WHERE id=?`, ...COLS.map((c) => f[c]), id));
      if (f.tracks_expiry !== existing.tracks_expiry) await stock.setTracking(db, id, !!f.tracks_expiry);
      await savePacks(db, id, req.body.packs);
    });
    res.json({ ...(await db.get('SELECT * FROM products WHERE id = ?', id)), packs: (await packsByProduct(db, id)).get(id) || [] });
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
  r.get('/mine', allow('promoter'), async (req, res) => {
    res.json(
      (await db.all(`SELECT f.product_id, p.sku, p.name AS product_name, p.unit, p.category, f.campaign_id, c.name AS campaign_name, f.qty
           FROM field_stock f JOIN products p ON p.id = f.product_id JOIN campaigns c ON c.id = f.campaign_id
           WHERE f.promoter_id = ? AND f.qty > 0 ORDER BY c.name, p.name`, req.user.id)),
    );
  });

  // Everything currently out with promoters
  r.get('/field', allow(STOCK_ROLES), async (req, res) => {
    const scope = clientScope(req.user);
    res.json(
      (await db.all(`SELECT f.*, p.sku, p.name AS product_name, p.category, cl.name AS client_name,
                  u.name AS promoter_name, u.region, c.name AS campaign_name, c.status AS campaign_status, c.colour AS campaign_colour
           FROM field_stock f JOIN products p ON p.id = f.product_id JOIN clients cl ON cl.id = p.client_id
           JOIN users u ON u.id = f.promoter_id JOIN campaigns c ON c.id = f.campaign_id
           WHERE f.qty > 0 AND ${scope.sql} ORDER BY u.name, c.name, p.name`, ...scope.params)),
    );
  });

  r.post('/receive', allow(OPERATORS), async (req, res) => {
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const reference = v.str(req.body.reference, 'Reference (GRN / delivery note)', { required: true, max: 80 });
    const note = v.str(req.body.note, 'Note');
    const campaignId = v.int(req.body.campaign_id, 'Campaign');
    const lines = v.items(req.body.items);
    await tx(db, async () => {
      for (const line of lines) {
        // Stock received for a campaign is shelved under that campaign's colour
        if (campaignId) {
          const product = (await db.get('SELECT client_id FROM products WHERE id = ?', Number(line.product_id)));
          if (product) {
            await assertShelfCampaign(db, campaignId, product.client_id);
            (await db.run('UPDATE products SET campaign_id = ? WHERE id = ?', campaignId, Number(line.product_id)));
          }
        }
        await stock.receive(db, {
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
          (await db.run('UPDATE stock SET bin = ? WHERE product_id = ? AND warehouse_id = ?', v.str(line.bin, 'Bin', { max: 30 }),
            line.product_id,
            warehouseId));
        }
      }
    });
    res.status(201).json({ ok: true, lines: lines.length, reference });
  });

  r.post('/transfer', allow(OPERATORS), async (req, res) => {
    const fromWarehouseId = v.int(req.body.from_warehouse_id, 'From warehouse', { required: true });
    const toWarehouseId = v.int(req.body.to_warehouse_id, 'To warehouse', { required: true });
    const reference = v.str(req.body.reference, 'Reference', { max: 80 }) || `TRF-${Date.now().toString(36).toUpperCase()}`;
    const note = v.str(req.body.note, 'Note');
    const lines = v.items(req.body.items);
    if (fromWarehouseId === toWarehouseId) throw new HttpError(400, 'Choose two different warehouses');
    await tx(db, async () => {
      const expected = new Map();
      for (const line of lines) {
        const id = v.int(line.product_id, 'Product', { required: true });
        expected.set(id, (expected.get(id) || 0) + v.int(line.qty, 'Quantity', { required: true, min: 1 }));
      }
      for (const line of lines) {
        await stock.transfer(db, {
          productId: v.int(line.product_id, 'Product', { required: true }),
          fromWarehouseId,
          toWarehouseId,
          qty: v.int(line.qty, 'Quantity', { required: true, min: 1 }),
          reference,
          note,
          userId: req.user.id,
        });
      }
      await checkScansOut(db, req.user, { kind: 'transfer', reference, warehouseId: fromWarehouseId, expected, scans: req.body.scans, override: req.body.scan_override });
    });
    res.status(201).json({ ok: true, reference });
  });

  // Batches that have expired or expire within `days` (default 60)
  r.get('/expiry', allow(STOCK_ROLES), async (req, res) => {
    const scope = clientScope(req.user);
    const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 3650);
    res.json(
      (await db.all(`SELECT b.*, p.sku, p.name AS product_name, cl.name AS client_name, w.name AS warehouse_name,
             (b.expiry_date::date - ?::date) AS days_left
           FROM stock_batches b JOIN products p ON p.id = b.product_id JOIN clients cl ON cl.id = p.client_id
           JOIN warehouses w ON w.id = b.warehouse_id
           WHERE b.qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ? AND ${scope.sql}
           ORDER BY b.expiry_date, p.name`, stock.saToday(), stock.saToday(days), ...scope.params)),
    );
  });

  r.post('/write-off-expired', allow(STOCK_APPROVERS), async (req, res) => {
    const productId = v.int(req.body.product_id, 'Product', { required: true });
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const units = await tx(db, async () =>
      await stock.writeOffExpired(db, { productId, warehouseId, note: v.str(req.body.note, 'Note'), userId: req.user.id }),
    );
    if (!units) throw new HttpError(409, 'Nothing has expired for that product in that warehouse');
    res.json({ ok: true, units });
  });

  // Uniforms waiting to be washed and ironed
  r.get('/laundry', allow(STOCK_ROLES), async (req, res) => {
    const scope = clientScope(req.user);
    res.json(
      (await db.all(`SELECT l.*, p.sku, p.name AS product_name, p.size, p.colour, p.gender, cl.name AS client_name, w.name AS warehouse_name
           FROM laundry_stock l JOIN products p ON p.id = l.product_id JOIN clients cl ON cl.id = p.client_id
           JOIN warehouses w ON w.id = l.warehouse_id
           WHERE l.qty > 0 AND ${scope.sql} ORDER BY w.name, p.name`, ...scope.params)),
    );
  });

  r.post('/laundry/clean', allow(OPERATORS), async (req, res) => {
    const lines = v.items(req.body.items);
    await tx(db, async () => {
      for (const line of lines) {
        await stock.launder(db, {
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
  r.post('/count', allow(STOCK_APPROVERS), async (req, res) => {
    const warehouseId = v.int(req.body.warehouse_id, 'Warehouse', { required: true });
    const note = v.str(req.body.note, 'Reason for the correction', { required: true });
    const lines = v.items(req.body.items);
    const variances = await tx(db, async () => {
      const out = [];
      for (const line of lines) {
        const productId = v.int(line.product_id, 'Product', { required: true });
        const delta = await stock.adjustTo(db, {
          productId,
          warehouseId,
          countedQty: v.int(line.counted, 'Counted quantity', { required: true, min: 0 }),
          note,
          userId: req.user.id,
        });
        out.push({ product_id: productId, variance: delta });
      }
      return out;
    });
    res.json({ ok: true, variances });
  });

  r.get('/movements', allow(STOCK_ROLES), async (req, res) => {
    const q = movementQuery(req.user, req.query);
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json((await db.all(`${q.sql} LIMIT ${limit}`, ...q.params)));
  });

  r.get('/movements.csv', allow(STOCK_ROLES), async (req, res) => {
    const q = movementQuery(req.user, req.query);
    const rows = (await db.all(q.sql, ...q.params));
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

  r.get('/levels.csv', allow(STOCK_ROLES), async (req, res) => {
    const q = productQuery(req.user, req.query);
    const rows = await prepareNumbered(db, q.sql).all(...q.params);
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
      ['Shelf campaign', 'shelf_campaign'],
      ['Shelf colour', 'shelf_colour'],
    ];
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
