'use strict';

const express = require('express');
const { MANAGEMENT, WAREHOUSE, HttpError, allow, isManagement, isWarehouse } = require('../auth');
const v = require('../validate');
const stock = require('../stock');
const { tx } = require('../db');
const { assertCampaign, canManageCampaign } = require('../access');
const { checkScansOut, scanCheckFor } = require('../scanout');
const { campaignProducts } = require('./campaigns');

/**
 * Setups & strike downs: gazebos, backwalls, pull-up banners and tables built at a
 * venue and taken down afterwards.
 *
 *   scheduled -> loaded (stock leaves the warehouse, held by the crew lead)
 *             -> set_up (crew confirms on site, geotagged)
 *             -> struck (crew confirms strike down, geotagged)
 *             -> returned (warehouse checks the equipment back in, good / damaged)
 */

const OPERATORS = [MANAGEMENT, WAREHOUSE];
const PLANNERS = [MANAGEMENT, 'warehouse_manager', 'account_manager'];
const CREW_ROLES = ['warehouse', 'warehouse_manager', 'promoter'];
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function datetime(value, field, { required = false } = {}) {
  const s = v.str(value, field, { required, max: 16 });
  if (s && !DATETIME.test(s)) throw new HttpError(400, `${field} must be a date and time`);
  return s;
}

async function nextRef(db) {
  const row = (await db.get('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM setups'));
  return `SET-${String(row.n).padStart(5, '0')}`;
}

const SETUP_SELECT = `
  SELECT st.*, c.name AS campaign_name, c.colour AS campaign_colour, c.account_manager_id, cl.name AS client_name,
         w.name AS warehouse_name, ld.name AS lead_name, ld.phone AS lead_phone,
         lb.name AS loaded_by_name, sb.name AS set_up_by_name, kb.name AS struck_by_name, rb.name AS returned_by_name,
         (SELECT string_agg(u.name, ', ') FROM setup_crew sc JOIN users u ON u.id = sc.user_id WHERE sc.setup_id = st.id) AS crew_names,
         (SELECT COALESCE(SUM(qty), 0) FROM setup_items si WHERE si.setup_id = st.id) AS units
  FROM setups st
  JOIN campaigns c ON c.id = st.campaign_id
  JOIN clients cl ON cl.id = c.client_id
  JOIN warehouses w ON w.id = st.warehouse_id
  JOIN users ld ON ld.id = st.lead_id
  LEFT JOIN users lb ON lb.id = st.loaded_by
  LEFT JOIN users sb ON sb.id = st.set_up_by
  LEFT JOIN users kb ON kb.id = st.struck_by
  LEFT JOIN users rb ON rb.id = st.returned_by`;

/** Who sees which setups: office and warehouse all; AMs their campaigns; crew their own jobs. */
function setupScope(user) {
  if (isManagement(user) || isWarehouse(user)) return { sql: '1=1', params: [] };
  if (user.role === 'account_manager') return { sql: 'c.account_manager_id = ?', params: [user.id] };
  return {
    sql: '(st.lead_id = ? OR EXISTS (SELECT 1 FROM setup_crew sc WHERE sc.setup_id = st.id AND sc.user_id = ?))',
    params: [user.id, user.id],
  };
}

async function loadSetup(db, user, id) {
  const scope = setupScope(user);
  const s = v.found((await db.get(`${SETUP_SELECT} WHERE st.id = ? AND ${scope.sql}`, id, ...scope.params)), 'Setup');
  s.items = (await db.all(`SELECT si.*, p.sku, p.name AS product_name, p.category, p.barcode,
         COALESCE((SELECT qty FROM stock s WHERE s.product_id = si.product_id AND s.warehouse_id = ?), 0) AS warehouse_qty,
         (SELECT bin FROM stock s WHERE s.product_id = si.product_id AND s.warehouse_id = ?) AS bin,
         (SELECT sc.colour FROM campaigns sc WHERE sc.id = p.campaign_id) AS shelf_colour
       FROM setup_items si JOIN products p ON p.id = si.product_id WHERE si.setup_id = ? ORDER BY p.category, p.name`, s.warehouse_id, s.warehouse_id, id));
  s.crew = (await db.all('SELECT u.id, u.name, u.phone, u.role FROM setup_crew sc JOIN users u ON u.id = sc.user_id WHERE sc.setup_id = ? ORDER BY u.name', id));
  s.attachments = (await db.all(`SELECT a.id, a.caption, a.filename, a.mime, a.size, a.created_at, a.uploaded_by, a.lat, a.lng, a.accuracy, u.name AS uploaded_by_name
       FROM attachments a JOIN users u ON u.id = a.uploaded_by WHERE a.setup_id = ? ORDER BY a.id`, id));
  s.scan_check = await scanCheckFor(db, 'setup', s.ref);
  const onCrew = s.lead_id === user.id || s.crew.some((c) => c.id === user.id);
  const campaign = { id: s.campaign_id, account_manager_id: s.account_manager_id };
  s.can_plan = ['scheduled'].includes(s.status) && (canManageCampaign(user, campaign) || user.role === 'warehouse_manager');
  s.can_load = s.status === 'scheduled' && (isManagement(user) || isWarehouse(user));
  s.can_mark = ['loaded', 'set_up'].includes(s.status) && (onCrew || isManagement(user) || isWarehouse(user));
  s.can_return = ['loaded', 'set_up', 'struck'].includes(s.status) && (isManagement(user) || isWarehouse(user));
  return s;
}

async function assertCrew(db, userId, label) {
  const u = (await db.get('SELECT role, active, name FROM users WHERE id = ?', userId));
  if (!u || !u.active || !CREW_ROLES.includes(u.role)) throw new HttpError(400, `${label} must be an active promoter or warehouse staff member`);
}

function setupRoutes(db) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const scope = setupScope(req.user);
    const where = [scope.sql];
    const params = [...scope.params];
    const when = req.query.when || 'upcoming';
    if (when === 'upcoming') where.push("st.status NOT IN ('returned','cancelled')");
    else if (when === 'done') where.push("st.status IN ('returned','cancelled')");
    if (req.query.campaign_id) {
      where.push('st.campaign_id = ?');
      params.push(Number(req.query.campaign_id));
    }
    res.json(
      (await db.all(`${SETUP_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${when === 'done' ? 'st.setup_at DESC' : 'st.setup_at'} LIMIT 300`, ...params)),
    );
  });

  r.get('/:id', async (req, res) => res.json(await loadSetup(db, req.user, v.int(req.params.id, 'id', { required: true }))));

  const readBody = async (b, user, existingCampaignId) => {
    const campaign = await assertCampaign(db, user, v.int(b.campaign_id ?? existingCampaignId, 'Campaign', { required: true }));
    if (!canManageCampaign(user, campaign) && user.role !== 'warehouse_manager') {
      throw new HttpError(403, 'Only the account manager, warehouse manager or office can plan setups for this campaign');
    }
    const setupAt = datetime(b.setup_at, 'Setup date and time', { required: true });
    const strikeAt = datetime(b.strike_at, 'Strike down date and time');
    if (strikeAt && strikeAt < setupAt) throw new HttpError(400, 'Strike down cannot be before the setup');
    const leadId = v.int(b.lead_id, 'Crew lead', { required: true });
    await assertCrew(db, leadId, 'Crew lead');
    const crew = [...new Set((Array.isArray(b.crew_ids) ? b.crew_ids : []).map(Number).filter((x) => x && x !== leadId))];
    for (const c of crew) await assertCrew(db, c, 'Crew members');
    const allowed = new Set((await campaignProducts(db, campaign)).map((p) => p.id));
    const items = v.items(b.items, 'the equipment list').map((i) => ({
      productId: v.int(i.product_id, 'Product', { required: true }),
      qty: v.int(i.qty, 'Quantity', { required: true, min: 1 }),
    }));
    for (const i of items) if (!allowed.has(i.productId)) throw new HttpError(400, `Product #${i.productId} can't be used on this campaign`);
    if (new Set(items.map((i) => i.productId)).size !== items.length) throw new HttpError(400, 'Each product may appear once');
    const warehouseId = v.int(b.warehouse_id, 'Warehouse', { required: true });
    v.found((await db.get('SELECT 1 FROM warehouses WHERE id = ? AND active = 1', warehouseId)), 'Warehouse');
    return {
      campaign,
      fields: {
        warehouse_id: warehouseId,
        venue: v.str(b.venue, 'Venue', { required: true, max: 200 }),
        address: v.str(b.address, 'Address', { max: 300 }),
        contact: v.str(b.contact, 'Venue contact', { max: 200 }),
        setup_at: setupAt,
        strike_at: strikeAt,
        lead_id: leadId,
        notes: v.str(b.notes, 'Notes', { max: 2000 }),
      },
      crew,
      items,
    };
  };

  const saveChildren = async (setupId, crew, items) => {
    (await db.run('DELETE FROM setup_crew WHERE setup_id = ?', setupId));
    (await db.run('DELETE FROM setup_items WHERE setup_id = ?', setupId));
    for (const c of crew) (await db.run('INSERT INTO setup_crew (setup_id, user_id) VALUES (?, ?)', setupId, c));
    for (const i of items) (await db.run('INSERT INTO setup_items (setup_id, product_id, qty) VALUES (?, ?, ?)', setupId, i.productId, i.qty));
  };

  r.post('/', allow(PLANNERS), async (req, res) => {
    const { campaign, fields, crew, items } = await readBody(req.body, req.user);
    const id = await tx(db, async () => {
      const cols = Object.keys(fields);
      const info = (await db.insert(`INSERT INTO setups (ref, campaign_id, created_by, ${cols.join(', ')}) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`, await nextRef(db), campaign.id, req.user.id, ...Object.values(fields)));
      await saveChildren(info, crew, items);
      return info;
    });
    res.status(201).json(await loadSetup(db, req.user, id));
  });

  r.put('/:id', allow(PLANNERS), async (req, res) => {
    const existing = await loadSetup(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!existing.can_plan) throw new HttpError(409, `${existing.ref} can only be changed before it is loaded`);
    const { campaign, fields, crew, items } = await readBody(req.body, req.user, existing.campaign_id);
    await tx(db, async () => {
      (await db.run(`UPDATE setups SET campaign_id = ?, ${Object.keys(fields).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, campaign.id,
        ...Object.values(fields),
        existing.id));
      await saveChildren(existing.id, crew, items);
    });
    res.json(await loadSetup(db, req.user, existing.id));
  });

  // Warehouse loads the equipment out; it is then held by the crew lead until it comes back
  r.post('/:id/load', allow(OPERATORS), async (req, res) => {
    const s = await loadSetup(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!s.can_load) throw new HttpError(409, `${s.ref} is ${s.status}`);
    await tx(db, async () => {
      for (const item of s.items) {
        await stock.dispatch(db, {
          productId: item.product_id,
          warehouseId: s.warehouse_id,
          promoterId: s.lead_id,
          campaignId: s.campaign_id,
          qty: item.qty,
          reference: s.ref,
          userId: req.user.id,
        });
        (await db.run('UPDATE setup_items SET qty_out = ? WHERE id = ?', item.qty, item.id));
      }
      const expected = new Map(s.items.map((i) => [i.product_id, i.qty]));
      await checkScansOut(db, req.user, { kind: 'setup', reference: s.ref, warehouseId: s.warehouse_id, expected, scans: (req.body || {}).scans, override: (req.body || {}).scan_override });
      (await db.run("UPDATE setups SET status = 'loaded', loaded_by = ?, loaded_at = ? WHERE id = ?", req.user.id, new Date().toISOString(), s.id));
    });
    res.json(await loadSetup(db, req.user, s.id));
  });

  // Crew confirms on site, with the phone's location
  r.post('/:id/set-up', async (req, res) => {
    const s = await loadSetup(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!s.can_mark || s.status !== 'loaded') throw new HttpError(409, `${s.ref} can't be marked as set up now`);
    const loc = v.geo(req.body.location);
    (await db.run("UPDATE setups SET status = 'set_up', set_up_by = ?, set_up_at = ?, set_up_lat = ?, set_up_lng = ? WHERE id = ?", req.user.id,
      new Date().toISOString(),
      loc.lat,
      loc.lng,
      s.id));
    res.json(await loadSetup(db, req.user, s.id));
  });

  r.post('/:id/strike', async (req, res) => {
    const s = await loadSetup(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!s.can_mark) throw new HttpError(409, `${s.ref} can't be marked as struck down now`);
    const loc = v.geo(req.body.location);
    (await db.run("UPDATE setups SET status = 'struck', struck_by = ?, struck_at = ?, struck_lat = ?, struck_lng = ? WHERE id = ?", req.user.id,
      new Date().toISOString(),
      loc.lat,
      loc.lng,
      s.id));
    res.json(await loadSetup(db, req.user, s.id));
  });

  // Warehouse checks the equipment back in. Anything not counted stays against the crew lead.
  r.post('/:id/return', allow(OPERATORS), async (req, res) => {
    const s = await loadSetup(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!s.can_return) throw new HttpError(409, `${s.ref} is ${s.status}`);
    const counts = new Map((req.body.items || []).map((i) => [Number(i.id), i]));
    await tx(db, async () => {
      for (const item of s.items) {
        const c = counts.get(item.id) || {};
        const good = v.int(c.qty_good ?? item.qty_out, `Good qty for ${item.sku}`, { min: 0 });
        const damaged = v.int(c.qty_damaged ?? 0, `Damaged qty for ${item.sku}`, { min: 0 });
        if (good + damaged > item.qty_out) throw new HttpError(400, `${item.sku}: more than the ${item.qty_out} that went out`);
        await stock.returnToWarehouse(db, {
          productId: item.product_id,
          warehouseId: s.warehouse_id,
          promoterId: s.lead_id,
          campaignId: s.campaign_id,
          qtyGood: good,
          qtyDamaged: damaged,
          reference: s.ref,
          userId: req.user.id,
        });
        (await db.run('UPDATE setup_items SET qty_good = ?, qty_damaged = ? WHERE id = ?', good, damaged, item.id));
      }
      const now = new Date().toISOString();
      (await db.run(`UPDATE setups SET status = 'returned', returned_by = ?, returned_at = ?,
           struck_at = COALESCE(struck_at, ?), struck_by = COALESCE(struck_by, ?) WHERE id = ?`, req.user.id, now, now, req.user.id, s.id));
    });
    res.json(await loadSetup(db, req.user, s.id));
  });

  r.post('/:id/cancel', allow(PLANNERS), async (req, res) => {
    const s = await loadSetup(db, req.user, v.int(req.params.id, 'id', { required: true }));
    if (!s.can_plan) throw new HttpError(409, 'Only setups that have not been loaded can be cancelled');
    (await db.run("UPDATE setups SET status = 'cancelled' WHERE id = ?", s.id));
    res.json(await loadSetup(db, req.user, s.id));
  });

  return r;
}

module.exports = { setupRoutes, loadSetup };
