'use strict';

const express = require('express');
const { MANAGEMENT, HttpError, allow, isManagement } = require('../auth');
const v = require('../validate');
const stock = require('../stock');
const { tx } = require('../db');
const { assertCampaign, canManageCampaign } = require('../access');

const OPERATORS = [MANAGEMENT, 'warehouse'];

function nextRef(db, table, prefix) {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`).get();
  return `${prefix}-${String(row.n).padStart(5, '0')}`;
}

function assertAssigned(db, campaignId, promoterId) {
  const ok = db
    .prepare(
      `SELECT 1 FROM campaign_promoters cp JOIN users u ON u.id = cp.promoter_id
       WHERE cp.campaign_id = ? AND cp.promoter_id = ? AND u.active = 1`,
    )
    .get(campaignId, promoterId);
  if (!ok) throw new HttpError(400, 'That promoter is not assigned to this campaign');
}

/** Resolve which promoter an action is for: promoters act for themselves, others must say. */
function resolvePromoter(user, bodyPromoterId) {
  if (user.role === 'promoter') return user.id;
  return v.int(bodyPromoterId, 'Promoter', { required: true });
}

function assertProductsForClient(db, campaign, productIds) {
  const check = db.prepare('SELECT client_id, active, sku FROM products WHERE id = ?');
  for (const id of productIds) {
    const p = check.get(id);
    if (!p) throw new HttpError(400, `Product #${id} not found`);
    if (p.client_id !== campaign.client_id) throw new HttpError(400, `${p.sku} does not belong to this campaign's client`);
    if (!p.active) throw new HttpError(400, `${p.sku} is no longer active`);
  }
}

/** Units in a warehouse not already promised to other approved requests. */
function availableIn(db, productId, warehouseId, excludeRequestId = 0) {
  const allocated = db
    .prepare(
      `SELECT COALESCE(SUM(ri.qty_approved), 0) AS n FROM request_items ri JOIN requests r ON r.id = ri.request_id
       WHERE ri.product_id = ? AND r.warehouse_id = ? AND r.status IN ('approved','picking') AND r.id != ?`,
    )
    .get(productId, warehouseId, excludeRequestId).n;
  return stock.warehouseQty(db, productId, warehouseId) - allocated;
}

const REQUEST_SELECT = `
  SELECT r.*, c.name AS campaign_name, c.client_id, cl.name AS client_name, c.account_manager_id,
         w.name AS warehouse_name, pr.name AS promoter_name, pr.phone AS promoter_phone,
         rb.name AS requested_by_name, ab.name AS approved_by_name, db_.name AS dispatched_by_name
  FROM requests r
  JOIN campaigns c ON c.id = r.campaign_id
  JOIN clients cl ON cl.id = c.client_id
  JOIN warehouses w ON w.id = r.warehouse_id
  JOIN users pr ON pr.id = r.promoter_id
  JOIN users rb ON rb.id = r.requested_by
  LEFT JOIN users ab ON ab.id = r.approved_by
  LEFT JOIN users db_ ON db_.id = r.dispatched_by`;

function requestScope(user) {
  if (isManagement(user) || user.role === 'warehouse') return { sql: '1=1', params: [] };
  if (user.role === 'account_manager') return { sql: 'c.account_manager_id = ?', params: [user.id] };
  return { sql: 'r.promoter_id = ?', params: [user.id] };
}

function loadRequest(db, user, id) {
  const scope = requestScope(user);
  const request = db.prepare(`${REQUEST_SELECT} WHERE r.id = ? AND ${scope.sql}`).get(id, ...scope.params);
  v.found(request, 'Request');
  request.items = db
    .prepare(
      `SELECT ri.*, p.sku, p.name AS product_name, p.unit,
         COALESCE((SELECT qty FROM stock s WHERE s.product_id = ri.product_id AND s.warehouse_id = ?), 0) AS warehouse_qty,
         (SELECT bin FROM stock s WHERE s.product_id = ri.product_id AND s.warehouse_id = ?) AS bin
       FROM request_items ri JOIN products p ON p.id = ri.product_id WHERE ri.request_id = ? ORDER BY p.name`,
    )
    .all(request.warehouse_id, request.warehouse_id, id);
  return request;
}

function requireStatus(entity, allowed, action) {
  if (!allowed.includes(entity.status)) {
    throw new HttpError(409, `Cannot ${action}: ${entity.ref} is ${entity.status}`);
  }
}

function requestRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const scope = requestScope(req.user);
    const where = [scope.sql];
    const params = [...scope.params];
    if (req.query.status) {
      const statuses = String(req.query.status).split(',');
      where.push(`r.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (req.query.warehouse_id) {
      where.push('r.warehouse_id = ?');
      params.push(Number(req.query.warehouse_id));
    }
    if (req.query.campaign_id) {
      where.push('r.campaign_id = ?');
      params.push(Number(req.query.campaign_id));
    }
    const list = db
      .prepare(
        `SELECT q.*,
           (SELECT COALESCE(SUM(COALESCE(ri.qty_approved, ri.qty_requested)), 0) FROM request_items ri WHERE ri.request_id = q.id) AS units,
           (SELECT COUNT(*) FROM request_items ri WHERE ri.request_id = q.id) AS lines
         FROM (${REQUEST_SELECT} WHERE ${where.join(' AND ')}) q
         ORDER BY CASE q.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'picking' THEN 2 WHEN 'dispatched' THEN 3 ELSE 4 END,
                  q.id DESC
         LIMIT 500`,
      )
      .all(...params);
    res.json(list);
  });

  r.get('/:id', (req, res) => {
    res.json(loadRequest(db, req.user, v.int(req.params.id, 'id', { required: true })));
  });

  r.post('/', allow(MANAGEMENT, 'account_manager', 'promoter'), (req, res) => {
    const b = req.body;
    const campaign = assertCampaign(db, req.user, v.int(b.campaign_id, 'Campaign', { required: true }));
    if (!['planned', 'active'].includes(campaign.status)) throw new HttpError(409, `Campaign is ${campaign.status}`);
    const promoterId = resolvePromoter(req.user, b.promoter_id);
    assertAssigned(db, campaign.id, promoterId);
    const warehouseId = v.int(b.warehouse_id, 'Warehouse', { required: true });
    v.found(db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(warehouseId), 'Warehouse');
    const lines = v.items(b.items).map((l) => ({
      productId: v.int(l.product_id, 'Product', { required: true }),
      qty: v.int(l.qty, 'Quantity', { required: true, min: 1, max: 1e6 }),
    }));
    assertProductsForClient(db, campaign, lines.map((l) => l.productId));
    if (new Set(lines.map((l) => l.productId)).size !== lines.length) throw new HttpError(400, 'Each product may appear once');

    // Requests raised by the campaign's own account manager (or management) are approved immediately.
    const autoApprove = canManageCampaign(req.user, campaign);
    const id = tx(db, () => {
      if (autoApprove) {
        for (const l of lines) {
          const avail = availableIn(db, l.productId, warehouseId);
          if (l.qty > avail) {
            const sku = db.prepare('SELECT sku FROM products WHERE id = ?').get(l.productId).sku;
            throw new HttpError(409, `Only ${Math.max(avail, 0)} of ${sku} available in that warehouse`);
          }
        }
      }
      const info = db
        .prepare(
          `INSERT INTO requests (ref, campaign_id, warehouse_id, promoter_id, requested_by, status, needed_by,
             delivery_method, delivery_address, notes, approved_by, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nextRef(db, 'requests', 'REQ'),
          campaign.id,
          warehouseId,
          promoterId,
          req.user.id,
          autoApprove ? 'approved' : 'pending',
          v.date(b.needed_by, 'Needed by'),
          v.oneOf(b.delivery_method, 'Delivery method', ['collect', 'courier', 'company_vehicle']) || 'collect',
          v.str(b.delivery_address, 'Delivery address'),
          v.str(b.notes, 'Notes', { max: 2000 }),
          autoApprove ? req.user.id : null,
          autoApprove ? new Date().toISOString() : null,
        );
      const ins = db.prepare(
        'INSERT INTO request_items (request_id, product_id, qty_requested, qty_approved) VALUES (?, ?, ?, ?)',
      );
      for (const l of lines) ins.run(info.lastInsertRowid, l.productId, l.qty, autoApprove ? l.qty : null);
      return info.lastInsertRowid;
    });
    res.status(201).json(loadRequest(db, req.user, id));
  });

  r.post('/:id/approve', allow(MANAGEMENT, 'account_manager'), (req, res) => {
    const request = loadRequest(db, req.user, v.int(req.params.id, 'id', { required: true }));
    assertCampaign(db, req.user, request.campaign_id, { manage: true });
    requireStatus(request, ['pending'], 'approve');
    const overrides = new Map((req.body.items || []).map((i) => [Number(i.id), i.qty_approved]));
    tx(db, () => {
      let total = 0;
      for (const item of request.items) {
        const qty = overrides.has(item.id)
          ? v.int(overrides.get(item.id), `Approved qty for ${item.sku}`, { required: true, min: 0, max: item.qty_requested })
          : item.qty_requested;
        if (qty > 0) {
          const avail = availableIn(db, item.product_id, request.warehouse_id, request.id);
          if (qty > avail) {
            throw new HttpError(409, `Only ${Math.max(avail, 0)} of ${item.sku} available in ${request.warehouse_name}`);
          }
        }
        total += qty;
        db.prepare('UPDATE request_items SET qty_approved = ? WHERE id = ?').run(qty, item.id);
      }
      if (total === 0) throw new HttpError(400, 'Approve at least one unit, or reject the request instead');
      db.prepare(
        "UPDATE requests SET status = 'approved', approved_by = ?, approved_at = ?, decision_note = ? WHERE id = ?",
      ).run(req.user.id, new Date().toISOString(), v.str(req.body.note, 'Note'), request.id);
    });
    res.json(loadRequest(db, req.user, request.id));
  });

  r.post('/:id/reject', allow(MANAGEMENT, 'account_manager'), (req, res) => {
    const request = loadRequest(db, req.user, v.int(req.params.id, 'id', { required: true }));
    assertCampaign(db, req.user, request.campaign_id, { manage: true });
    requireStatus(request, ['pending'], 'reject');
    db.prepare(
      "UPDATE requests SET status = 'rejected', approved_by = ?, approved_at = ?, decision_note = ? WHERE id = ?",
    ).run(req.user.id, new Date().toISOString(), v.str(req.body.note, 'Reason', { required: true }), request.id);
    res.json(loadRequest(db, req.user, request.id));
  });

  r.post('/:id/pick', allow(OPERATORS), (req, res) => {
    const request = loadRequest(db, req.user, v.int(req.params.id, 'id', { required: true }));
    requireStatus(request, ['approved'], 'start picking');
    db.prepare("UPDATE requests SET status = 'picking' WHERE id = ?").run(request.id);
    res.json(loadRequest(db, req.user, request.id));
  });

  r.post('/:id/dispatch', allow(OPERATORS), (req, res) => {
    const request = loadRequest(db, req.user, v.int(req.params.id, 'id', { required: true }));
    requireStatus(request, ['approved', 'picking'], 'dispatch');
    const overrides = new Map((req.body.items || []).map((i) => [Number(i.id), i.qty_dispatched]));
    const courier = v.str(req.body.courier, 'Courier');
    const waybill = v.str(req.body.waybill, 'Waybill / tracking number', { max: 80 });
    if (request.delivery_method === 'courier' && !waybill) throw new HttpError(400, 'Waybill number is required for courier deliveries');
    tx(db, () => {
      let total = 0;
      for (const item of request.items) {
        const qty = overrides.has(item.id)
          ? v.int(overrides.get(item.id), `Dispatched qty for ${item.sku}`, { required: true, min: 0, max: item.qty_approved })
          : item.qty_approved;
        if (qty > 0) {
          stock.dispatch(db, {
            productId: item.product_id,
            warehouseId: request.warehouse_id,
            promoterId: request.promoter_id,
            campaignId: request.campaign_id,
            qty,
            reference: request.ref,
            userId: req.user.id,
          });
        }
        total += qty;
        db.prepare('UPDATE request_items SET qty_dispatched = ? WHERE id = ?').run(qty, item.id);
      }
      if (total === 0) throw new HttpError(400, 'Nothing to dispatch');
      db.prepare(
        "UPDATE requests SET status = 'dispatched', dispatched_by = ?, dispatched_at = ?, courier = ?, waybill = ? WHERE id = ?",
      ).run(req.user.id, new Date().toISOString(), courier, waybill, request.id);
    });
    res.json(loadRequest(db, req.user, request.id));
  });

  r.post('/:id/deliver', (req, res) => {
    const request = loadRequest(db, req.user, v.int(req.params.id, 'id', { required: true }));
    const isOwner = req.user.role === 'promoter' && request.promoter_id === req.user.id;
    if (!isOwner && !isManagement(req.user) && req.user.role !== 'warehouse') {
      throw new HttpError(403, 'Only the receiving promoter or the warehouse can confirm delivery');
    }
    requireStatus(request, ['dispatched'], 'confirm delivery');
    db.prepare("UPDATE requests SET status = 'delivered', delivered_at = ? WHERE id = ?").run(new Date().toISOString(), request.id);
    res.json(loadRequest(db, req.user, request.id));
  });

  r.post('/:id/cancel', (req, res) => {
    const request = loadRequest(db, req.user, v.int(req.params.id, 'id', { required: true }));
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(request.campaign_id);
    if (request.requested_by !== req.user.id && !canManageCampaign(req.user, campaign)) {
      throw new HttpError(403, 'Only the requester or the account manager can cancel this');
    }
    requireStatus(request, ['pending', 'approved', 'picking'], 'cancel');
    db.prepare("UPDATE requests SET status = 'cancelled', decision_note = COALESCE(?, decision_note) WHERE id = ?").run(
      v.str(req.body.note, 'Note'),
      request.id,
    );
    res.json(loadRequest(db, req.user, request.id));
  });

  return r;
}

// ---------------------------------------------------------------- returns

const RETURN_SELECT = `
  SELECT rt.*, c.name AS campaign_name, cl.name AS client_name, w.name AS warehouse_name,
         pr.name AS promoter_name, rb.name AS received_by_name
  FROM returns rt
  JOIN campaigns c ON c.id = rt.campaign_id
  JOIN clients cl ON cl.id = c.client_id
  JOIN warehouses w ON w.id = rt.warehouse_id
  JOIN users pr ON pr.id = rt.promoter_id
  LEFT JOIN users rb ON rb.id = rt.received_by`;

function returnScope(user) {
  if (isManagement(user) || user.role === 'warehouse') return { sql: '1=1', params: [] };
  if (user.role === 'account_manager') return { sql: 'c.account_manager_id = ?', params: [user.id] };
  return { sql: 'rt.promoter_id = ?', params: [user.id] };
}

function loadReturn(db, user, id) {
  const scope = returnScope(user);
  const ret = v.found(db.prepare(`${RETURN_SELECT} WHERE rt.id = ? AND ${scope.sql}`).get(id, ...scope.params), 'Return');
  ret.items = db
    .prepare(
      `SELECT ri.*, p.sku, p.name AS product_name FROM return_items ri JOIN products p ON p.id = ri.product_id
       WHERE ri.return_id = ? ORDER BY p.name`,
    )
    .all(id);
  return ret;
}

function returnRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const scope = returnScope(req.user);
    const where = [scope.sql];
    const params = [...scope.params];
    if (req.query.status) {
      where.push('rt.status = ?');
      params.push(req.query.status);
    }
    res.json(
      db
        .prepare(
          `SELECT q.*, (SELECT COALESCE(SUM(qty), 0) FROM return_items ri WHERE ri.return_id = q.id) AS units
           FROM (${RETURN_SELECT} WHERE ${where.join(' AND ')}) q
           ORDER BY CASE q.status WHEN 'pending' THEN 0 ELSE 1 END, q.id DESC LIMIT 500`,
        )
        .all(...params),
    );
  });

  r.get('/:id', (req, res) => res.json(loadReturn(db, req.user, v.int(req.params.id, 'id', { required: true }))));

  r.post('/', allow(MANAGEMENT, 'account_manager', 'promoter'), (req, res) => {
    const b = req.body;
    const campaign = assertCampaign(db, req.user, v.int(b.campaign_id, 'Campaign', { required: true }));
    const promoterId = resolvePromoter(req.user, b.promoter_id);
    const warehouseId = v.int(b.warehouse_id, 'Warehouse', { required: true });
    v.found(db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1').get(warehouseId), 'Warehouse');
    const lines = v.items(b.items).map((l) => ({
      productId: v.int(l.product_id, 'Product', { required: true }),
      qty: v.int(l.qty, 'Quantity', { required: true, min: 1 }),
    }));
    for (const l of lines) {
      const held = stock.fieldQty(db, l.productId, promoterId, campaign.id);
      if (l.qty > held) throw new HttpError(409, `Promoter only holds ${held} of product #${l.productId} for this campaign`);
    }
    const id = tx(db, () => {
      const info = db
        .prepare('INSERT INTO returns (ref, campaign_id, promoter_id, warehouse_id, notes) VALUES (?, ?, ?, ?, ?)')
        .run(nextRef(db, 'returns', 'RET'), campaign.id, promoterId, warehouseId, v.str(b.notes, 'Notes', { max: 2000 }));
      const ins = db.prepare('INSERT INTO return_items (return_id, product_id, qty) VALUES (?, ?, ?)');
      for (const l of lines) ins.run(info.lastInsertRowid, l.productId, l.qty);
      return info.lastInsertRowid;
    });
    res.status(201).json(loadReturn(db, req.user, id));
  });

  // Warehouse checks the goods in, splitting good vs damaged units
  r.post('/:id/receive', allow(OPERATORS), (req, res) => {
    const ret = loadReturn(db, req.user, v.int(req.params.id, 'id', { required: true }));
    requireStatus(ret, ['pending'], 'receive');
    const counts = new Map((req.body.items || []).map((i) => [Number(i.id), i]));
    tx(db, () => {
      for (const item of ret.items) {
        const c = counts.get(item.id) || {};
        const good = v.int(c.qty_good ?? item.qty, `Good qty for ${item.sku}`, { min: 0 });
        const damaged = v.int(c.qty_damaged ?? 0, `Damaged qty for ${item.sku}`, { min: 0 });
        if (good + damaged > item.qty) throw new HttpError(400, `${item.sku}: counted more than the ${item.qty} declared`);
        stock.returnToWarehouse(db, {
          productId: item.product_id,
          warehouseId: ret.warehouse_id,
          promoterId: ret.promoter_id,
          campaignId: ret.campaign_id,
          qtyGood: good,
          qtyDamaged: damaged,
          reference: ret.ref,
          userId: req.user.id,
        });
        db.prepare('UPDATE return_items SET qty_good = ?, qty_damaged = ? WHERE id = ?').run(good, damaged, item.id);
      }
      db.prepare("UPDATE returns SET status = 'received', received_by = ?, received_at = ? WHERE id = ?").run(
        req.user.id,
        new Date().toISOString(),
        ret.id,
      );
    });
    res.json(loadReturn(db, req.user, ret.id));
  });

  r.post('/:id/cancel', (req, res) => {
    const ret = loadReturn(db, req.user, v.int(req.params.id, 'id', { required: true }));
    requireStatus(ret, ['pending'], 'cancel');
    if (req.user.role === 'warehouse') throw new HttpError(403, 'Warehouse staff cannot cancel returns');
    db.prepare("UPDATE returns SET status = 'cancelled' WHERE id = ?").run(ret.id);
    res.json(loadReturn(db, req.user, ret.id));
  });

  return r;
}

// ---------------------------------------------------------------- usage reports

function usageRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const where = ['1=1'];
    const params = [];
    if (req.user.role === 'promoter') {
      where.push('ur.promoter_id = ?');
      params.push(req.user.id);
    } else if (req.user.role === 'account_manager') {
      where.push('c.account_manager_id = ?');
      params.push(req.user.id);
    }
    if (req.query.campaign_id) {
      where.push('ur.campaign_id = ?');
      params.push(Number(req.query.campaign_id));
    }
    const reports = db
      .prepare(
        `SELECT ur.*, c.name AS campaign_name, cl.name AS client_name, u.name AS promoter_name,
           (SELECT COALESCE(SUM(qty_used), 0) FROM usage_items ui WHERE ui.report_id = ur.id) AS units_used,
           (SELECT COALESCE(SUM(qty_damaged), 0) FROM usage_items ui WHERE ui.report_id = ur.id) AS units_damaged
         FROM usage_reports ur JOIN campaigns c ON c.id = ur.campaign_id JOIN clients cl ON cl.id = c.client_id
         JOIN users u ON u.id = ur.promoter_id
         WHERE ${where.join(' AND ')} ORDER BY ur.report_date DESC, ur.id DESC LIMIT 500`,
      )
      .all(...params);
    const itemStmt = db.prepare(
      `SELECT ui.*, p.sku, p.name AS product_name FROM usage_items ui JOIN products p ON p.id = ui.product_id
       WHERE ui.report_id = ?`,
    );
    for (const rep of reports) rep.items = itemStmt.all(rep.id);
    res.json(reports);
  });

  r.post('/', allow(MANAGEMENT, 'account_manager', 'promoter'), (req, res) => {
    const b = req.body;
    const campaign = assertCampaign(db, req.user, v.int(b.campaign_id, 'Campaign', { required: true }));
    const promoterId = resolvePromoter(req.user, b.promoter_id);
    const lines = v.items(b.items).map((l) => ({
      productId: v.int(l.product_id, 'Product', { required: true }),
      used: v.int(l.qty_used ?? 0, 'Qty used', { min: 0 }),
      damaged: v.int(l.qty_damaged ?? 0, 'Qty damaged', { min: 0 }),
    }));
    if (lines.every((l) => l.used + l.damaged === 0)) throw new HttpError(400, 'Enter at least one unit used or damaged');
    const reportDate = v.date(b.report_date, 'Date') || new Date().toISOString().slice(0, 10);
    const id = tx(db, () => {
      const info = db
        .prepare('INSERT INTO usage_reports (campaign_id, promoter_id, report_date, store, notes) VALUES (?, ?, ?, ?, ?)')
        .run(campaign.id, promoterId, reportDate, v.str(b.store, 'Store'), v.str(b.notes, 'Notes', { max: 2000 }));
      const ref = `USE-${String(info.lastInsertRowid).padStart(5, '0')}`;
      const ins = db.prepare('INSERT INTO usage_items (report_id, product_id, qty_used, qty_damaged) VALUES (?, ?, ?, ?)');
      for (const l of lines) {
        if (l.used + l.damaged === 0) continue;
        stock.consume(db, {
          productId: l.productId,
          promoterId,
          campaignId: campaign.id,
          qtyUsed: l.used,
          qtyDamaged: l.damaged,
          reference: ref,
          userId: req.user.id,
        });
        ins.run(info.lastInsertRowid, l.productId, l.used, l.damaged);
      }
      return info.lastInsertRowid;
    });
    res.status(201).json({ id });
  });

  return r;
}

module.exports = { requestRoutes, returnRoutes, usageRoutes, availableIn };
