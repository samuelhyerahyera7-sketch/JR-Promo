'use strict';

const express = require('express');
const { MANAGEMENT, HttpError, allow, isManagement } = require('../auth');
const v = require('../validate');
const { clientScope } = require('../access');

const OPERATORS = [MANAGEMENT, 'warehouse'];
const MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Photos and scans (waybills, delivery notes, damage photos) attached to
 * inbound deliveries ("receipt", keyed by GRN reference + warehouse),
 * stock requests and returns. Files are stored in the database so a
 * single-file backup covers them.
 */
function attachmentRoutes(db) {
  const r = express.Router();

  /** Throws unless the user may see / add files on the attachment's parent. */
  function assertParent(user, a, { write = false } = {}) {
    if (a.kind === 'receipt') {
      if (write ? ![...MANAGEMENT, 'warehouse'].includes(user.role) : user.role === 'promoter') {
        throw new HttpError(403, 'Only warehouse and office staff can manage delivery photos');
      }
      const exists = db
        .prepare("SELECT 1 FROM movements WHERE type = 'receipt' AND reference = ? AND to_warehouse_id = ?")
        .get(a.reference, a.warehouse_id);
      if (!exists) throw new HttpError(404, 'Delivery not found');
      return;
    }
    if (isManagement(user) || user.role === 'warehouse') return;
    const table = a.kind === 'request' ? 'requests' : 'returns';
    const id = a.kind === 'request' ? a.request_id : a.return_id;
    const row = db
      .prepare(`SELECT t.promoter_id, c.account_manager_id FROM ${table} t JOIN campaigns c ON c.id = t.campaign_id WHERE t.id = ?`)
      .get(id);
    if (!row) throw new HttpError(404, 'Not found');
    const ok = user.role === 'promoter' ? row.promoter_id === user.id : row.account_manager_id === user.id;
    if (!ok) throw new HttpError(404, 'Not found');
  }

  r.post('/', (req, res) => {
    const b = req.body;
    const kind = v.oneOf(b.kind, 'Kind', ['receipt', 'request', 'return'], { required: true });
    const a = {
      kind,
      reference: kind === 'receipt' ? v.str(b.reference, 'Delivery reference', { required: true, max: 80 }) : null,
      warehouse_id: kind === 'receipt' ? v.int(b.warehouse_id, 'Warehouse', { required: true }) : null,
      request_id: kind === 'request' ? v.int(b.request_id, 'Request', { required: true }) : null,
      return_id: kind === 'return' ? v.int(b.return_id, 'Return', { required: true }) : null,
    };
    assertParent(req.user, a, { write: true });
    const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(b.data || ''));
    if (!match) throw new HttpError(400, 'Attach a photo or PDF');
    const mime = match[1];
    if (!MIME.includes(mime)) throw new HttpError(400, 'Only JPG, PNG, WebP photos or PDF files can be uploaded');
    const data = Buffer.from(match[2], 'base64');
    if (data.length > MAX_BYTES) throw new HttpError(400, 'File is larger than 8 MB');
    const location = v.geo(b.location);
    const info = db
      .prepare(
        `INSERT INTO attachments (kind, reference, warehouse_id, request_id, return_id, caption, filename, mime, size, data, uploaded_by,
           lat, lng, accuracy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.kind,
        a.reference,
        a.warehouse_id,
        a.request_id,
        a.return_id,
        v.str(b.caption, 'Caption', { max: 200 }),
        v.str(b.filename, 'File name', { max: 200 }),
        mime,
        data.length,
        data,
        req.user.id,
        location.lat,
        location.lng,
        location.accuracy,
      );
    res.status(201).json({ id: info.lastInsertRowid });
  });

  r.get('/', (req, res) => {
    const kind = v.oneOf(req.query.kind, 'Kind', ['receipt', 'request', 'return'], { required: true });
    const a = {
      kind,
      reference: req.query.reference,
      warehouse_id: Number(req.query.warehouse_id),
      request_id: Number(req.query.request_id),
      return_id: Number(req.query.return_id),
    };
    assertParent(req.user, a);
    const where = { receipt: 'a.reference = ? AND a.warehouse_id = ?', request: 'a.request_id = ?', return: 'a.return_id = ?' }[kind];
    const params = { receipt: [a.reference, a.warehouse_id], request: [a.request_id], return: [a.return_id] }[kind];
    res.json(
      db
        .prepare(
          `SELECT a.id, a.kind, a.caption, a.filename, a.mime, a.size, a.created_at, a.uploaded_by, a.lat, a.lng, a.accuracy, u.name AS uploaded_by_name
           FROM attachments a JOIN users u ON u.id = a.uploaded_by WHERE ${where} ORDER BY a.id`,
        )
        .all(...params),
    );
  });

  const load = (req) => {
    const a = v.found(db.prepare('SELECT * FROM attachments WHERE id = ?').get(v.int(req.params.id, 'id', { required: true })), 'File');
    assertParent(req.user, a);
    return a;
  };

  r.get('/:id/file', (req, res) => {
    const a = load(req);
    res.set('Content-Type', a.mime);
    res.set('Cache-Control', 'private, max-age=86400');
    const name = (a.filename || `attachment-${a.id}`).replace(/[^\w.-]+/g, '_');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.send(Buffer.from(a.data));
  });

  r.delete('/:id', (req, res) => {
    const a = load(req);
    if (a.uploaded_by !== req.user.id && !isManagement(req.user)) throw new HttpError(403, 'Only the uploader or management can delete this');
    db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
    res.json({ ok: true });
  });

  return r;
}

/** Inbound deliveries: receipts on the ledger grouped by reference and warehouse. */
function deliveryRoutes(db) {
  const r = express.Router();
  const ROLES = [MANAGEMENT, 'warehouse', 'account_manager'];

  r.get('/', allow(ROLES), (req, res) => {
    const scope = clientScope(req.user);
    const where = ["m.type = 'receipt'", scope.sql];
    const params = [...scope.params];
    if (req.query.warehouse_id) {
      where.push('m.to_warehouse_id = ?');
      params.push(Number(req.query.warehouse_id));
    }
    if (req.query.q) {
      where.push('(m.reference LIKE ? OR m.note LIKE ? OR cl.name LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.missing_photos === '1') {
      where.push("NOT EXISTS (SELECT 1 FROM attachments a WHERE a.kind = 'receipt' AND a.reference = m.reference AND a.warehouse_id = m.to_warehouse_id)");
    }
    res.json(
      db
        .prepare(
          `SELECT m.reference, m.to_warehouse_id AS warehouse_id, w.name AS warehouse_name, MIN(m.created_at) AS received_at,
             COUNT(*) AS lines, SUM(m.qty) AS units, SUM(m.qty * p.unit_cost) AS value,
             group_concat(DISTINCT cl.name) AS clients, MAX(m.note) AS note, MAX(u.name) AS received_by,
             (SELECT COUNT(*) FROM attachments a WHERE a.kind = 'receipt' AND a.reference = m.reference
                AND a.warehouse_id = m.to_warehouse_id) AS photos
           FROM movements m JOIN products p ON p.id = m.product_id JOIN clients cl ON cl.id = p.client_id
           JOIN warehouses w ON w.id = m.to_warehouse_id JOIN users u ON u.id = m.user_id
           WHERE ${where.join(' AND ')}
           GROUP BY m.reference, m.to_warehouse_id ORDER BY received_at DESC LIMIT 300`,
        )
        .all(...params),
    );
  });

  r.get('/detail', allow(ROLES), (req, res) => {
    const reference = v.str(req.query.reference, 'Reference', { required: true });
    const warehouseId = v.int(req.query.warehouse_id, 'Warehouse', { required: true });
    const scope = clientScope(req.user);
    const lines = db
      .prepare(
        `SELECT m.id, m.qty, m.batch_no, m.expiry_date, m.note, m.created_at, p.sku, p.name AS product_name, p.unit_cost,
           cl.name AS client_name, u.name AS received_by
         FROM movements m JOIN products p ON p.id = m.product_id JOIN clients cl ON cl.id = p.client_id JOIN users u ON u.id = m.user_id
         WHERE m.type = 'receipt' AND m.reference = ? AND m.to_warehouse_id = ? AND ${scope.sql} ORDER BY p.name`,
      )
      .all(reference, warehouseId, ...scope.params);
    if (!lines.length) throw new HttpError(404, 'Delivery not found');
    const warehouse = db.prepare('SELECT id, name FROM warehouses WHERE id = ?').get(warehouseId);
    const attachments = db
      .prepare(
        `SELECT a.id, a.caption, a.filename, a.mime, a.size, a.created_at, a.uploaded_by, a.lat, a.lng, a.accuracy, u.name AS uploaded_by_name
         FROM attachments a JOIN users u ON u.id = a.uploaded_by
         WHERE a.kind = 'receipt' AND a.reference = ? AND a.warehouse_id = ? ORDER BY a.id`,
      )
      .all(reference, warehouseId);
    res.json({ reference, warehouse, lines, attachments, can_upload: req.user.role !== 'account_manager' });
  });

  return r;
}

module.exports = { attachmentRoutes, deliveryRoutes, OPERATORS };
