'use strict';

const express = require('express');
const { HttpError, allow, STOCK_APPROVERS } = require('../auth');
const v = require('../validate');
const stock = require('../stock');
const { assertCampaign } = require('../access');

/**
 * BA collection/return form: everything a promoter (brand ambassador) was issued
 * for a campaign, what they used and brought back, the signatures and condition at
 * each handover, and the office sign-off (manager check, cleared for payment).
 */
async function loadForm(db, user, campaignId, promoterId) {
  const campaign = await assertCampaign(db, user, campaignId);
  if (user.role === 'promoter' && user.id !== promoterId) throw new HttpError(404, 'Form not found');
  const promoter = v.found(
    (await db.get('SELECT id, name, phone, region, role, gender, uniform_size, id_number FROM users WHERE id = ?', promoterId)),
    'Promoter',
  );
  // Account managers don't need the ID number; the promoter, warehouse and office do
  if (user.role === 'account_manager') delete promoter.id_number;
  const client = (await db.get('SELECT name FROM clients WHERE id = ?', campaign.client_id));

  const lines = (await db.all(`SELECT p.id AS product_id, p.sku, p.name, p.category, p.unit, p.gender, p.size, p.colour,
         SUM(CASE WHEN m.type = 'dispatch' THEN m.qty ELSE 0 END) AS issued,
         MIN(CASE WHEN m.type = 'dispatch' THEN m.created_at END) AS first_issued_at,
         SUM(CASE WHEN m.type = 'usage' THEN m.qty ELSE 0 END) AS used,
         SUM(CASE WHEN m.type = 'damage' AND m.note = :field THEN m.qty ELSE 0 END) AS damaged_in_field,
         SUM(CASE WHEN m.type IN ('return', 'laundry') THEN m.qty ELSE 0 END) AS returned_good,
         SUM(CASE WHEN m.type = 'damage' AND m.note = :ret THEN m.qty ELSE 0 END) AS returned_damaged,
         MAX(CASE WHEN m.type IN ('return', 'laundry') OR (m.type = 'damage' AND m.note = :ret) THEN m.created_at END) AS last_returned_at,
         COALESCE((SELECT f.qty FROM field_stock f WHERE f.product_id = p.id AND f.promoter_id = :promoter AND f.campaign_id = :campaign), 0) AS outstanding
       FROM movements m JOIN products p ON p.id = m.product_id
       WHERE m.promoter_id = :promoter AND m.campaign_id = :campaign
       GROUP BY p.id HAVING SUM(CASE WHEN m.type = 'dispatch' THEN m.qty ELSE 0 END) > 0
       ORDER BY p.category, p.name`, { promoter: promoterId, campaign: campaignId, field: stock.DAMAGED_IN_FIELD, ret: stock.DAMAGED_ON_RETURN }));
  for (const l of lines) l.returned = l.returned_good + l.returned_damaged;
  if (!lines.length && !(await db.get('SELECT 1 FROM campaign_promoters WHERE campaign_id = ? AND promoter_id = ?', campaignId, promoterId))) {
    throw new HttpError(404, `${promoter.name} has no stock or place on this campaign`);
  }

  const handovers = (await db.all(`SELECT h.id, h.kind, h.created_at, (h.signature IS NOT NULL)::int AS signed, h.stock_condition, h.uniform_clean, h.uniform_ironed,
         h.note, st.name AS staff_name, COALESCE(rq.ref, rt.ref) AS ref
       FROM handovers h
       LEFT JOIN users st ON st.id = h.staff_id
       LEFT JOIN requests rq ON rq.id = h.request_id
       LEFT JOIN returns rt ON rt.id = h.return_id
       WHERE h.promoter_id = ? AND (rq.campaign_id = ? OR rt.campaign_id = ?)
       ORDER BY h.id`, promoterId, campaignId, campaignId));
  const clearance =
    (await db.get(`SELECT bc.*, cu.name AS checked_by_name, pu.name AS cleared_by_name FROM ba_clearances bc
         LEFT JOIN users cu ON cu.id = bc.checked_by LEFT JOIN users pu ON pu.id = bc.cleared_by
         WHERE bc.campaign_id = ? AND bc.promoter_id = ?`, campaignId, promoterId)) || null;
  const outstanding = lines.reduce((a, l) => a + l.outstanding, 0);
  return {
    campaign: { id: campaign.id, name: campaign.name, client_name: client && client.name, start_date: campaign.start_date, end_date: campaign.end_date, colour: campaign.colour },
    promoter,
    lines,
    issued_handovers: handovers.filter((h) => h.kind !== 'return'),
    return_handovers: handovers.filter((h) => h.kind === 'return'),
    clearance,
    outstanding,
    can_sign_off: STOCK_APPROVERS.includes(user.role),
  };
}

function baFormRoutes(db) {
  const r = express.Router();

  // Every promoter on a campaign (or holding its stock), with where their form stands
  r.get('/', async (req, res) => {
    const campaign = await assertCampaign(db, req.user, v.int(req.query.campaign_id, 'Campaign', { required: true }));
    const rows = (await db.all(`SELECT u.id AS promoter_id, u.name,
           COALESCE((SELECT SUM(m.qty) FROM movements m WHERE m.type = 'dispatch' AND m.promoter_id = u.id AND m.campaign_id = :c), 0) AS issued,
           COALESCE((SELECT SUM(f.qty) FROM field_stock f WHERE f.promoter_id = u.id AND f.campaign_id = :c), 0) AS outstanding,
           bc.checked_at, bc.cleared_at
         FROM users u LEFT JOIN ba_clearances bc ON bc.promoter_id = u.id AND bc.campaign_id = :c
         WHERE u.id IN (SELECT promoter_id FROM campaign_promoters WHERE campaign_id = :c
                        UNION SELECT promoter_id FROM movements WHERE campaign_id = :c AND promoter_id IS NOT NULL)
           AND (:me = 0 OR u.id = :me)
         ORDER BY u.name`, { c: campaign.id, me: req.user.role === 'promoter' ? req.user.id : 0 }));
    res.json(rows);
  });

  const ids = (req) => [v.int(req.params.campaignId, 'Campaign', { required: true }), v.int(req.params.promoterId, 'Promoter', { required: true })];

  r.get('/:campaignId/:promoterId', async (req, res) => res.json(await loadForm(db, req.user, ...ids(req))));

  const upsert = async (campaignId, promoterId) =>
    (await db.run('INSERT INTO ba_clearances (campaign_id, promoter_id) VALUES (?, ?) ON CONFLICT DO NOTHING', campaignId, promoterId));

  // Office use: the warehouse manager checks the issue
  r.post('/:campaignId/:promoterId/check', allow(STOCK_APPROVERS), async (req, res) => {
    const [c, p] = ids(req);
    const form = await loadForm(db, req.user, c, p);
    if (!form.lines.length) throw new HttpError(409, 'Nothing has been issued yet');
    await upsert(c, p);
    (await db.run('UPDATE ba_clearances SET checked_by = ?, checked_at = ?, check_comment = ? WHERE campaign_id = ? AND promoter_id = ?', req.user.id, new Date().toISOString(), v.str(req.body.comment, 'Comment', { max: 500 }), c, p));
    res.json(await loadForm(db, req.user, c, p));
  });

  // Office use: cleared for payment once everything is back (used, returned or written off as damaged)
  r.post('/:campaignId/:promoterId/clear', allow(STOCK_APPROVERS), async (req, res) => {
    const [c, p] = ids(req);
    const form = await loadForm(db, req.user, c, p);
    if (form.clearance && form.clearance.cleared_at) throw new HttpError(409, `${form.promoter.name} is already cleared for payment`);
    if (form.outstanding > 0) {
      const owed = form.lines.filter((l) => l.outstanding > 0).map((l) => `${l.outstanding} × ${l.name}`);
      throw new HttpError(409, `${form.promoter.name} still has ${owed.join(', ')}. Book the return (or the usage report) first.`);
    }
    await upsert(c, p);
    (await db.run('UPDATE ba_clearances SET cleared_by = ?, cleared_at = ?, clear_comment = ? WHERE campaign_id = ? AND promoter_id = ?', req.user.id, new Date().toISOString(), v.str(req.body.comment, 'Comment', { max: 500 }), c, p));
    res.json(await loadForm(db, req.user, c, p));
  });

  return r;
}

module.exports = { baFormRoutes };
