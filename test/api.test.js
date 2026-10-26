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

// 1x1 transparent PNG, standing in for a drawn signature
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

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
  // Own clients plus the shared company stock
  assert.deepEqual(amClients, ['Braai Master Sauces', 'JR Promotions (company stock)', 'Kalahari Coffee Co.', 'Sunfresh Juices']);

  // Account managers only see products for their own clients
  const amProducts = (await call('pieter', 'GET', '/products')).data;
  assert.ok(amProducts.length > 0);
  assert.ok(amProducts.every((p) => ['Ubuntu Mobile', 'Protea Skincare', 'JR Promotions (company stock)'].includes(p.client_name)));

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

  // Warehouse picks and hands over at the counter (collect): uniforms must be checked and the promoter must sign
  assert.equal((await call('warehouse', 'POST', `/requests/${reqId}/pick`)).data.status, 'picking');
  const unsigned = await call('warehouse', 'POST', `/requests/${reqId}/dispatch`, { handover: { uniform_clean: true, uniform_ironed: true } });
  assert.equal(unsigned.status, 400);
  assert.match(unsigned.data.error, /sign/);
  const dirty = await call('warehouse', 'POST', `/requests/${reqId}/dispatch`, { handover: { signature: SIG, uniform_clean: true } });
  assert.equal(dirty.status, 400);
  assert.match(dirty.data.error, /clean and ironed/);
  assert.equal(qty('SFJ-UNI-TEE', 'JHB Main'), teeBefore, 'failed handover moved no stock');

  const issued = await call('warehouse', 'POST', `/requests/${reqId}/dispatch`, {
    handover: { signature: SIG, uniform_clean: true, uniform_ironed: true },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  assert.equal(issued.data.status, 'delivered', 'collected in person = delivered');
  assert.equal(qty('SFJ-UNI-TEE', 'JHB Main'), teeBefore - 4);

  // The handover records who processed whom, with signature and uniform check
  const [handover] = issued.data.handovers;
  assert.equal(handover.kind, 'collection');
  assert.equal(handover.staff_name, 'Sipho Nkosi');
  assert.equal(handover.promoter_name, 'Nomsa Khumalo');
  assert.equal(handover.signed, 1);
  assert.equal(handover.uniform_clean, 1);
  assert.equal(handover.uniform_ironed, 1);
  const sigRes = await fetch(`${base}/api/handovers/${handover.id}/signature.png`, { headers: { Authorization: `Bearer ${tokens.nomsa}` } });
  assert.equal(sigRes.headers.get('content-type'), 'image/png');
  const kagisoSig = await fetch(`${base}/api/handovers/${handover.id}/signature.png`, { headers: { Authorization: `Bearer ${tokens.kagiso}` } });
  assert.equal(kagisoSig.status, 404, 'other promoters cannot see the signature');

  const mine = async () => (await call('nomsa', 'GET', '/stock/mine')).data.find((m) => m.product_id === tee && m.campaign_id === campaign).qty;
  const heldBefore = await mine();

  // Promoter can't report using more than they hold
  const tooMuch = await call('nomsa', 'POST', '/usage', { campaign_id: campaign, items: [{ product_id: tee, qty_used: heldBefore + 1 }] });
  assert.equal(tooMuch.status, 409);

  const used = await call('nomsa', 'POST', '/usage', { campaign_id: campaign, store: 'Spar Fourways', items: [{ product_id: tee, qty_used: 1, qty_damaged: 1 }] });
  assert.equal(used.status, 201, JSON.stringify(used.data));
  assert.equal(await mine(), heldBefore - 2);

  // Return 3; warehouse checks in 1 clean, 1 needing laundry, 1 damaged
  const ret = await call('nomsa', 'POST', '/returns', { campaign_id: campaign, warehouse_id: jhb, items: [{ product_id: tee, qty: 3 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.data));
  const teeOnHand = qty('SFJ-UNI-TEE', 'JHB Main');
  const recv = await call('warehouse', 'POST', `/returns/${ret.data.id}/receive`, {
    items: [{ id: ret.data.items[0].id, qty_good: 1, qty_laundry: 1, qty_damaged: 1 }],
    handover: { signature: SIG },
  });
  assert.equal(recv.status, 200, JSON.stringify(recv.data));
  assert.equal(recv.data.status, 'received');
  assert.equal(qty('SFJ-UNI-TEE', 'JHB Main'), teeOnHand + 1);
  assert.equal(await mine(), heldBefore - 5);
  assert.equal(recv.data.handovers[0].uniform_clean, 0, 'a shirt needed washing');

  // The laundry: once washed and ironed it goes back into stock
  const laundry = (await call('warehouse', 'GET', '/stock/laundry')).data.find((l) => l.product_id === tee);
  assert.equal(laundry.qty, 1);
  assert.equal((await call('warehouse', 'POST', '/stock/laundry/clean', { items: [{ product_id: tee, warehouse_id: jhb, qty: 2 }] })).status, 409);
  assert.equal((await call('warehouse', 'POST', '/stock/laundry/clean', { items: [{ product_id: tee, warehouse_id: jhb, qty: 1 }] })).status, 200);
  assert.equal(qty('SFJ-UNI-TEE', 'JHB Main'), teeOnHand + 2);

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

test('expiry: receiving needs a date, dispatch skips expired batches, earliest expiry goes first', async () => {
  const jhb = id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const sachet = id("SELECT id FROM products WHERE sku = 'KCC-SMP-SCH'");
  const noDate = await call('warehouse', 'POST', '/stock/receive', { warehouse_id: jhb, reference: 'GRN-EXP-0', items: [{ product_id: sachet, qty: 10 }] });
  assert.equal(noDate.status, 400);
  assert.match(noDate.data.error, /expiry/);

  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  assert.equal(
    (await call('warehouse', 'POST', '/stock/receive', {
      warehouse_id: jhb,
      reference: 'GRN-EXP-1',
      items: [
        { product_id: sachet, qty: 50, batch_no: 'OLD', expiry_date: day(-2) },
        { product_id: sachet, qty: 30, batch_no: 'SOON', expiry_date: day(5) },
      ],
    })).status,
    201,
  );

  const product = (await call('director', 'GET', `/products/${sachet}`)).data;
  assert.equal(product.expired, 50);
  assert.equal(product.available, product.on_hand - product.allocated - 50, 'expired stock is not available');

  // AM raises a request: the 'SOON' batch must go before any later one, the expired one never
  const campaign = id("SELECT id FROM campaigns WHERE name = 'Kalahari Morning Commute'");
  const kagiso = id("SELECT id FROM users WHERE email = 'kagiso@jrpromo.test'");
  const req = await call('lerato', 'POST', '/requests', {
    campaign_id: campaign, promoter_id: kagiso, warehouse_id: jhb, delivery_method: 'company_vehicle', items: [{ product_id: sachet, qty: 40 }],
  });
  assert.equal(req.status, 201, JSON.stringify(req.data));
  const sent = await call('warehouse', 'POST', `/requests/${req.data.id}/dispatch`, {});
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const moves = db.prepare("SELECT batch_no, qty FROM movements WHERE type = 'dispatch' AND reference = ? ORDER BY id").all(req.data.ref);
  assert.equal(moves[0].batch_no, 'SOON');
  assert.equal(moves[0].qty, 30);
  assert.ok(moves.every((m) => m.batch_no !== 'OLD'));

  // Reminders flag it; writing off removes it
  const reminders = (await call('warehouse', 'GET', '/reminders')).data;
  assert.ok(reminders.some((r) => r.type === 'expired' && r.title.includes('KCC-SMP-SCH')));
  const wo = await call('warehouse', 'POST', '/stock/write-off-expired', { product_id: sachet, warehouse_id: jhb });
  assert.equal(wo.data.units, 50);
  assert.equal((await call('director', 'GET', `/products/${sachet}`)).data.expired, 0);
});

test('uniform ranges create every gender/colour/size SKU', async () => {
  const house = id('SELECT id FROM clients WHERE is_house = 1');
  const res = await call('office', 'POST', '/products/range', {
    style: 'Test apron', sku_prefix: 'TST-APR', client_id: house, genders: ['female', 'male'], sizes: ['S', 'M', 'L'], colours: 'Red, Navy',
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.created.length, 12);
  assert.ok(res.data.created.includes('TST-APR-F-NAVY-M'));
  const again = await call('office', 'POST', '/products/range', {
    style: 'Test apron', sku_prefix: 'TST-APR', client_id: house, genders: ['female'], sizes: ['S'], colours: ['Red'],
  });
  assert.deepEqual(again.data.skipped, ['TST-APR-F-RED-S']);
  // Account managers cannot add to company stock
  assert.equal((await call('lerato', 'POST', '/products/range', { style: 'X', sku_prefix: 'X', client_id: house, genders: ['male'], sizes: ['M'], colours: 'Red' })).status, 403);
});

test('QR scanning resolves badges, products and requests', async () => {
  const badge = db.prepare("SELECT badge_code FROM users WHERE email = 'promoter@jrpromo.test'").get().badge_code;
  const promoter = await call('warehouse', 'GET', `/scan?code=JRU:${badge}`);
  assert.equal(promoter.data.kind, 'promoter');
  assert.equal(promoter.data.promoter.name, 'Nomsa Khumalo');
  assert.equal((await call('nomsa', 'GET', `/scan?code=JRU:${badge}`)).status, 403);
  assert.equal((await call('warehouse', 'GET', '/scan?code=JRU:not-a-badge')).status, 404);
  assert.equal((await call('warehouse', 'GET', '/scan?code=JRP:JR-TBL-FOLD')).data.product.sku, 'JR-TBL-FOLD');
  assert.equal((await call('warehouse', 'GET', '/scan?code=JRR:REQ-00001')).data.kind, 'request');

  // Counter view shows the promoter's open work
  const nomsaId = id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
  const counter = await call('warehouse', 'GET', `/counter/${nomsaId}`);
  assert.equal(counter.data.promoter.name, 'Nomsa Khumalo');
  assert.ok(Array.isArray(counter.data.holding));
  assert.equal((await call('lerato', 'GET', `/counter/${nomsaId}`)).status, 403);

  // Reissuing a badge kills the old code
  await call('director', 'POST', `/users/${nomsaId}/badge`);
  assert.equal((await call('warehouse', 'GET', `/scan?code=JRU:${badge}`)).status, 404);

  const svg = await fetch(`${base}/api/qr.svg?text=JRP:TEST`, { headers: { Authorization: `Bearer ${tokens.warehouse}` } });
  assert.match(await svg.text(), /^<svg/);
});

test('waybill photos attach to deliveries and requests', async () => {
  const jhb = id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const jpeg = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`;
  const up = await call('warehouse', 'POST', '/attachments', { kind: 'receipt', reference: 'GRN-24101', warehouse_id: jhb, caption: 'Waybill', filename: 'wb.jpg', data: jpeg });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal((await call('warehouse', 'POST', '/attachments', { kind: 'receipt', reference: 'NOPE', warehouse_id: jhb, data: jpeg })).status, 404);
  assert.equal((await call('warehouse', 'POST', '/attachments', { kind: 'receipt', reference: 'GRN-24101', warehouse_id: jhb, data: 'data:text/html;base64,PGI+' })).status, 400);
  assert.equal((await call('nomsa', 'POST', '/attachments', { kind: 'receipt', reference: 'GRN-24101', warehouse_id: jhb, data: jpeg })).status, 403);

  const list = (await call('director', 'GET', '/deliveries')).data;
  assert.equal(list.find((d) => d.reference === 'GRN-24101').photos, 1);
  const detail = (await call('director', 'GET', `/deliveries/detail?reference=GRN-24101&warehouse_id=${jhb}`)).data;
  assert.equal(detail.attachments[0].caption, 'Waybill');
  const file = await fetch(`${base}/api/attachments/${up.data.id}/file`, { headers: { Authorization: `Bearer ${tokens.office}` } });
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.equal(await file.text(), 'fake-jpeg-bytes');

  // A promoter can attach a waybill photo to their own courier delivery, not someone else's
  const nomsaReq = id("SELECT r.id FROM requests r JOIN users u ON u.id = r.promoter_id WHERE u.email = 'promoter@jrpromo.test' AND r.delivery_method = 'courier'");
  const kagisoReq = id("SELECT r.id FROM requests r JOIN users u ON u.id = r.promoter_id WHERE u.email = 'kagiso@jrpromo.test'");
  assert.equal((await call('nomsa', 'POST', '/attachments', { kind: 'request', request_id: nomsaReq, data: jpeg })).status, 201);
  assert.equal((await call('nomsa', 'POST', '/attachments', { kind: 'request', request_id: kagisoReq, data: jpeg })).status, 404);
});

test('campaign plans, kits and company stock on any campaign', async () => {
  const campaign = id("SELECT id FROM campaigns WHERE name = 'Protea Mall Sampling'");
  const table = id("SELECT id FROM products WHERE sku = 'JR-TBL-FOLD'");
  const sim = id("SELECT id FROM products WHERE sku = 'UBM-SIM-STK'");
  const plan = await call('pieter', 'PUT', `/campaigns/${campaign}/plan`, { items: [{ product_id: table, planned_qty: 3 }] });
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  const row = plan.data.find((p) => p.product_id === table);
  assert.equal(row.planned_qty, 3);
  assert.equal(row.outstanding, 3 - row.dispatched - row.approved);
  assert.equal((await call('pieter', 'PUT', `/campaigns/${campaign}/plan`, { items: [{ product_id: sim, planned_qty: 1 }] })).status, 400, 'other client product');
  assert.equal((await call('lerato', 'PUT', `/campaigns/${campaign}/plan`, { items: [] })).status, 404, 'not their campaign');

  const kits = (await call('nomsa', 'GET', '/kits')).data;
  assert.ok(kits.find((k) => k.name === 'In-store tasting setup').items.length >= 3);
  const kit = await call('warehouse', 'POST', '/kits', { name: 'Test kit', items: [{ product_id: table, qty: 2 }] });
  assert.equal(kit.status, 201);
  assert.equal((await call('nomsa', 'POST', '/kits', { name: 'x', items: [{ product_id: table, qty: 1 }] })).status, 403);
});

test('older databases are upgraded in place', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { SCHEMA, SCHEMA_VERSION } = require('../src/db');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jr-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(SCHEMA);
  old.exec("INSERT INTO users (name, email, role, password_hash) VALUES ('Old', 'old@x.test', 'director', 'x')");
  old.close();
  const upgraded = open(file);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.ok(upgraded.prepare("SELECT badge_code FROM users WHERE email = 'old@x.test'").get().badge_code);
  upgraded.close();
});

// Runs last so it checks the ledger after every other test has moved stock
test('ledger reconciles with stock tables for every product', () => {
  const rows = db
    .prepare(
      `SELECT p.sku,
         COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand,
         COALESCE((SELECT SUM(qty) FROM field_stock f WHERE f.product_id = p.id), 0) AS in_field,
         COALESCE((SELECT SUM(qty) FROM laundry_stock l WHERE l.product_id = p.id), 0) AS in_laundry,
         COALESCE((SELECT SUM(qty) FROM stock_batches b WHERE b.product_id = p.id), 0) AS batched,
         p.tracks_expiry,
         COALESCE(SUM(CASE WHEN m.type IN ('receipt','return','adjustment','laundered') THEN m.qty END), 0)
           - COALESCE(SUM(CASE WHEN m.type IN ('dispatch','write_off') THEN m.qty END), 0) AS ledger_on_hand,
         COALESCE(SUM(CASE WHEN m.type = 'dispatch' THEN m.qty END), 0)
           - COALESCE(SUM(CASE WHEN m.type IN ('usage','damage','return','laundry') THEN m.qty END), 0) AS ledger_field,
         COALESCE(SUM(CASE WHEN m.type = 'laundry' THEN m.qty END), 0)
           - COALESCE(SUM(CASE WHEN m.type = 'laundered' THEN m.qty END), 0) AS ledger_laundry
       FROM products p LEFT JOIN movements m ON m.product_id = p.id GROUP BY p.id`,
    )
    .all();
  for (const r of rows) {
    assert.equal(r.on_hand, r.ledger_on_hand, `warehouse stock for ${r.sku}`);
    assert.equal(r.in_field, r.ledger_field, `field stock for ${r.sku}`);
    assert.equal(r.in_laundry, r.ledger_laundry, `laundry for ${r.sku}`);
    if (r.tracks_expiry) assert.equal(r.batched, r.on_hand, `batches add up for ${r.sku}`);
  }
});
