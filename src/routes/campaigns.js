'use strict';

const express = require('express');
const { MANAGEMENT, HttpError, allow } = require('../auth');
const v = require('../validate');
const { tx } = require('../db');
const { assertCampaign, campaignScope } = require('../access');
const stock = require('../stock');
const { CAMPAIGN_COLOURS, COLOUR_KEYS, nextColour } = require('../colours');

const STATUSES = ['planned', 'active', 'completed', 'cancelled'];

function campaignRoutes(db) {
  const r = express.Router();

  r.get('/colours', (req, res) => res.json(CAMPAIGN_COLOURS));

  r.get('/', async (req, res) => {
    const scope = campaignScope(req.user);
    const where = [scope.sql];
    const params = [...scope.params];
    if (req.query.status) {
      where.push('c.status = ?');
      params.push(req.query.status);
    }
    if (req.query.client_id) {
      where.push('c.client_id = ?');
      params.push(Number(req.query.client_id));
    }
    const rows = (await db.all(`SELECT c.*, cl.name AS client_name, u.name AS account_manager_name,
           (SELECT COUNT(*) FROM campaign_promoters cp WHERE cp.campaign_id = c.id) AS promoter_count,
           COALESCE((SELECT SUM(f.qty) FROM field_stock f WHERE f.campaign_id = c.id), 0) AS in_field
         FROM campaigns c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.account_manager_id
         WHERE ${where.join(' AND ')}
         ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, c.start_date DESC`, ...params));
    res.json(rows);
  });

  r.get('/:id', async (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    await assertCampaign(db, req.user, id);
    const campaign = (await db.get(`SELECT c.*, cl.name AS client_name, u.name AS account_manager_name
         FROM campaigns c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.account_manager_id
         WHERE c.id = ?`, id));
    campaign.promoters = (await db.all(`SELECT u.id, u.name, u.phone, u.region, u.gender, u.uniform_size FROM campaign_promoters cp JOIN users u ON u.id = cp.promoter_id
         WHERE cp.campaign_id = ? ORDER BY u.name`, id));
    campaign.summary = await campaignSummary(db, id, req.user);
    // Products shelved under this campaign's colour, with where they sit
    campaign.shelved =
      req.user.role === 'promoter'
        ? []
        : (await db.all(`SELECT p.id, p.sku, p.name, p.category, w.name AS warehouse_name, s.bin, s.qty
               FROM products p JOIN stock s ON s.product_id = p.id JOIN warehouses w ON w.id = s.warehouse_id
               WHERE p.campaign_id = ? AND s.qty > 0 ORDER BY w.name, s.bin, p.name`, id));
    campaign.plan = req.user.role === 'promoter' ? [] : await campaignPlan(db, id);
    res.json(campaign);
  });

  // Products that can be requested for a campaign, with what is free in each warehouse
  r.get('/:id/products', async (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const campaign = await assertCampaign(db, req.user, id);
    res.json(await campaignProducts(db, campaign));
  });

  // Shelf colour is a warehouse decision too, so the warehouse manager can change it
  r.put('/:id/colour', allow(MANAGEMENT, 'account_manager', 'warehouse_manager'), async (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    if (req.user.role === 'warehouse_manager') v.found((await db.get('SELECT 1 FROM campaigns WHERE id = ?', id)), 'Campaign');
    else await assertCampaign(db, req.user, id, { manage: true });
    const colour = v.oneOf(req.body.colour, 'Shelf colour', COLOUR_KEYS, { required: true });
    (await db.run('UPDATE campaigns SET colour = ? WHERE id = ?', colour, id));
    res.json((await db.get('SELECT * FROM campaigns WHERE id = ?', id)));
  });

  // Planned stock for the campaign vs what has been approved and sent
  r.put('/:id/plan', allow(MANAGEMENT, 'account_manager'), async (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const campaign = await assertCampaign(db, req.user, id, { manage: true });
    const allowed = new Set((await campaignProducts(db, campaign)).map((p) => p.id));
    const lines = Array.isArray(req.body.items) ? req.body.items : [];
    await tx(db, async () => {
      (await db.run('DELETE FROM campaign_plan WHERE campaign_id = ?', id));
      const ins = db.stmt('INSERT INTO campaign_plan (campaign_id, product_id, planned_qty) VALUES (?, ?, ?)');
      for (const l of lines) {
        const productId = v.int(l.product_id, 'Product', { required: true });
        const qty = v.int(l.planned_qty, 'Planned quantity', { required: true, min: 0 });
        if (!allowed.has(productId)) throw new HttpError(400, `Product #${productId} can't be used on this campaign`);
        if (qty > 0) await ins.run(id, productId, qty);
      }
    });
    res.json(await campaignPlan(db, id));
  });

  const fields = async (b, user) => {
    const clientId = v.int(b.client_id, 'Client', { required: true });
    const client = v.found((await db.get('SELECT * FROM clients WHERE id = ?', clientId)), 'Client');
    let amId = v.int(b.account_manager_id, 'Account manager') ?? client.account_manager_id;
    if (user.role === 'account_manager') {
      if (client.account_manager_id !== user.id) throw new HttpError(403, 'You can only run campaigns for your own clients');
      amId = user.id;
    }
    const start = v.date(b.start_date, 'Start date');
    const end = v.date(b.end_date, 'End date');
    if (start && end && end < start) throw new HttpError(400, 'End date cannot be before the start date');
    return [
      v.str(b.name, 'Campaign name', { required: true }),
      clientId,
      amId,
      v.str(b.region, 'Region'),
      start,
      end,
      v.oneOf(b.status, 'Status', STATUSES) || 'planned',
      v.str(b.notes, 'Notes', { max: 2000 }),
      v.oneOf(b.colour, 'Shelf colour', COLOUR_KEYS) || await nextColour(db),
    ];
  };

  const setPromoters = async (campaignId, ids) => {
    if (!Array.isArray(ids)) return;
    const check = db.stmt("SELECT 1 FROM users WHERE id = ? AND role = 'promoter'");
    for (const pid of ids) if (!await check.get(pid)) throw new HttpError(400, `User #${pid} is not a promoter`);
    (await db.run('DELETE FROM campaign_promoters WHERE campaign_id = ?', campaignId));
    const ins = db.stmt('INSERT INTO campaign_promoters (campaign_id, promoter_id) VALUES (?, ?)');
    for (const pid of new Set(ids.map(Number))) await ins.run(campaignId, pid);
  };

  r.post('/', allow(MANAGEMENT, 'account_manager'), async (req, res) => {
    const f = await fields(req.body, req.user);
    const id = await tx(db, async () => {
      const info = (await db.insert(`INSERT INTO campaigns (name, client_id, account_manager_id, region, start_date, end_date, status, notes, colour)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...f));
      await setPromoters(info, req.body.promoter_ids);
      return info;
    });
    res.status(201).json((await db.get('SELECT * FROM campaigns WHERE id = ?', id)));
  });

  r.put('/:id', allow(MANAGEMENT, 'account_manager'), async (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    await assertCampaign(db, req.user, id, { manage: true });
    const f = await fields(req.body, req.user);
    await tx(db, async () => {
      (await db.run(`UPDATE campaigns SET name=?, client_id=?, account_manager_id=?, region=?, start_date=?, end_date=?, status=?, notes=?, colour=?
         WHERE id=?`, ...f, id));
      await setPromoters(id, req.body.promoter_ids);
    });
    res.json((await db.get('SELECT * FROM campaigns WHERE id = ?', id)));
  });

  return r;
}

/**
 * Per-product stock reconciliation for a campaign:
 * dispatched = used + damaged + returned + still in field.
 */
async function campaignSummary(db, campaignId, user) {
  const rows = (await db.all(`SELECT p.id AS product_id, p.sku, p.name AS product_name,
         COALESCE(SUM(CASE WHEN m.type = 'dispatch' THEN m.qty END), 0) AS dispatched,
         COALESCE(SUM(CASE WHEN m.type = 'usage' THEN m.qty END), 0) AS used,
         COALESCE(SUM(CASE WHEN m.type = 'damage' THEN m.qty END), 0) AS damaged,
         COALESCE(SUM(CASE WHEN m.type IN ('return','laundry') THEN m.qty END), 0) AS returned,
         COALESCE((SELECT SUM(f.qty) FROM field_stock f WHERE f.campaign_id = ? AND f.product_id = p.id
                   ${user.role === 'promoter' ? 'AND f.promoter_id = ?' : ''}), 0) AS in_field
       FROM movements m JOIN products p ON p.id = m.product_id
       WHERE m.campaign_id = ? ${user.role === 'promoter' ? 'AND m.promoter_id = ?' : ''}
       GROUP BY p.id ORDER BY p.name`, ...(user.role === 'promoter' ? [campaignId, user.id, campaignId, user.id] : [campaignId, campaignId])));
  return rows;
}

/** Products a campaign may use: the client's own plus company (house) stock, with free stock per warehouse. */
async function campaignProducts(db, campaign) {
  const products = (await db.all(`SELECT p.id, p.sku, p.name, p.category, p.unit, p.gender, p.size, p.colour, p.style, cl.is_house
       FROM products p JOIN clients cl ON cl.id = p.client_id
       WHERE (p.client_id = ? OR cl.is_house = 1) AND p.active = 1
       ORDER BY cl.is_house, p.category, p.name`, campaign.client_id));
  const avail = db.stmt(
    `SELECT w.id AS warehouse_id, w.name AS warehouse_name,
       COALESCE(s.qty, 0)
       - COALESCE((SELECT SUM(ri.qty_approved) FROM request_items ri JOIN requests r ON r.id = ri.request_id
           WHERE ri.product_id = ?1 AND r.warehouse_id = w.id AND r.status IN ('approved','picking')), 0)
       - COALESCE((SELECT SUM(b.qty) FROM stock_batches b WHERE b.product_id = ?1 AND b.warehouse_id = w.id
           AND b.expiry_date < ?2), 0) AS available
     FROM warehouses w LEFT JOIN stock s ON s.warehouse_id = w.id AND s.product_id = ?1
     WHERE w.active = 1 ORDER BY w.name`,
  );
  const today = stock.saToday();
  for (const p of products) p.availability = (await avail.all(p.id, today)).map((a) => ({ ...a, available: Math.max(a.available, 0) }));
  return products;
}

async function campaignPlan(db, campaignId) {
  return (await db.all(`SELECT cp.product_id, cp.planned_qty, p.sku, p.name AS product_name, p.category,
         COALESCE((SELECT SUM(m.qty) FROM movements m WHERE m.type = 'dispatch' AND m.campaign_id = cp.campaign_id
                   AND m.product_id = cp.product_id), 0) AS dispatched,
         COALESCE((SELECT SUM(ri.qty_approved) FROM request_items ri JOIN requests r ON r.id = ri.request_id
                   WHERE r.campaign_id = cp.campaign_id AND ri.product_id = cp.product_id
                   AND r.status IN ('approved','picking')), 0) AS approved,
         COALESCE((SELECT SUM(ri.qty_requested) FROM request_items ri JOIN requests r ON r.id = ri.request_id
                   WHERE r.campaign_id = cp.campaign_id AND ri.product_id = cp.product_id AND r.status = 'pending'), 0) AS requested,
         COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = cp.product_id), 0) AS on_hand
       FROM campaign_plan cp JOIN products p ON p.id = cp.product_id
       WHERE cp.campaign_id = ? ORDER BY p.category, p.name`, campaignId))
    .map((row) => ({ ...row, outstanding: Math.max(row.planned_qty - row.dispatched - row.approved, 0) }));
}

module.exports = { campaignRoutes, campaignSummary, campaignProducts, campaignPlan };
