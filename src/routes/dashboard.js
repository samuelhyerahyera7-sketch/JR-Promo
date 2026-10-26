'use strict';

const express = require('express');
const { isManagement } = require('../auth');
const { clientScope, campaignScope } = require('../access');

function dashboardRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const user = req.user;
    if (user.role === 'promoter') return res.json(promoterDashboard(db, user));
    const out = { role: user.role, kpis: {} };
    const cs = clientScope(user);
    const amOnly = user.role === 'account_manager';
    const amFilter = amOnly ? 'AND c.account_manager_id = ?' : '';
    const amParams = amOnly ? [user.id] : [];

    const totals = db
      .prepare(
        `SELECT COUNT(DISTINCT p.id) AS skus, COALESCE(SUM(s.qty), 0) AS units, COALESCE(SUM(s.qty * p.unit_cost), 0) AS value
         FROM products p JOIN clients cl ON cl.id = p.client_id LEFT JOIN stock s ON s.product_id = p.id
         WHERE p.active = 1 AND ${cs.sql}`,
      )
      .get(...cs.params);
    const field = db
      .prepare(
        `SELECT COALESCE(SUM(f.qty), 0) AS units, COALESCE(SUM(f.qty * p.unit_cost), 0) AS value
         FROM field_stock f JOIN products p ON p.id = f.product_id JOIN clients cl ON cl.id = p.client_id WHERE ${cs.sql}`,
      )
      .get(...cs.params);
    const low = lowStock(db, user);
    const count = (sql, ...params) => db.prepare(sql).get(...params).n;

    out.kpis.units_on_hand = totals.units;
    out.kpis.skus = totals.skus;
    out.kpis.units_in_field = field.units;
    out.kpis.low_stock = low.length;
    out.kpis.pending_approval = count(
      `SELECT COUNT(*) AS n FROM requests r JOIN campaigns c ON c.id = r.campaign_id WHERE r.status = 'pending' ${amFilter}`,
      ...amParams,
    );
    out.kpis.to_dispatch = count(
      `SELECT COUNT(*) AS n FROM requests r JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.status IN ('approved','picking') ${amFilter}`,
      ...amParams,
    );
    out.kpis.pending_returns = count(
      `SELECT COUNT(*) AS n FROM returns rt JOIN campaigns c ON c.id = rt.campaign_id WHERE rt.status = 'pending' ${amFilter}`,
      ...amParams,
    );
    const cps = campaignScope(user);
    out.kpis.active_campaigns = count(
      `SELECT COUNT(*) AS n FROM campaigns c WHERE c.status = 'active' AND ${cps.sql}`,
      ...cps.params,
    );
    if (user.role !== 'warehouse') {
      out.kpis.stock_value = Math.round(totals.value * 100) / 100;
      out.kpis.field_value = Math.round(field.value * 100) / 100;
    }

    out.low_stock = low.slice(0, 15);
    const valueCol =
      user.role !== 'warehouse'
        ? `, COALESCE((SELECT SUM(s.qty * p.unit_cost) FROM stock s JOIN products p ON p.id = s.product_id
             JOIN clients cl ON cl.id = p.client_id WHERE s.warehouse_id = w.id AND ${cs.sql}), 0) AS value`
        : '';
    out.by_warehouse = db
      .prepare(
        `SELECT w.id, w.name, w.city,
           COALESCE((SELECT SUM(s.qty) FROM stock s JOIN products p ON p.id = s.product_id
             JOIN clients cl ON cl.id = p.client_id WHERE s.warehouse_id = w.id AND ${cs.sql}), 0) AS units
           ${valueCol}
         FROM warehouses w WHERE w.active = 1 ORDER BY w.name`,
      )
      .all(...cs.params, ...(valueCol ? cs.params : []));

    // Daily flow for the last 30 days: what went out vs came in
    const since = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    out.flow = db
      .prepare(
        `SELECT substr(m.created_at, 1, 10) AS day,
           SUM(CASE WHEN m.type IN ('receipt','return') THEN m.qty ELSE 0 END) AS inbound,
           SUM(CASE WHEN m.type = 'dispatch' THEN m.qty ELSE 0 END) AS dispatched,
           SUM(CASE WHEN m.type = 'usage' THEN m.qty ELSE 0 END) AS used
         FROM movements m JOIN products p ON p.id = m.product_id JOIN clients cl ON cl.id = p.client_id
         WHERE m.created_at >= ? AND ${cs.sql}
         GROUP BY day ORDER BY day`,
      )
      .all(since, ...cs.params);
    out.flow_since = since;

    if (isManagement(user) || amOnly) {
      out.by_client = db
        .prepare(
          `SELECT cl.id, cl.name, COALESCE(SUM(s.qty), 0) AS units, COALESCE(SUM(s.qty * p.unit_cost), 0) AS value
           FROM clients cl LEFT JOIN products p ON p.client_id = cl.id LEFT JOIN stock s ON s.product_id = p.id
           WHERE cl.active = 1 AND ${cs.sql} GROUP BY cl.id ORDER BY value DESC`,
        )
        .all(...cs.params);
    }

    if (user.role === 'warehouse') {
      const whFilter = user.warehouse_id ? 'AND r.warehouse_id = ?' : '';
      const whParams = user.warehouse_id ? [user.warehouse_id] : [];
      out.queue = db
        .prepare(
          `SELECT r.id, r.ref, r.status, r.needed_by, r.delivery_method, w.name AS warehouse_name,
             u.name AS promoter_name, c.name AS campaign_name,
             (SELECT SUM(qty_approved) FROM request_items ri WHERE ri.request_id = r.id) AS units
           FROM requests r JOIN warehouses w ON w.id = r.warehouse_id JOIN users u ON u.id = r.promoter_id
           JOIN campaigns c ON c.id = r.campaign_id
           WHERE r.status IN ('approved','picking') ${whFilter}
           ORDER BY COALESCE(r.needed_by, '9999'), r.id LIMIT 20`,
        )
        .all(...whParams);
    } else {
      out.awaiting_approval = db
        .prepare(
          `SELECT r.id, r.ref, r.needed_by, u.name AS promoter_name, c.name AS campaign_name, r.created_at
           FROM requests r JOIN campaigns c ON c.id = r.campaign_id JOIN users u ON u.id = r.promoter_id
           WHERE r.status = 'pending' ${amFilter} ORDER BY r.id LIMIT 20`,
        )
        .all(...amParams);
    }

    out.recent = db
      .prepare(
        `SELECT m.id, m.type, m.qty, m.reference, m.created_at, p.sku, p.name AS product_name, u.name AS user_name
         FROM movements m JOIN products p ON p.id = m.product_id JOIN clients cl ON cl.id = p.client_id
         JOIN users u ON u.id = m.user_id WHERE ${cs.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT 12`,
      )
      .all(...cs.params);

    res.json(out);
  });

  return r;
}

function lowStock(db, user) {
  const cs = clientScope(user);
  return db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.reorder_level, cl.name AS client_name,
         COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand
       FROM products p JOIN clients cl ON cl.id = p.client_id
       WHERE p.active = 1 AND p.reorder_level > 0 AND ${cs.sql}
         AND COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) <= p.reorder_level
       ORDER BY (1.0 * on_hand / p.reorder_level), p.name`,
    )
    .all(...cs.params);
}

function promoterDashboard(db, user) {
  const holding = db
    .prepare(
      `SELECT f.product_id, p.sku, p.name AS product_name, p.unit, f.campaign_id, c.name AS campaign_name, f.qty
       FROM field_stock f JOIN products p ON p.id = f.product_id JOIN campaigns c ON c.id = f.campaign_id
       WHERE f.promoter_id = ? AND f.qty > 0 ORDER BY c.name, p.name`,
    )
    .all(user.id);
  const campaigns = db
    .prepare(
      `SELECT c.id, c.name, c.status, c.start_date, c.end_date, c.region, cl.name AS client_name
       FROM campaigns c JOIN clients cl ON cl.id = c.client_id JOIN campaign_promoters cp ON cp.campaign_id = c.id
       WHERE cp.promoter_id = ? AND c.status IN ('planned','active') ORDER BY c.start_date`,
    )
    .all(user.id);
  const requests = db
    .prepare(
      `SELECT r.id, r.ref, r.status, r.needed_by, r.waybill, r.courier, c.name AS campaign_name
       FROM requests r JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.promoter_id = ? AND r.status IN ('pending','approved','picking','dispatched')
       ORDER BY r.id DESC`,
    )
    .all(user.id);
  return {
    role: 'promoter',
    kpis: {
      units_held: holding.reduce((n, h) => n + h.qty, 0),
      active_campaigns: campaigns.filter((c) => c.status === 'active').length,
      open_requests: requests.filter((r) => r.status !== 'dispatched').length,
      to_confirm: requests.filter((r) => r.status === 'dispatched').length,
    },
    holding,
    campaigns,
    requests,
  };
}

module.exports = { dashboardRoutes, lowStock };
