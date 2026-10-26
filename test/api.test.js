'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { seed, DEMO_PASSWORD } = require('../src/seed');

let server;
let base;
let db;
const tokens = {};

async function call(who, method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

const id = (sql, ...params) => db.prepare(sql).get(...params).id;
const qty = (sku, warehouse) =>
  db
    .prepare(
      `SELECT COALESCE(s.qty, 0) AS q FROM products p JOIN warehouses w ON w.name = ?
       LEFT JOIN stock s ON s.product_id = p.id AND s.warehouse_id = w.id WHERE p.sku = ?`,
    )
    .get(warehouse, sku).q;

before(async () => {
  db = open(':memory:');
  seed(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, email] of [
    ['director', 'director@jrpromo.test'],
    ['office', 'office@jrpromo.test'],
    ['lerato', 'lerato@jrpromo.test'],
    ['pieter', 'pieter@jrpromo.test'],
    ['warehouse', 'warehouse@jrpromo.test'],
    ['nomsa', 'promoter@jrpromo.test'],
    ['kagiso', 'kagiso@jrpromo.test'],
  ]) {
    const res = await call(null, 'POST', '/auth/login', { email, password: DEMO_PASSWORD });
    assert.equal(res.status, 200, `login ${who}`);
    tokens[who] = res.data.token;
  }
});

after(() => server.close());

test('rejects bad credentials and unauthenticated calls', async () => {
  const bad = await call(null, 'POST', '/auth/login', { email: 'director@jrpromo.test', password: 'nope' });
  assert.equal(bad.status, 401);
  const anon = await call(null, 'GET', '/dashboard');
  assert.equal(anon.status, 401);
});

test('role permissions', async () => {
  assert.equal((await call('nomsa', 'GET', '/products')).status, 403);
  assert.equal((await call('nomsa', 'GET', '/users')).status, 403);
  assert.equal((await call('nomsa', 'POST', '/stock/receive', {})).status, 403);
  assert.equal((await call('lerato', 'POST', '/stock/receive', {})).status, 403);
  assert.equal((await call('warehouse', 'POST', '/requests/1/approve', {})).status, 403);
  assert.equal((await call('office', 'POST', '/users', {})).status, 403, 'only directors manage users');

  const amClients = (await call('lerato', 'GET', '/clients')).data.map((c) => c.name).sort();
  assert.deepEqual(amClients, ['Braai Master Sauces', 'Kalahari Coffee Co.', 'Sunfresh Juices']);

  // Account managers only see products for their own clients
  const amProducts = (await call('pieter', 'GET', '/products')).data;
  assert.ok(amProducts.length > 0);
  assert.ok(amProducts.every((p) => ['Ubuntu Mobile', 'Protea Skincare'].includes(p.client_name)));

  // Warehouse sees stock but not money
  const whDash = (await call('warehouse', 'GET', '/dashboard')).data;
  assert.equal(whDash.kpis.stock_value, undefined);
  assert.ok((await call('director', 'GET', '/dashboard')).data.kpis.stock_value > 0);
});

test('promoters only see their own requests and campaigns', async () => {
  const nomsaReqs = (await call('nomsa', 'GET', '/requests')).data;
  const nomsaId = id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
  assert.ok(nomsaReqs.length > 0);
  assert.ok(nomsaReqs.every((r) => r.promoter_id === nomsaId));

  const kagisoReq = id("SELECT r.id FROM requests r JOIN users u ON u.id = r.promoter_id WHERE u.email = 'kagiso@jrpromo.test'");
  assert.equal((await call('nomsa', 'GET', `/requests/${kagisoReq}`)).status, 404);

  const coffee = id("SELECT id FROM campaigns WHERE name = 'Kalahari Morning Commute'");
  assert.equal((await call('nomsa', 'GET', `/campaigns/${coffee}`)).status, 404);
});

test('full request lifecycle: request → approve → dispatch → deliver → use → return', async () => {
  const campaign = id("SELECT id FROM campaigns WHERE name = 'Sunfresh Summer Tastings'");
  const jhb = id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const tee = id("SELECT id FROM products WHERE sku = 'SFJ-UNI-TEE'");
  const aframe = id("SELECT id FROM products WHERE sku = 'SFJ-POS-AFR'");
  const teeBefore = qty('SFJ-UNI-TEE', 'JHB Main');

  // Promoter raises a request; it waits for approval
  const created = await call('nomsa', 'POST', '/requests', {
    campaign_id: campaign,
    warehouse_id: jhb,
    needed_by: '2030-01-01',
    items: [{ product_id: tee, qty: 6 }, { product_id: aframe, qty: 1 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.status, 'pending');
  const reqId = created.data.id;
  const teeItem = created.data.items.find((i) => i.product_id === tee);

  // Another client's AM cannot approve it
  assert.equal((await call('pieter', 'POST', `/requests/${reqId}/approve`, {})).status, 404);

  // Warehouse cannot dispatch before approval
  assert.equal((await call('warehouse', 'POST', `/requests/${reqId}/dispatch`, {})).status, 409);

  // AM approves fewer T-shirts than asked
  const approved = await call('lerato', 'POST', `/requests/${reqId}/approve`, { items: [{ id: teeItem.id, qty_approved: 4 }] });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.status, 'approved');
  assert.equal(approved.data.items.find((i) => i.product_id === tee).qty_approved, 4);

  // Allocated stock shows on the product
  const prod = (await call('warehouse', 'GET', `/products/${tee}`)).data;
  assert.equal(prod.allocated, 4);

  // Warehouse picks and dispatches
  assert.equal((await call('warehouse', 'POST', `/requests/${reqId}/pick`)).data.status, 'picking');
  const dispatched = await call('warehouse', 'POST', `/requests/${reqId}/dispatch`, { courier: 'The Courier Guy', waybill: 'TCG1' });
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.data));
  assert.equal(dispatched.data.status, 'dispatched');
  assert.equal(qty('SFJ-UNI-TEE', 'JHB Main'), teeBefore - 4);

  // Kagiso cannot confirm Nomsa's delivery; Nomsa can
  assert.equal((await call('kagiso', 'POST', `/requests/${reqId}/deliver`)).status, 404);
  assert.equal((await call('nomsa', 'POST', `/requests/${reqId}/deliver`)).data.status, 'delivered');

  const mine = async () => (await call('nomsa', 'GET', '/stock/mine')).data.find((m) => m.product_id === tee && m.campaign_id === campaign).qty;
  const heldBefore = await mine();

  // Promoter can't report using more than they hold
  const tooMuch = await call('nomsa', 'POST', '/usage', { campaign_id: campaign, items: [{ product_id: tee, qty_used: heldBefore + 1 }] });
  assert.equal(tooMuch.status, 409);

  const used = await call('nomsa', 'POST', '/usage', { campaign_id: campaign, store: 'Spar Fourways', items: [{ product_id: tee, qty_used: 1, qty_damaged: 1 }] });
  assert.equal(used.status, 201, JSON.stringify(used.data));
  assert.equal(await mine(), heldBefore - 2);

  // Return the rest; warehouse checks in 1 good and 1 damaged of 2 declared
  const ret = await call('nomsa', 'POST', '/returns', { campaign_id: campaign, warehouse_id: jhb, items: [{ product_id: tee, qty: 2 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.data));
  const teeOnHand = qty('SFJ-UNI-TEE', 'JHB Main');
  const recv = await call('warehouse', 'POST', `/returns/${ret.data.id}/receive`, {
    items: [{ id: ret.data.items[0].id, qty_good: 1, qty_damaged: 1 }],
  });
  assert.equal(recv.status, 200, JSON.stringify(recv.data));
  assert.equal(recv.data.status, 'received');
  assert.equal(qty('SFJ-UNI-TEE', 'JHB Main'), teeOnHand + 1);
  assert.equal(await mine(), heldBefore - 4);

  // Campaign reconciliation balances
  const summary = (await call('lerato', 'GET', `/campaigns/${campaign}`)).data.summary;
  for (const row of summary) {
    assert.equal(row.dispatched, row.used + row.damaged + row.returned + row.in_field, `reconciles ${row.sku}`);
  }
});

test('approval is blocked when the warehouse does not have enough free stock', async () => {
  // Seeded REQ-00013 asks for 1500 mango samples; JHB has only 600
  const reqId = id("SELECT id FROM requests WHERE ref = 'REQ-00013'");
  const res = await call('lerato', 'POST', `/requests/${reqId}/approve`, {});
  assert.equal(res.status, 409);
  assert.match(res.data.error, /available/);
  assert.equal(db.prepare('SELECT status FROM requests WHERE id = ?').get(reqId).status, 'pending');
});

test('AM requests for their own campaigns are auto-approved', async () => {
  const campaign = id("SELECT id FROM campaigns WHERE name = 'Kalahari Morning Commute'");
  const promoter = id("SELECT id FROM users WHERE email = 'kagiso@jrpromo.test'");
  const mug = id("SELECT id FROM products WHERE sku = 'KCC-GFT-MUG'");
  const jhb = id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const res = await call('lerato', 'POST', '/requests', {
    campaign_id: campaign, promoter_id: promoter, warehouse_id: jhb, items: [{ product_id: mug, qty: 5 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.status, 'approved');

  // Promoter not on the campaign is refused
  const nomsa = id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
  const bad = await call('lerato', 'POST', '/requests', {
    campaign_id: campaign, promoter_id: nomsa, warehouse_id: jhb, items: [{ product_id: mug, qty: 5 }],
  });
  assert.equal(bad.status, 400);

  // Another client's product is refused
  const sim = id("SELECT id FROM products WHERE sku = 'UBM-SIM-STK'");
  const wrong = await call('lerato', 'POST', '/requests', {
    campaign_id: campaign, promoter_id: promoter, warehouse_id: jhb, items: [{ product_id: sim, qty: 1 }],
  });
  assert.equal(wrong.status, 400);
});

test('failed multi-line operations roll back completely', async () => {
  const jhb = id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const cpt = id("SELECT id FROM warehouses WHERE name = 'Cape Town'");
  const mug = id("SELECT id FROM products WHERE sku = 'KCC-GFT-MUG'");
  const urn = id("SELECT id FROM products WHERE sku = 'KCC-EQP-URN'");
  const mugsBefore = qty('KCC-GFT-MUG', 'JHB Main');
  const movesBefore = db.prepare('SELECT COUNT(*) AS n FROM movements').get().n;
  const res = await call('warehouse', 'POST', '/stock/transfer', {
    from_warehouse_id: jhb,
    to_warehouse_id: cpt,
    items: [{ product_id: mug, qty: 10 }, { product_id: urn, qty: 9999 }],
  });
  assert.equal(res.status, 409);
  assert.equal(qty('KCC-GFT-MUG', 'JHB Main'), mugsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements').get().n, movesBefore);
});

test('receive, transfer and stock take update stock and the ledger', async () => {
  const dbn = id("SELECT id FROM warehouses WHERE name = 'Durban'");
  const cpt = id("SELECT id FROM warehouses WHERE name = 'Cape Town'");
  const bag = id("SELECT id FROM products WHERE sku = 'PRS-GFT-BAG'");
  const before = qty('PRS-GFT-BAG', 'Durban');

  assert.equal((await call('warehouse', 'POST', '/stock/receive', { warehouse_id: dbn, items: [{ product_id: bag, qty: 50 }] })).status, 400, 'reference required');
  const rec = await call('warehouse', 'POST', '/stock/receive', { warehouse_id: dbn, reference: 'GRN-TEST', items: [{ product_id: bag, qty: 50, bin: 'B-1-01' }] });
  assert.equal(rec.status, 201, JSON.stringify(rec.data));
  assert.equal(qty('PRS-GFT-BAG', 'Durban'), before + 50);

  const trf = await call('warehouse', 'POST', '/stock/transfer', { from_warehouse_id: dbn, to_warehouse_id: cpt, items: [{ product_id: bag, qty: 20 }] });
  assert.equal(trf.status, 201);
  assert.equal(qty('PRS-GFT-BAG', 'Durban'), before + 30);

  const count = await call('warehouse', 'POST', '/stock/count', { warehouse_id: dbn, items: [{ product_id: bag, counted: before + 28 }] });
  assert.deepEqual(count.data.variances, [{ product_id: bag, variance: -2 }]);
  assert.equal(qty('PRS-GFT-BAG', 'Durban'), before + 28);

  const ledger = (await call('director', 'GET', `/stock/movements?product_id=${bag}&warehouse_id=${dbn}`)).data;
  assert.deepEqual(ledger.slice(0, 3).map((m) => m.type), ['adjustment', 'transfer', 'receipt']);
});

test('ledger reconciles with stock tables for every product', () => {
  const rows = db
    .prepare(
      `SELECT p.sku,
         COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand,
         COALESCE((SELECT SUM(qty) FROM field_stock f WHERE f.product_id = p.id), 0) AS in_field,
         COALESCE(SUM(CASE WHEN m.type IN ('receipt','return','adjustment') THEN m.qty END), 0)
           - COALESCE(SUM(CASE WHEN m.type = 'dispatch' THEN m.qty END), 0) AS ledger_on_hand,
         COALESCE(SUM(CASE WHEN m.type = 'dispatch' THEN m.qty END), 0)
           - COALESCE(SUM(CASE WHEN m.type IN ('usage','damage','return') THEN m.qty END), 0) AS ledger_field
       FROM products p LEFT JOIN movements m ON m.product_id = p.id GROUP BY p.id`,
    )
    .all();
  for (const r of rows) {
    assert.equal(r.on_hand, r.ledger_on_hand, `warehouse stock for ${r.sku}`);
    assert.equal(r.in_field, r.ledger_field, `field stock for ${r.sku}`);
  }
});

test('CSV export escapes spreadsheet formulas', async () => {
  const client = id("SELECT id FROM clients WHERE name = 'Sunfresh Juices'");
  const created = await call('director', 'POST', '/products', {
    sku: 'CSV-TEST', name: '=HYPERLINK("http://evil")', client_id: client, category: 'Other',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const csv = await call('director', 'GET', '/stock/levels.csv?q=CSV-TEST');
  assert.match(csv.data, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
});

test('directors manage users; deactivated users lose access', async () => {
  const created = await call('director', 'POST', '/users', {
    name: 'Test Promoter', email: 'temp@jrpromo.test', role: 'promoter', password: 'longenough1',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const login = await call(null, 'POST', '/auth/login', { email: 'temp@jrpromo.test', password: 'longenough1' });
  assert.equal(login.status, 200);
  tokens.temp = login.data.token;
  assert.equal((await call('temp', 'GET', '/dashboard')).status, 200);

  await call('director', 'PATCH', `/users/${created.data.id}`, { active: false });
  assert.equal((await call('temp', 'GET', '/dashboard')).status, 401);

  const dup = await call('director', 'POST', '/users', { name: 'X', email: 'TEMP@jrpromo.test', role: 'promoter', password: 'longenough1' });
  assert.equal(dup.status, 409);
});
