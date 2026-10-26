'use strict';

const express = require('express');
const { isManagement } = require('../auth');
const { clientScope } = require('../access');
const { saToday } = require('../stock');
const { lowStock } = require('./dashboard');

/**
 * Reminders are worked out live from the data, so they clear themselves as
 * soon as the underlying problem is fixed. Two groups:
 *   "to go out"  - stock that should be leaving the warehouse
 *   "missing"    - stock or paperwork that should have come back or been confirmed
 * plus stock health (expiry, low stock, laundry).
 */
function buildReminders(db, user) {
  const out = [];
  const add = (r) => out.push(r);
  const role = user.role;
  const mgmt = isManagement(user);
  const ops = mgmt || role === 'warehouse';
  const am = role === 'account_manager';
  const promoter = role === 'promoter';
  const today = saToday();
  const tomorrow = saToday(1);

  // Campaign filter for AMs (own campaigns) and promoters (assigned campaigns)
  const camp = (alias) =>
    am
      ? { sql: `${alias}.account_manager_id = ?`, params: [user.id] }
      : promoter
        ? { sql: `EXISTS (SELECT 1 FROM campaign_promoters cp WHERE cp.campaign_id = ${alias}.id AND cp.promoter_id = ?)`, params: [user.id] }
        : { sql: '1=1', params: [] };
  const promoterOnly = (col) => (promoter ? { sql: `${col} = ?`, params: [user.id] } : { sql: '1=1', params: [] });

  // ---- to go out ----------------------------------------------------------
  if (!promoter) {
    const c = camp('c');
    const wh = role === 'warehouse' && user.warehouse_id ? ' AND r.warehouse_id = ?' : '';
    const whp = role === 'warehouse' && user.warehouse_id ? [user.warehouse_id] : [];
    for (const r of db
      .prepare(
        `SELECT r.id, r.ref, r.needed_by, u.name AS promoter_name, w.name AS warehouse_name
         FROM requests r JOIN campaigns c ON c.id = r.campaign_id JOIN users u ON u.id = r.promoter_id
         JOIN warehouses w ON w.id = r.warehouse_id
         WHERE r.status IN ('approved','picking') AND r.needed_by IS NOT NULL AND r.needed_by <= ? AND ${c.sql}${wh}
         ORDER BY r.needed_by`,
      )
      .all(tomorrow, ...c.params, ...whp)) {
      const late = r.needed_by < today;
      add({
        group: 'out',
        severity: late ? 'high' : 'medium',
        type: 'dispatch_due',
        title: `${r.ref} ${late ? 'is overdue' : r.needed_by === today ? 'is needed today' : 'is needed tomorrow'}`,
        detail: `${r.promoter_name} needs this from ${r.warehouse_name} by ${r.needed_by}.`,
        link: `requests/${r.id}`,
      });
    }
  }

  if (mgmt || am) {
    const c = camp('c');
    for (const r of db
      .prepare(
        `SELECT r.id, r.ref, r.created_at, r.needed_by, u.name AS promoter_name FROM requests r
         JOIN campaigns c ON c.id = r.campaign_id JOIN users u ON u.id = r.promoter_id
         WHERE r.status = 'pending' AND (r.created_at <= datetime('now', '-1 day') OR (r.needed_by IS NOT NULL AND r.needed_by <= ?))
           AND ${c.sql} ORDER BY r.id`,
      )
      .all(tomorrow, ...c.params)) {
      add({
        group: 'out',
        severity: r.needed_by && r.needed_by <= tomorrow ? 'high' : 'medium',
        type: 'approval_waiting',
        title: `${r.ref} is waiting for approval`,
        detail: `Requested by ${r.promoter_name}${r.needed_by ? `, needed by ${r.needed_by}` : ''}.`,
        link: `requests/${r.id}`,
      });
    }
  }

  // Campaigns starting within 7 days (or running) whose planned stock hasn't been approved or sent
  if (!promoter) {
    const c = camp('c');
    for (const row of db
      .prepare(
        `SELECT c.id, c.name, c.start_date, c.status,
           SUM(MAX(cp.planned_qty
             - COALESCE((SELECT SUM(m.qty) FROM movements m WHERE m.type = 'dispatch' AND m.campaign_id = c.id AND m.product_id = cp.product_id), 0)
             - COALESCE((SELECT SUM(ri.qty_approved) FROM request_items ri JOIN requests r ON r.id = ri.request_id
                 WHERE r.campaign_id = c.id AND ri.product_id = cp.product_id AND r.status IN ('approved','picking')), 0), 0)) AS outstanding,
           COUNT(*) AS lines
         FROM campaigns c JOIN campaign_plan cp ON cp.campaign_id = c.id
         WHERE c.status IN ('planned','active') AND (c.start_date IS NULL OR c.start_date <= ?) AND ${c.sql}
         GROUP BY c.id HAVING outstanding > 0`,
      )
      .all(saToday(7), ...c.params)) {
      const started = row.start_date && row.start_date <= today;
      add({
        group: 'out',
        severity: started ? 'high' : 'medium',
        type: 'plan_outstanding',
        title: `${row.name}: ${row.outstanding} planned units not sent yet`,
        detail: started ? 'The campaign has started.' : `Starts ${row.start_date}.`,
        link: `campaigns/${row.id}`,
      });
    }
  }

  // ---- missing / not confirmed -------------------------------------------
  {
    const c = camp('c');
    const p = promoterOnly('r.promoter_id');
    for (const r of db
      .prepare(
        `SELECT r.id, r.ref, r.dispatched_at, r.waybill, u.name AS promoter_name FROM requests r
         JOIN campaigns c ON c.id = r.campaign_id JOIN users u ON u.id = r.promoter_id
         WHERE r.status = 'dispatched' AND r.dispatched_at <= ? AND ${c.sql} AND ${p.sql}`,
      )
      .all(new Date(Date.now() - 3 * 864e5).toISOString(), ...c.params, ...p.params)) {
      add({
        group: 'missing',
        severity: 'high',
        type: 'delivery_unconfirmed',
        title: promoter ? `Please confirm you received ${r.ref}` : `${r.ref} not confirmed as delivered`,
        detail: `Dispatched ${r.dispatched_at.slice(0, 10)}${r.waybill ? `, waybill ${r.waybill}` : ''}. ${promoter ? '' : `Check with ${r.promoter_name}.`}`.trim(),
        link: `requests/${r.id}`,
      });
    }
  }

  // Stock still with promoters on campaigns that have ended
  {
    const c = camp('c');
    const p = promoterOnly('f.promoter_id');
    for (const row of db
      .prepare(
        `SELECT f.promoter_id, u.name AS promoter_name, c.id AS campaign_id, c.name AS campaign_name, c.end_date,
           SUM(f.qty) AS units, SUM(CASE WHEN pr.category = 'Uniform' THEN f.qty ELSE 0 END) AS uniforms,
           SUM(CASE WHEN pr.category IN ('Promoter Table','Setup & Display','Equipment') THEN f.qty ELSE 0 END) AS equipment
         FROM field_stock f JOIN campaigns c ON c.id = f.campaign_id JOIN users u ON u.id = f.promoter_id
         JOIN products pr ON pr.id = f.product_id
         WHERE f.qty > 0 AND (c.status IN ('completed','cancelled') OR (c.end_date IS NOT NULL AND c.end_date < ?))
           AND ${c.sql} AND ${p.sql}
         GROUP BY f.promoter_id, c.id ORDER BY c.end_date`,
      )
      .all(today, ...c.params, ...p.params)) {
      const parts = [];
      if (row.uniforms) parts.push(`${row.uniforms} uniform item(s)`);
      if (row.equipment) parts.push(`${row.equipment} table/setup item(s)`);
      add({
        group: 'missing',
        severity: row.uniforms || row.equipment ? 'high' : 'medium',
        type: 'not_returned',
        title: promoter
          ? `Return your ${row.campaign_name} stock`
          : `${row.promoter_name} still has ${row.units} units from ${row.campaign_name}`,
        detail: `${row.campaign_name} ended${row.end_date ? ` ${row.end_date}` : ''}.${parts.length ? ` Includes ${parts.join(' and ')}.` : ''}`,
        link: promoter ? 'my-stock' : 'field',
      });
    }
  }

  // Returns checked in with fewer units than the promoter declared
  {
    const c = camp('c');
    const p = promoterOnly('rt.promoter_id');
    for (const row of db
      .prepare(
        `SELECT rt.id, rt.ref, u.name AS promoter_name,
           SUM(ri.qty - COALESCE(ri.qty_good, 0) - COALESCE(ri.qty_damaged, 0) - COALESCE(ri.qty_laundry, 0)) AS short
         FROM returns rt JOIN return_items ri ON ri.return_id = rt.id JOIN campaigns c ON c.id = rt.campaign_id
         JOIN users u ON u.id = rt.promoter_id
         WHERE rt.status = 'received' AND rt.received_at >= ? AND ${c.sql} AND ${p.sql}
         GROUP BY rt.id HAVING short > 0`,
      )
      .all(new Date(Date.now() - 30 * 864e5).toISOString(), ...c.params, ...p.params)) {
      add({
        group: 'missing',
        severity: 'high',
        type: 'return_short',
        title: `${row.short} unit(s) missing from ${row.ref}`,
        detail: `${row.promoter_name} declared more than the warehouse counted. The difference is still against the promoter.`,
        link: 'returns',
      });
    }
  }

  // Pending returns not yet checked in after 3 days
  if (ops || am) {
    const c = camp('c');
    for (const row of db
      .prepare(
        `SELECT rt.id, rt.ref, rt.created_at, u.name AS promoter_name, w.name AS warehouse_name FROM returns rt
         JOIN campaigns c ON c.id = rt.campaign_id JOIN users u ON u.id = rt.promoter_id JOIN warehouses w ON w.id = rt.warehouse_id
         WHERE rt.status = 'pending' AND rt.created_at <= datetime('now', '-3 days') AND ${c.sql}`,
      )
      .all(...c.params)) {
      add({
        group: 'missing',
        severity: 'medium',
        type: 'return_not_received',
        title: `${row.ref} hasn't arrived at ${row.warehouse_name}`,
        detail: `Logged by ${row.promoter_name} on ${row.created_at.slice(0, 10)}.`,
        link: 'returns',
      });
    }
  }

  // Stock-take shortfalls in the last 30 days
  if (ops) {
    for (const row of db
      .prepare(
        `SELECT p.sku, p.name, w.name AS warehouse_name, -SUM(m.qty) AS missing, MAX(m.created_at) AS at
         FROM movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.to_warehouse_id
         WHERE m.type = 'adjustment' AND m.qty < 0 AND m.created_at >= datetime('now', '-30 days')
         GROUP BY m.product_id, m.to_warehouse_id ORDER BY missing DESC LIMIT 10`,
      )
      .all()) {
      add({
        group: 'missing',
        severity: 'medium',
        type: 'count_shortfall',
        title: `${row.missing} × ${row.sku} missing at ${row.warehouse_name} stock take`,
        detail: `${row.name}, counted ${row.at.slice(0, 10)}.`,
        link: 'movements',
      });
    }
  }

  // Delivery photos: inbound deliveries in the last 14 days without a waybill photo
  if (ops) {
    const rows = db
      .prepare(
        `SELECT m.reference, w.name AS warehouse_name, MIN(m.created_at) AS at FROM movements m JOIN warehouses w ON w.id = m.to_warehouse_id
         WHERE m.type = 'receipt' AND m.created_at >= datetime('now', '-14 days')
           AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.kind = 'receipt' AND a.reference = m.reference AND a.warehouse_id = m.to_warehouse_id)
         GROUP BY m.reference, m.to_warehouse_id ORDER BY at DESC`,
      )
      .all();
    if (rows.length) {
      add({
        group: 'missing',
        severity: 'low',
        type: 'waybill_photo',
        title: `${rows.length} recent deliver${rows.length === 1 ? 'y has' : 'ies have'} no waybill photo`,
        detail: rows.slice(0, 4).map((r) => `${r.reference} (${r.warehouse_name})`).join(', '),
        link: 'deliveries',
      });
    }
  }

  // Promoters holding stock on an active campaign with no activation report in 3 days
  if (am || mgmt || promoter) {
    const c = camp('c');
    const p = promoterOnly('f.promoter_id');
    for (const row of db
      .prepare(
        `SELECT f.promoter_id, u.name AS promoter_name, c.id AS campaign_id, c.name AS campaign_name, SUM(f.qty) AS units,
           (SELECT MAX(report_date) FROM usage_reports ur WHERE ur.promoter_id = f.promoter_id AND ur.campaign_id = c.id) AS last_report
         FROM field_stock f JOIN campaigns c ON c.id = f.campaign_id JOIN users u ON u.id = f.promoter_id
         JOIN products pr ON pr.id = f.product_id
         WHERE f.qty > 0 AND c.status = 'active' AND pr.category IN ('Sample','Giveaway','Merchandise') AND ${c.sql} AND ${p.sql}
         GROUP BY f.promoter_id, c.id
         HAVING last_report IS NULL OR last_report < ?`,
      )
      .all(...c.params, ...p.params, saToday(-3))) {
      add({
        group: 'missing',
        severity: 'low',
        type: 'no_activity',
        title: promoter ? `Log your ${row.campaign_name} activations` : `No activation report from ${row.promoter_name}`,
        detail: `${row.units} units held on ${row.campaign_name}; last report ${row.last_report || 'never'}.`,
        link: promoter ? 'usage' : `campaigns/${row.campaign_id}`,
      });
    }
  }

  // ---- stock health -------------------------------------------------------
  if (!promoter) {
    const cs = clientScope(user);
    for (const row of db
      .prepare(
        `SELECT b.product_id, b.warehouse_id, p.sku, p.name, w.name AS warehouse_name, SUM(b.qty) AS qty, MIN(b.expiry_date) AS expiry
         FROM stock_batches b JOIN products p ON p.id = b.product_id JOIN clients cl ON cl.id = p.client_id
         JOIN warehouses w ON w.id = b.warehouse_id
         WHERE b.qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ? AND ${cs.sql}
         GROUP BY b.product_id, b.warehouse_id, b.expiry_date < ?
         ORDER BY expiry`,
      )
      .all(saToday(30), ...cs.params, today)) {
      const expired = row.expiry < today;
      add({
        group: 'stock',
        severity: expired ? 'high' : 'medium',
        type: expired ? 'expired' : 'expiring',
        title: expired
          ? `${row.qty} × ${row.sku} expired at ${row.warehouse_name}`
          : `${row.qty} × ${row.sku} expire ${row.expiry} at ${row.warehouse_name}`,
        detail: expired ? `${row.name}. Write it off so it isn't counted as available.` : `${row.name}. Send it out first.`,
        link: 'expiry',
      });
    }

    for (const row of lowStock(db, user)) {
      add({
        group: 'stock',
        severity: row.on_hand === 0 ? 'high' : 'low',
        type: 'low_stock',
        title: `${row.sku} is ${row.on_hand === 0 ? 'out of stock' : `low (${row.on_hand} left)`}`,
        detail: `${row.name} · ${row.client_name}. Reorder level ${row.reorder_level}.`,
        link: 'stock',
      });
    }
  }

  if (ops) {
    const row = db.prepare('SELECT COALESCE(SUM(qty), 0) AS n FROM laundry_stock').get();
    if (row.n > 0) {
      add({
        group: 'stock',
        severity: 'low',
        type: 'laundry',
        title: `${row.n} uniform item(s) waiting to be washed and ironed`,
        detail: 'They can only be issued again once marked clean and ironed.',
        link: 'laundry',
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function reminderRoutes(db) {
  const r = express.Router();
  r.get('/', (req, res) => res.json(buildReminders(db, req.user)));
  return r;
}

module.exports = { reminderRoutes, buildReminders };
