'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { MANAGEMENT, WAREHOUSE, HttpError, allow, isManagement, isWarehouse } = require('../auth');
const v = require('../validate');
const { tx } = require('../db');

/**
 * QR code contents:
 *   JRP:<SKU>[:<batch>]  product label (optionally a specific batch)
 *   JRU:<badge code>     promoter ID badge
 *   JRR:<request ref>    picking slip / stock request
 *   JRC:<campaign id>    campaign shelf sign
 * Plain SKUs, barcodes and REQ-/RET- references are recognised too, so
 * ordinary handheld barcode scanners work as well.
 */
function qrRoutes(db) {
  const r = express.Router();

  r.get('/qr.svg', async (req, res, next) => {
    try {
      const text = v.str(req.query.text, 'Text', { required: true, max: 200 });
      const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'private, max-age=604800');
      res.send(svg);
    } catch (err) {
      next(err);
    }
  });

  r.get('/scan', (req, res) => {
    const raw = v.str(req.query.code, 'Code', { required: true, max: 200 });
    const [prefix, a, b] = raw.split(':');
    const user = req.user;
    const seesStock = user.role !== 'promoter';

    if (prefix === 'JRU') {
      if (!isManagement(user) && !isWarehouse(user)) throw new HttpError(403, 'Only warehouse and office staff can scan promoter badges');
      const promoter = db
        .prepare("SELECT id, name, phone, region, active FROM users WHERE badge_code = ? AND role = 'promoter'")
        .get(a || '');
      if (!promoter) throw new HttpError(404, 'Unknown or replaced promoter badge');
      if (!promoter.active) throw new HttpError(409, `${promoter.name}'s account is deactivated`);
      return res.json({ kind: 'promoter', promoter });
    }

    if (prefix === 'JRC') {
      const campaign = db.prepare('SELECT id, name FROM campaigns WHERE id = ?').get(Number(a));
      if (!campaign) throw new HttpError(404, 'Unknown campaign sign');
      return res.json({ kind: 'campaign', id: campaign.id, name: campaign.name });
    }

    const findProduct = (sku) => db.prepare('SELECT id, sku, name, category FROM products WHERE sku = ?').get(sku);
    if (prefix === 'JRP') {
      const product = findProduct(a || '');
      if (!product) throw new HttpError(404, 'Unknown product label');
      return res.json({ kind: 'product', product, batch_no: b || null, can_view: seesStock });
    }

    const ref = prefix === 'JRR' ? a : raw;
    const request = db.prepare('SELECT id, ref, promoter_id FROM requests WHERE ref = ?').get(ref.toUpperCase());
    if (request) return res.json({ kind: 'request', id: request.id, ref: request.ref });
    const ret = db.prepare('SELECT id, ref FROM returns WHERE ref = ?').get(ref.toUpperCase());
    if (ret) return res.json({ kind: 'return', id: ret.id, ref: ret.ref });

    const product = findProduct(raw) || db.prepare('SELECT id, sku, name, category FROM products WHERE barcode = ?').get(raw);
    if (product) return res.json({ kind: 'product', product, batch_no: null, can_view: seesStock });
    throw new HttpError(404, `Nothing found for "${raw}"`);
  });

  return r;
}

/** Kits: ready-made sets such as a tasting-table setup, added to requests in one go. */
function kitRoutes(db) {
  const r = express.Router();

  const load = (id) => {
    const kit = db.prepare('SELECT * FROM kits WHERE id = ?').get(id);
    if (!kit) return null;
    kit.items = db
      .prepare(
        `SELECT ki.product_id, ki.qty, p.sku, p.name AS product_name, p.category, p.client_id, cl.is_house
         FROM kit_items ki JOIN products p ON p.id = ki.product_id JOIN clients cl ON cl.id = p.client_id
         WHERE ki.kit_id = ? ORDER BY p.category, p.name`,
      )
      .all(id);
    return kit;
  };

  r.get('/', (req, res) => {
    const ids = db.prepare(`SELECT id FROM kits ${req.query.all ? '' : 'WHERE active = 1'} ORDER BY name`).all();
    res.json(ids.map((k) => load(k.id)));
  });

  const save = (req, id) => {
    const b = req.body;
    const items = v.items(b.items).map((i) => ({
      productId: v.int(i.product_id, 'Product', { required: true }),
      qty: v.int(i.qty, 'Quantity', { required: true, min: 1 }),
    }));
    if (new Set(items.map((i) => i.productId)).size !== items.length) throw new HttpError(400, 'Each product may appear once');
    return tx(db, () => {
      const name = v.str(b.name, 'Kit name', { required: true, max: 80 });
      const clash = db.prepare('SELECT id FROM kits WHERE name = ? AND id != ?').get(name, id || 0);
      if (clash) throw new HttpError(409, 'A kit with that name exists');
      const fields = [name, v.str(b.description, 'Description', { max: 500 }), b.active === undefined ? 1 : b.active ? 1 : 0];
      if (id) db.prepare('UPDATE kits SET name = ?, description = ?, active = ? WHERE id = ?').run(...fields, id);
      else id = db.prepare('INSERT INTO kits (name, description, active) VALUES (?, ?, ?)').run(...fields).lastInsertRowid;
      db.prepare('DELETE FROM kit_items WHERE kit_id = ?').run(id);
      const ins = db.prepare('INSERT INTO kit_items (kit_id, product_id, qty) VALUES (?, ?, ?)');
      for (const i of items) ins.run(id, i.productId, i.qty);
      return id;
    });
  };

  r.post('/', allow(MANAGEMENT, WAREHOUSE), (req, res) => res.status(201).json(load(save(req))));
  r.put('/:id', allow(MANAGEMENT, WAREHOUSE), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    v.found(load(id), 'Kit');
    res.json(load(save(req, id)));
  });

  return r;
}

module.exports = { qrRoutes, kitRoutes };
