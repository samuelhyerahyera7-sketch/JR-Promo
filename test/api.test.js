'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { seed, DEMO_PASSWORD } = require('../src/seed');

// A throwaway PostgreSQL database; it is wiped at the start of every run
const TEST_URL = process.env.TEST_DATABASE_URL || 'postgresql://jr:jr@localhost:5432/jr_test';

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

// Labels scanned as stock leaves, one unit each: scans('SKU-A', 3, 'SKU-B', 1)
const scans = (...pairs) => {
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) for (let n = 0; n < pairs[i + 1]; n++) out.push(`JRP:${pairs[i]}`);
  return out;
};

const id = async (sql, ...params) => (await db.get(sql, ...params)).id;
const qty = async (sku, warehouse) =>
  (await db.get(`SELECT COALESCE(s.qty, 0) AS q FROM products p JOIN warehouses w ON w.name = ?
       LEFT JOIN stock s ON s.product_id = p.id AND s.warehouse_id = w.id WHERE p.sku = ?`, warehouse, sku)).q;

before(async () => {
  db = await open(TEST_URL, { reset: true });
  await seed(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [who, email] of [
    ['director', 'director@jrpromo.test'],
    ['office', 'office@jrpromo.test'],
    ['lerato', 'lerato@jrpromo.test'],
    ['pieter', 'pieter@jrpromo.test'],
    ['manager', 'manager@jrpromo.test'],
    ['warehouse', 'warehouse@jrpromo.test'],
    ['ashwin', 'ashwin@jrpromo.test'],
    ['liam', 'liam@jrpromo.test'],
    ['nomsa', 'promoter@jrpromo.test'],
    ['kagiso', 'kagiso@jrpromo.test'],
  ]) {
    const res = await call(null, 'POST', '/auth/login', { email, password: DEMO_PASSWORD });
    assert.equal(res.status, 200, `login ${who}`);
    tokens[who] = res.data.token;
  }
});

after(async () => {
  server.close();
  await db.close();
});

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

  // No money anywhere: dashboards, clients and warehouses report units only
  for (const who of ['warehouse', 'director', 'lerato']) {
    const kpis = (await call(who, 'GET', '/dashboard')).data.kpis;
    assert.equal(kpis.stock_value, undefined);
    assert.equal(kpis.field_value, undefined);
  }
  assert.ok((await call('director', 'GET', '/clients')).data.every((c) => !('stock_value' in c)));
  assert.ok((await call('director', 'GET', '/warehouses')).data.every((w) => !('value' in w)));
});

test('promoters only see their own requests and campaigns', async () => {
  const nomsaReqs = (await call('nomsa', 'GET', '/requests')).data;
  const nomsaId = await id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
  assert.ok(nomsaReqs.length > 0);
  assert.ok(nomsaReqs.every((r) => r.promoter_id === nomsaId));

  const kagisoReq = await id("SELECT r.id FROM requests r JOIN users u ON u.id = r.promoter_id WHERE u.email = 'kagiso@jrpromo.test'");
  assert.equal((await call('nomsa', 'GET', `/requests/${kagisoReq}`)).status, 404);

  const coffee = await id("SELECT id FROM campaigns WHERE name = 'Kalahari Morning Commute'");
  assert.equal((await call('nomsa', 'GET', `/campaigns/${coffee}`)).status, 404);
});

test('full request lifecycle: request → approve → dispatch → deliver → use → return', async () => {
  const campaign = await id("SELECT id FROM campaigns WHERE name = 'Sunfresh Summer Tastings'");
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const tee = await id("SELECT id FROM products WHERE sku = 'SFJ-UNI-TEE'");
  const aframe = await id("SELECT id FROM products WHERE sku = 'SFJ-POS-AFR'");
  const teeBefore = await qty('SFJ-UNI-TEE', 'JHB Main');

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
  assert.equal(await qty('SFJ-UNI-TEE', 'JHB Main'), teeBefore, 'failed handover moved no stock');

  // Everything going out must be scanned
  const short = await call('warehouse', 'POST', `/requests/${reqId}/dispatch`, {
    handover: { signature: SIG, uniform_clean: true, uniform_ironed: true },
    scans: scans('SFJ-UNI-TEE', 3, 'SFJ-POS-AFR', 1),
  });
  assert.equal(short.status, 409);
  assert.match(short.data.error, /SFJ-UNI-TEE: scanned 3 of 4/);
  assert.equal(await qty('SFJ-UNI-TEE', 'JHB Main'), teeBefore, 'unscanned stock did not move');

  const issued = await call('warehouse', 'POST', `/requests/${reqId}/dispatch`, {
    handover: { signature: SIG, uniform_clean: true, uniform_ironed: true },
    scans: scans('SFJ-UNI-TEE', 4, 'SFJ-POS-AFR', 1),
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  assert.equal(issued.data.status, 'delivered', 'collected in person = delivered');
  assert.equal(await qty('SFJ-UNI-TEE', 'JHB Main'), teeBefore - 4);

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
  const teeOnHand = await qty('SFJ-UNI-TEE', 'JHB Main');
  const recv = await call('warehouse', 'POST', `/returns/${ret.data.id}/receive`, {
    items: [{ id: ret.data.items[0].id, qty_good: 1, qty_laundry: 1, qty_damaged: 1 }],
    handover: { signature: SIG },
  });
  assert.equal(recv.status, 200, JSON.stringify(recv.data));
  assert.equal(recv.data.status, 'received');
  assert.equal(await qty('SFJ-UNI-TEE', 'JHB Main'), teeOnHand + 1);
  assert.equal(await mine(), heldBefore - 5);
  assert.equal(recv.data.handovers[0].uniform_clean, 0, 'a shirt needed washing');

  // The laundry: once washed and ironed it goes back into stock
  const laundry = (await call('warehouse', 'GET', '/stock/laundry')).data.find((l) => l.product_id === tee);
  assert.equal(laundry.qty, 1);
  assert.equal((await call('warehouse', 'POST', '/stock/laundry/clean', { items: [{ product_id: tee, warehouse_id: jhb, qty: 2 }] })).status, 409);
  assert.equal((await call('warehouse', 'POST', '/stock/laundry/clean', { items: [{ product_id: tee, warehouse_id: jhb, qty: 1 }] })).status, 200);
  assert.equal(await qty('SFJ-UNI-TEE', 'JHB Main'), teeOnHand + 2);

  // Campaign reconciliation balances
  const summary = (await call('lerato', 'GET', `/campaigns/${campaign}`)).data.summary;
  for (const row of summary) {
    assert.equal(row.dispatched, row.used + row.damaged + row.returned + row.in_field, `reconciles ${row.sku}`);
  }
});

test('approval is blocked when the warehouse does not have enough free stock', async () => {
  // Seeded REQ-00013 asks for 1500 mango samples; JHB has only 600
  const reqId = await id("SELECT id FROM requests WHERE ref = 'REQ-00013'");
  const res = await call('lerato', 'POST', `/requests/${reqId}/approve`, {});
  assert.equal(res.status, 409);
  assert.match(res.data.error, /available/);
  assert.equal((await db.get('SELECT status FROM requests WHERE id = ?', reqId)).status, 'pending');
});

test('AM requests for their own campaigns are auto-approved', async () => {
  const campaign = await id("SELECT id FROM campaigns WHERE name = 'Kalahari Morning Commute'");
  const promoter = await id("SELECT id FROM users WHERE email = 'kagiso@jrpromo.test'");
  const mug = await id("SELECT id FROM products WHERE sku = 'KCC-GFT-MUG'");
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const res = await call('lerato', 'POST', '/requests', {
    campaign_id: campaign, promoter_id: promoter, warehouse_id: jhb, items: [{ product_id: mug, qty: 5 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.status, 'approved');

  // Promoter not on the campaign is refused
  const nomsa = await id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
  const bad = await call('lerato', 'POST', '/requests', {
    campaign_id: campaign, promoter_id: nomsa, warehouse_id: jhb, items: [{ product_id: mug, qty: 5 }],
  });
  assert.equal(bad.status, 400);

  // Another client's product is refused
  const sim = await id("SELECT id FROM products WHERE sku = 'UBM-SIM-STK'");
  const wrong = await call('lerato', 'POST', '/requests', {
    campaign_id: campaign, promoter_id: promoter, warehouse_id: jhb, items: [{ product_id: sim, qty: 1 }],
  });
  assert.equal(wrong.status, 400);
});

test('failed multi-line operations roll back completely', async () => {
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const cpt = await id("SELECT id FROM warehouses WHERE name = 'Cape Town'");
  const mug = await id("SELECT id FROM products WHERE sku = 'KCC-GFT-MUG'");
  const urn = await id("SELECT id FROM products WHERE sku = 'KCC-EQP-URN'");
  const mugsBefore = await qty('KCC-GFT-MUG', 'JHB Main');
  const movesBefore = (await db.get('SELECT COUNT(*) AS n FROM movements')).n;
  const res = await call('warehouse', 'POST', '/stock/transfer', {
    from_warehouse_id: jhb,
    to_warehouse_id: cpt,
    items: [{ product_id: mug, qty: 10 }, { product_id: urn, qty: 9999 }],
  });
  assert.equal(res.status, 409);
  assert.equal(await qty('KCC-GFT-MUG', 'JHB Main'), mugsBefore);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM movements')).n, movesBefore);
});

test('receive, transfer and stock take update stock and the ledger', async () => {
  const dbn = await id("SELECT id FROM warehouses WHERE name = 'Durban'");
  const cpt = await id("SELECT id FROM warehouses WHERE name = 'Cape Town'");
  const bag = await id("SELECT id FROM products WHERE sku = 'PRS-GFT-BAG'");
  const before = await qty('PRS-GFT-BAG', 'Durban');

  assert.equal((await call('warehouse', 'POST', '/stock/receive', { warehouse_id: dbn, items: [{ product_id: bag, qty: 50 }] })).status, 400, 'reference required');
  const rec = await call('warehouse', 'POST', '/stock/receive', { warehouse_id: dbn, reference: 'GRN-TEST', items: [{ product_id: bag, qty: 50, bin: 'B-1-01' }] });
  assert.equal(rec.status, 201, JSON.stringify(rec.data));
  assert.equal(await qty('PRS-GFT-BAG', 'Durban'), before + 50);

  const trf = await call('warehouse', 'POST', '/stock/transfer', { from_warehouse_id: dbn, to_warehouse_id: cpt, items: [{ product_id: bag, qty: 20 }], scans: scans('PRS-GFT-BAG', 20) });
  assert.equal(trf.status, 201);
  assert.equal(await qty('PRS-GFT-BAG', 'Durban'), before + 30);

  // Direct corrections are for managers only, and need a reason
  assert.equal((await call('warehouse', 'POST', '/stock/count', { warehouse_id: dbn, note: 'x', items: [{ product_id: bag, counted: 0 }] })).status, 403);
  assert.equal((await call('manager', 'POST', '/stock/count', { warehouse_id: dbn, items: [{ product_id: bag, counted: 0 }] })).status, 400);
  const count = await call('manager', 'POST', '/stock/count', { warehouse_id: dbn, note: 'Investigated', items: [{ product_id: bag, counted: before + 28 }] });
  assert.deepEqual(count.data.variances, [{ product_id: bag, variance: -2 }]);
  assert.equal(await qty('PRS-GFT-BAG', 'Durban'), before + 28);

  const ledger = (await call('director', 'GET', `/stock/movements?product_id=${bag}&warehouse_id=${dbn}`)).data;
  assert.deepEqual(ledger.slice(0, 3).map((m) => m.type), ['adjustment', 'transfer', 'receipt']);
});

test('CSV export escapes spreadsheet formulas', async () => {
  const client = await id("SELECT id FROM clients WHERE name = 'Sunfresh Juices'");
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
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const sachet = await id("SELECT id FROM products WHERE sku = 'KCC-SMP-SCH'");
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
  const campaign = await id("SELECT id FROM campaigns WHERE name = 'Kalahari Morning Commute'");
  const kagiso = await id("SELECT id FROM users WHERE email = 'kagiso@jrpromo.test'");
  const req = await call('lerato', 'POST', '/requests', {
    campaign_id: campaign, promoter_id: kagiso, warehouse_id: jhb, delivery_method: 'company_vehicle', items: [{ product_id: sachet, qty: 40 }],
  });
  assert.equal(req.status, 201, JSON.stringify(req.data));
  const sent = await call('warehouse', 'POST', `/requests/${req.data.id}/dispatch`, { scans: scans('KCC-SMP-SCH', 40) });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const moves = (await db.all("SELECT batch_no, qty FROM movements WHERE type = 'dispatch' AND reference = ? ORDER BY id", req.data.ref));
  assert.equal(moves[0].batch_no, 'SOON');
  assert.equal(moves[0].qty, 30);
  assert.ok(moves.every((m) => m.batch_no !== 'OLD'));

  // Reminders flag it; writing off removes it
  const reminders = (await call('warehouse', 'GET', '/reminders')).data;
  assert.ok(reminders.some((r) => r.type === 'expired' && r.title.includes('KCC-SMP-SCH')));
  assert.equal((await call('warehouse', 'POST', '/stock/write-off-expired', { product_id: sachet, warehouse_id: jhb })).status, 403, 'staff cannot write off');
  const wo = await call('manager', 'POST', '/stock/write-off-expired', { product_id: sachet, warehouse_id: jhb });
  assert.equal(wo.data.units, 50);
  assert.equal((await call('director', 'GET', `/products/${sachet}`)).data.expired, 0);
});

test('uniform ranges create every gender/colour/size SKU', async () => {
  const house = await id('SELECT id FROM clients WHERE is_house = 1');
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
  const badge = (await db.get("SELECT badge_code FROM users WHERE email = 'promoter@jrpromo.test'")).badge_code;
  const promoter = await call('warehouse', 'GET', `/scan?code=JRU:${badge}`);
  assert.equal(promoter.data.kind, 'promoter');
  assert.equal(promoter.data.promoter.name, 'Nomsa Khumalo');
  assert.equal((await call('nomsa', 'GET', `/scan?code=JRU:${badge}`)).status, 403);
  assert.equal((await call('warehouse', 'GET', '/scan?code=JRU:not-a-badge')).status, 404);
  assert.equal((await call('warehouse', 'GET', '/scan?code=JRP:JR-TBL-FOLD')).data.product.sku, 'JR-TBL-FOLD');
  assert.equal((await call('warehouse', 'GET', '/scan?code=JRR:REQ-00001')).data.kind, 'request');

  // Counter view shows the promoter's open work
  const nomsaId = await id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
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
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
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
  const nomsaReq = await id("SELECT r.id FROM requests r JOIN users u ON u.id = r.promoter_id WHERE u.email = 'promoter@jrpromo.test' AND r.delivery_method = 'courier'");
  const kagisoReq = await id("SELECT r.id FROM requests r JOIN users u ON u.id = r.promoter_id WHERE u.email = 'kagiso@jrpromo.test'");
  assert.equal((await call('nomsa', 'POST', '/attachments', { kind: 'request', request_id: nomsaReq, data: jpeg })).status, 201);
  assert.equal((await call('nomsa', 'POST', '/attachments', { kind: 'request', request_id: kagisoReq, data: jpeg })).status, 404);
});

test('campaign plans, kits and company stock on any campaign', async () => {
  const campaign = await id("SELECT id FROM campaigns WHERE name = 'Protea Mall Sampling'");
  const table = await id("SELECT id FROM products WHERE sku = 'JR-TBL-FOLD'");
  const sim = await id("SELECT id FROM products WHERE sku = 'UBM-SIM-STK'");
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

test('reconnecting checks the schema and leaves the data alone', async () => {
  const { SCHEMA_VERSION } = require('../src/db');
  const users = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  const again = await open(TEST_URL);
  assert.equal((await again.get('SELECT version FROM schema_version')).version, SCHEMA_VERSION);
  assert.equal((await again.get('SELECT COUNT(*) AS n FROM users')).n, users);
  // Email addresses are unique whatever their case, and sign-in ignores case
  await assert.rejects(again.run("INSERT INTO users (name, email, role, password_hash) VALUES ('X', 'DIRECTOR@jrpromo.test', 'director', 'x')"));
  assert.equal((await call(null, 'POST', '/auth/login', { email: 'Director@JRPromo.test', password: DEMO_PASSWORD })).status, 200);
  await again.close();
});

test('geotags are stored on activation reports, handovers and photos', async () => {
  const campaign = await id("SELECT id FROM campaigns WHERE name = 'Sunfresh Summer Tastings'");
  const cups = await id("SELECT id FROM products WHERE sku = 'SFJ-CUP-50'");
  const sandton = { lat: -26.1086, lng: 28.0527, accuracy: 11.6 };

  const bad = await call('nomsa', 'POST', '/usage', { campaign_id: campaign, items: [{ product_id: cups, qty_used: 1 }], location: { lat: -126, lng: 28 } });
  assert.equal(bad.status, 400);

  const rep = await call('nomsa', 'POST', '/usage', { campaign_id: campaign, store: 'Sandton City', items: [{ product_id: cups, qty_used: 1 }], location: sandton });
  assert.equal(rep.status, 201, JSON.stringify(rep.data));
  const saved = (await call('lerato', 'GET', '/usage')).data.find((u) => u.id === rep.data.id);
  assert.equal(saved.lat, sandton.lat);
  assert.equal(saved.lng, sandton.lng);
  assert.equal(saved.accuracy, 12, 'accuracy rounded to whole metres');

  // A report without a location is accepted but flagged to the account manager
  await call('nomsa', 'POST', '/usage', { campaign_id: campaign, items: [{ product_id: cups, qty_used: 1 }] });
  const reminders = (await call('lerato', 'GET', '/reminders')).data;
  assert.ok(reminders.some((r) => r.type === 'no_location' && r.title.includes('Nomsa')));

  // Counter collection: handover keeps where it happened
  const kagiso = await id("SELECT id FROM users WHERE email = 'kagiso@jrpromo.test'");
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const req = await call('lerato', 'POST', '/requests', { campaign_id: campaign, promoter_id: kagiso, warehouse_id: jhb, items: [{ product_id: cups, qty: 1 }] });
  const midrand = { lat: -25.9992, lng: 28.1263, accuracy: 20 };
  const issued = await call('warehouse', 'POST', `/requests/${req.data.id}/dispatch`, { handover: { signature: SIG, location: midrand }, scans: scans('SFJ-CUP-50', 1) });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  assert.equal(issued.data.handovers[0].lat, midrand.lat);
  const log = (await call('director', 'GET', '/handovers')).data.find((h) => h.request_id === req.data.id);
  assert.equal(log.lng, midrand.lng);

  // Photos keep the upload location
  const jpeg = `data:image/jpeg;base64,${Buffer.from('geo-photo').toString('base64')}`;
  const up = await call('warehouse', 'POST', '/attachments', { kind: 'receipt', reference: 'GRN-24102', warehouse_id: jhb, data: jpeg, location: midrand });
  assert.equal(up.status, 201);
  const files = (await call('warehouse', 'GET', `/attachments?kind=receipt&reference=GRN-24102&warehouse_id=${jhb}`)).data;
  assert.equal(files[0].lat, midrand.lat);
});

test('warehouse manager role: runs the floor, manages floor staff, nothing above', async () => {
  const house = await id('SELECT id FROM clients WHERE is_house = 1');
  const prod = await call('manager', 'POST', '/products', { sku: 'WM-TEST-1', name: 'Test crate', client_id: house, category: 'Equipment' });
  assert.equal(prod.status, 201, JSON.stringify(prod.data));
  assert.equal((await call('warehouse', 'POST', '/products', { sku: 'WH-X', name: 'x', client_id: house, category: 'Other' })).status, 403);

  const staff = await call('manager', 'POST', '/users', { name: 'New Picker', email: 'picker@jrpromo.test', role: 'warehouse', password: 'longenough1' });
  assert.equal(staff.status, 201, JSON.stringify(staff.data));
  assert.equal((await call('manager', 'POST', '/users', { name: 'X', email: 'x1@jrpromo.test', role: 'director', password: 'longenough1' })).status, 403);
  assert.equal((await call('manager', 'POST', '/users', { name: 'X', email: 'x2@jrpromo.test', role: 'warehouse_manager', password: 'longenough1' })).status, 403);
  const lerato = await id("SELECT id FROM users WHERE email = 'lerato@jrpromo.test'");
  assert.equal((await call('manager', 'PATCH', `/users/${lerato}`, { name: 'Hacked' })).status, 403, 'cannot edit an account manager');
  assert.equal((await call('manager', 'PATCH', `/users/${staff.data.id}`, { role: 'director' })).status, 403, 'cannot promote staff');
  assert.equal((await call('manager', 'PATCH', `/users/${staff.data.id}`, { active: false })).status, 200);
  const nomsa = await id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
  assert.equal((await call('manager', 'POST', `/users/${nomsa}/badge`)).status, 200);
  assert.equal((await call('warehouse', 'POST', '/users', { name: 'X', email: 'x3@jrpromo.test', role: 'promoter', password: 'longenough1' })).status, 403);

  const team = (await call('manager', 'GET', '/users')).data;
  assert.ok(team.every((u) => ['warehouse_manager', 'warehouse', 'promoter'].includes(u.role)));

  // Can dispatch like the floor staff
  assert.ok(Array.isArray((await call('manager', 'GET', '/dashboard')).data.queue));
});

test('blind stock counts: hidden figures, tolerance, manager approval, no self-approval', async () => {
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const sipho = await id("SELECT id FROM users WHERE email = 'warehouse@jrpromo.test'");
  const managerId = await id("SELECT id FROM users WHERE email = 'manager@jrpromo.test'");
  const sku = async (s) => await id('SELECT id FROM products WHERE sku = ?', s);
  const [cooler, flag, gazebo] = [await sku('JR-EQP-COOL'), await sku('JR-SET-FLAG'), await sku('JR-SET-GAZ')];
  await call('manager', 'PUT', '/counts/settings', { tolerance_units: 2 });

  const created = await call('manager', 'POST', '/counts', { warehouse_id: jhb, assigned_to: sipho, product_ids: [cooler, flag, gazebo] });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const cnt = created.data;
  // A product can't be on two open counts in the same warehouse
  assert.equal((await call('manager', 'POST', '/counts', { warehouse_id: jhb, assigned_to: sipho, product_ids: [cooler] })).status, 409);

  // Sipho sees the count, but not the system quantities or costs
  const blind = (await call('warehouse', 'GET', `/counts/${cnt.id}`)).data;
  assert.ok(blind.items.every((l) => !('system_qty' in l) && !('variance' in l) && !('unit_cost' in l)));
  // Other floor staff can't see someone else's count
  assert.equal((await call('ashwin', 'GET', `/counts/${cnt.id}`)).status, 404);

  const before = { cooler: await qty('JR-EQP-COOL', 'JHB Main'), flag: await qty('JR-SET-FLAG', 'JHB Main'), gazebo: await qty('JR-SET-GAZ', 'JHB Main') };
  const line = (pid) => cnt.items.find((l) => l.product_id === pid).id;
  await call('warehouse', 'PUT', `/counts/${cnt.id}/lines`, { lines: [{ id: line(cooler), counted_qty: before.cooler }] });
  assert.equal((await call('warehouse', 'POST', `/counts/${cnt.id}/submit`)).status, 400, 'every line must be counted');
  await call('warehouse', 'PUT', `/counts/${cnt.id}/lines`, {
    lines: [
      { id: line(flag), counted_qty: before.flag - 1 }, // small: auto-adjusted
      { id: line(gazebo), counted_qty: before.gazebo - 3 }, // more than 2 units out: needs approval
    ],
  });
  const submitted = (await call('warehouse', 'POST', `/counts/${cnt.id}/submit`)).data;
  const st = (pid) => submitted.items.find((l) => l.product_id === pid);
  assert.equal(st(cooler).status, 'matched');
  assert.equal(st(flag).status, 'auto');
  assert.equal(st(gazebo).status, 'pending');
  assert.equal(st(gazebo).variance, -3);
  assert.equal(await qty('JR-SET-FLAG', 'JHB Main'), before.flag - 1, 'auto-adjusted');
  assert.equal(await qty('JR-SET-GAZ', 'JHB Main'), before.gazebo, 'big difference waits for approval');
  assert.equal(submitted.status, 'submitted');
  assert.equal((await call('warehouse', 'PUT', `/counts/${cnt.id}/lines`, { lines: [] })).status, 409, 'locked after submit');

  // Staff can't approve; manager sees it in reminders and must give a reason to reject
  assert.equal((await call('warehouse', 'POST', `/counts/${cnt.id}/decide`, { decisions: [{ line_id: st(gazebo).id, approve: true }] })).status, 403);
  assert.ok((await call('manager', 'GET', '/reminders')).data.some((r) => r.type === 'count_approval' && r.title.includes(cnt.ref)));
  assert.equal((await call('manager', 'POST', `/counts/${cnt.id}/decide`, { decisions: [{ line_id: st(gazebo).id, approve: false }] })).status, 400);
  const decided = (await call('manager', 'POST', `/counts/${cnt.id}/decide`, { decisions: [{ line_id: st(gazebo).id, approve: true }] })).data;
  assert.equal(decided.status, 'closed');
  assert.equal(await qty('JR-SET-GAZ', 'JHB Main'), before.gazebo - 3);
  const adj = (await db.get("SELECT note, user_id FROM movements WHERE reference = ? AND product_id = ?", cnt.ref, gazebo));
  assert.match(adj.note, /Counted by Sipho Nkosi, approved by Bongani Mthembu/);
  assert.equal(adj.user_id, managerId);

  // A manager can't approve their own count; a director can
  const own = (await call('manager', 'POST', '/counts', { warehouse_id: jhb, assigned_to: managerId, product_ids: [gazebo] })).data;
  await call('manager', 'PUT', `/counts/${own.id}/lines`, { lines: [{ id: own.items[0].id, counted_qty: await qty('JR-SET-GAZ', 'JHB Main') + 3 }] });
  const ownSub = (await call('manager', 'POST', `/counts/${own.id}/submit`)).data;
  assert.equal(ownSub.can_decide, false);
  assert.equal((await call('manager', 'POST', `/counts/${own.id}/decide`, { decisions: [{ line_id: own.items[0].id, approve: true }] })).status, 403);
  assert.equal((await call('director', 'POST', `/counts/${own.id}/decide`, { decisions: [{ line_id: own.items[0].id, approve: false, note: 'Recheck' }] })).status, 200);

  // Shrinkage report shows the approved loss against Sipho's counting
  const report = (await call('manager', 'GET', '/reports/shrinkage')).data;
  const gz = report.by_product.find((p) => p.sku === 'JR-SET-GAZ');
  assert.ok(gz.missing >= 3);
  assert.ok(report.totals.missing >= 3);
  assert.ok(!JSON.stringify(report).includes('value'), 'shrinkage is reported in units only');
  const siphoRow = report.by_counter.find((r) => r.name === 'Sipho Nkosi');
  assert.ok(siphoRow.differences >= 2);
  assert.equal((await call('warehouse', 'GET', '/reports/shrinkage')).status, 403);
});

test('cycle counts pick the longest-uncounted stock and support recounts', async () => {
  const dbn = await id("SELECT id FROM warehouses WHERE name = 'Durban'");
  const ashwin = await id("SELECT id FROM users WHERE email = 'ashwin@jrpromo.test'");
  const managerId = await id("SELECT id FROM users WHERE email = 'manager@jrpromo.test'");
  const cyc = await call('manager', 'POST', '/counts/cycle', { warehouse_id: dbn, assigned_to: ashwin, lines: 5 });
  assert.equal(cyc.status, 201, JSON.stringify(cyc.data));
  assert.equal(cyc.data.kind, 'cycle');
  assert.ok(cyc.data.items.length > 0 && cyc.data.items.length <= 5);
  // Seeded open Durban count already holds these, so the cycle count must skip them
  const onOpen = (await db.all(`SELECT l.product_id FROM count_lines l JOIN stock_counts sc ON sc.id = l.count_id
    WHERE sc.status = 'open' AND sc.warehouse_id = ? AND sc.id != ?`, dbn, cyc.data.id)).map((r) => r.product_id);
  assert.ok(cyc.data.items.every((l) => !onOpen.includes(l.product_id)));

  const lines = await Promise.all(cyc.data.items.map(async (l, i) => ({ id: l.id, counted_qty: await qty((await db.get('SELECT sku FROM products WHERE id = ?', l.product_id)).sku, 'Durban') + (i === 0 ? 50 : 0) })));
  await call('ashwin', 'PUT', `/counts/${cyc.data.id}/lines`, { lines });
  const sub = (await call('ashwin', 'POST', `/counts/${cyc.data.id}/submit`)).data;
  const pending = sub.items.filter((l) => l.status === 'pending');
  assert.equal(pending.length, 1);
  const re = await call('manager', 'POST', `/counts/${cyc.data.id}/recount`, { line_ids: [pending[0].id], assigned_to: managerId });
  assert.equal(re.status, 201, JSON.stringify(re.data));
  assert.equal(re.data.items[0].product_id, pending[0].product_id);
  assert.equal((await call('manager', 'GET', `/counts/${cyc.data.id}`)).data.status, 'closed');
});

test('campaign shelf colours and product shelf tags', async () => {
  const colours = (await call('warehouse', 'GET', '/campaigns/colours')).data;
  assert.ok(colours.length >= 10 && colours.every((c) => c.key && c.name && /^#[0-9a-f]{6}$/i.test(c.hex)));

  const juice = await id("SELECT id FROM clients WHERE name = 'Sunfresh Juices'");
  // A new campaign with no colour gets the least-used one; an unknown colour is refused
  const auto = await call('lerato', 'POST', '/campaigns', { name: 'Colour test', client_id: juice });
  assert.equal(auto.status, 201, JSON.stringify(auto.data));
  const used = (await db.all("SELECT colour FROM campaigns WHERE status IN ('planned','active') AND id != ?", auto.data.id)).map((r) => r.colour);
  assert.ok(colours.map((c) => c.key).includes(auto.data.colour));
  assert.ok(!used.includes(auto.data.colour), 'picked a colour no running campaign uses');
  assert.equal((await call('lerato', 'POST', '/campaigns', { name: 'Bad', client_id: juice, colour: 'tartan' })).status, 400);

  // Receiving for a campaign tags the products with its shelf colour
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const pullup = await id("SELECT id FROM products WHERE sku = 'SFJ-PUB-85'");
  const rec = await call('warehouse', 'POST', '/stock/receive', { warehouse_id: jhb, reference: 'GRN-COL-1', campaign_id: auto.data.id, items: [{ product_id: pullup, qty: 1 }] });
  assert.equal(rec.status, 201, JSON.stringify(rec.data));
  const product = (await call('warehouse', 'GET', `/products/${pullup}`)).data;
  assert.equal(product.shelf_colour, auto.data.colour);
  assert.equal(product.shelf_campaign, 'Colour test');
  const filtered = (await call('warehouse', 'GET', `/products?campaign_id=${auto.data.id}`)).data;
  assert.deepEqual(filtered.map((p) => p.sku), ['SFJ-PUB-85']);
  assert.ok((await call('lerato', 'GET', `/campaigns/${auto.data.id}`)).data.shelved.some((x) => x.sku === 'SFJ-PUB-85'));

  // Another client's campaign can't be used as a shelf tag
  const mobile = await id("SELECT id FROM campaigns WHERE name = 'Ubuntu Mobile Taxi Rank Drive'");
  assert.equal((await call('warehouse', 'POST', '/stock/receive', { warehouse_id: jhb, reference: 'GRN-COL-2', campaign_id: mobile, items: [{ product_id: pullup, qty: 1 }] })).status, 400);

  // Request lines carry the shelf colour for pickers; campaign signs scan
  assert.equal((await call('warehouse', 'GET', `/scan?code=JRC:${auto.data.id}`)).data.kind, 'campaign');
  const cats = (await call('warehouse', 'GET', '/products/categories')).data;
  for (const c of ['Gazebo', 'Backwall Banner', 'Pull-up Banner']) assert.ok(cats.includes(c));
});

test('setups: book, load out, set up, strike down, check back in', async () => {
  const campaign = await id("SELECT id FROM campaigns WHERE name = 'Protea Mall Sampling'");
  const cpt = await id("SELECT id FROM warehouses WHERE name = 'Cape Town'");
  const liam = await id("SELECT id FROM users WHERE email = 'liam@jrpromo.test'");
  const charlene = await id("SELECT id FROM users WHERE email = 'charlene@jrpromo.test'");
  const sku = async (s) => await id('SELECT id FROM products WHERE sku = ?', s);
  const [table, pullup, gazebo] = [await sku('JR-TBL-FOLD'), await sku('PRS-PUB-85'), await sku('JR-SET-GAZ')];
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const body = {
    campaign_id: campaign, warehouse_id: cpt, venue: 'Canal Walk centre court', address: 'Century City', setup_at: `${day(1)}T07:00`,
    strike_at: `${day(2)}T18:00`, lead_id: liam, crew_ids: [charlene], items: [{ product_id: table, qty: 1 }, { product_id: pullup, qty: 2 }, { product_id: gazebo, qty: 5 }],
  };

  // Strike can't be before setup; only planners can book; other clients' products refused
  assert.equal((await call('pieter', 'POST', '/setups', { ...body, strike_at: `${day(0)}T06:00` })).status, 400);
  assert.equal((await call('warehouse', 'POST', '/setups', body)).status, 403);
  assert.equal((await call('pieter', 'POST', '/setups', { ...body, items: [{ product_id: await sku('SFJ-PUB-85'), qty: 1 }] })).status, 400);
  assert.equal((await call('lerato', 'POST', '/setups', body)).status, 404, 'not her campaign');

  const created = await call('pieter', 'POST', '/setups', body);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const s = created.data;
  assert.equal(s.status, 'scheduled');
  assert.equal(s.crew[0].name, 'Charlene Adams');
  // Crew lead sees it; another promoter doesn't
  assert.equal((await call('nomsa', 'GET', `/setups/${s.id}`)).status, 404);

  const before = { table: await qty('JR-TBL-FOLD', 'Cape Town'), pullup: await qty('PRS-PUB-85', 'Cape Town') };
  // Reminder to load out (setup is tomorrow)
  assert.ok((await call('warehouse', 'GET', '/reminders')).data.some((r) => r.type === 'setup_load' && r.title.includes(s.ref)));

  const loaded = await call('warehouse', 'POST', `/setups/${s.id}/load`);
  assert.equal(loaded.status, 409, 'Cape Town only has 2 JR gazebos, so loading is refused');
  assert.equal(await qty('JR-TBL-FOLD', 'Cape Town'), before.table, 'nothing moved');
  // Fix the equipment list and load again
  const edited = await call('pieter', 'PUT', `/setups/${s.id}`, { ...body, items: [{ product_id: table, qty: 1 }, { product_id: pullup, qty: 2 }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const out = (await call('manager', 'POST', `/setups/${s.id}/load`, { scans: scans('JR-TBL-FOLD', 1, 'PRS-PUB-85', 2) })).data;
  assert.equal(out.status, 'loaded');
  assert.equal(await qty('PRS-PUB-85', 'Cape Town'), before.pullup - 2);
  const held = (await db.get('SELECT qty FROM field_stock WHERE product_id = ? AND promoter_id = ? AND campaign_id = ?', pullup, liam, campaign));
  assert.equal(held.qty, 2, 'held against the crew lead');
  assert.equal((await call('pieter', 'PUT', `/setups/${s.id}`, body)).status, 409, 'locked once loaded');

  const site = { lat: -33.8935, lng: 18.5115, accuracy: 10 };
  const up = (await call('liam', 'POST', `/setups/${s.id}/set-up`, { location: site })).data;
  assert.equal(up.status, 'set_up');
  assert.equal(up.set_up_lat, site.lat);
  const jpeg = `data:image/jpeg;base64,${Buffer.from('setup-photo').toString('base64')}`;
  assert.equal((await call('liam', 'POST', '/attachments', { kind: 'setup', setup_id: s.id, data: jpeg, location: site })).status, 201);
  assert.equal((await call('nomsa', 'POST', '/attachments', { kind: 'setup', setup_id: s.id, data: jpeg })).status, 404);

  assert.equal((await call('liam', 'POST', `/setups/${s.id}/strike`, { location: site })).data.status, 'struck');
  assert.equal((await call('liam', 'POST', `/setups/${s.id}/return`, {})).status, 403, 'only the warehouse checks equipment in');
  const pullLine = out.items.find((i) => i.product_id === pullup);
  const back = (await call('warehouse', 'POST', `/setups/${s.id}/return`, { items: [{ id: pullLine.id, qty_good: 1, qty_damaged: 1 }] })).data;
  assert.equal(back.status, 'returned');
  assert.equal(await qty('PRS-PUB-85', 'Cape Town'), before.pullup - 1);
  assert.equal(await qty('JR-TBL-FOLD', 'Cape Town'), before.table, 'table came back by default');
  assert.equal(back.attachments.length, 1);
});

test('packs have their own QR codes and count as many units when scanned out', async () => {
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");
  const cpt = await id("SELECT id FROM warehouses WHERE name = 'Cape Town'");
  const house = await id('SELECT id FROM clients WHERE is_house = 1');

  // Add an item with packs; SKUs can't contain the code separators
  const bad = await call('manager', 'POST', '/products', { sku: 'TST:1', name: 'x', client_id: house, category: 'Sample' });
  assert.equal(bad.status, 400);
  const made = await call('manager', 'POST', '/products', {
    sku: 'tst-can', name: 'Test can 330ml', client_id: house, category: 'Sample',
    packs: [{ qty: 6, name: '6-pack' }, { qty: 24, name: 'Box of 24', barcode: '6009999000024' }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.deepEqual(made.data.packs.map((p) => [p.name, p.qty]), [['6-pack', 6], ['Box of 24', 24]]);
  assert.equal((await call('manager', 'PUT', `/products/${made.data.id}`, { ...made.data, packs: [{ qty: 6 }, { qty: 6 }] })).status, 400);

  // A pack label is read with its readable text (name, pack, expiry) after the '|'
  const hit = (await call('warehouse', 'GET', `/scan?code=${encodeURIComponent('JRK:SFJ-DRK-330:24|Sunfresh Mango 330ml can|Box of 24|EXP 2027-02-01')}`)).data;
  assert.equal(hit.product.sku, 'SFJ-DRK-330');
  assert.equal(hit.units, 24);
  assert.equal(hit.pack.name, 'Box of 24');
  assert.equal((await call('warehouse', 'GET', '/scan?code=JRK:SFJ-DRK-330:12')).status, 404, 'no 12-pack');

  // The seeded counter request: 54 cans and 2 sleeves of cups
  const req = (await db.get(`SELECT r.id FROM requests r JOIN request_items ri ON ri.request_id = r.id JOIN products p ON p.id = ri.product_id
              WHERE p.sku = 'SFJ-DRK-330' AND r.status = 'approved'`));
  const caseBarcode = (await db.get("SELECT pk.barcode FROM product_packs pk JOIN products p ON p.id = pk.product_id WHERE p.sku = 'SFJ-DRK-330' AND pk.qty = 24")).barcode;
  const cansBefore = await qty('SFJ-DRK-330', 'JHB Main');
  const handover = { signature: SIG };
  const unknown = await call('warehouse', 'POST', `/requests/${req.id}/dispatch`, { handover, scans: ['JRP:NOPE'] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /Unknown label/);
  const issued = await call('warehouse', 'POST', `/requests/${req.id}/dispatch`, {
    handover,
    // Box of 24 by QR, another by its supplier barcode, a 6-pack, and the cups one by one
    scans: ['JRK:SFJ-DRK-330:24|Sunfresh Mango 330ml can|Box of 24', caseBarcode, 'JRK:SFJ-DRK-330:6', 'JRP:SFJ-CUP-50', 'JRP:SFJ-CUP-50|Tasting cups'],
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  assert.equal(await qty('SFJ-DRK-330', 'JHB Main'), cansBefore - 54);
  assert.equal(issued.data.scan_check.matched, 1);
  assert.equal(issued.data.scan_check.scanned_units, 56);
  assert.equal(issued.data.scan_check.user_name, 'Sipho Nkosi');
  const logged = (await db.all("SELECT code, units, pack_id FROM scans_out WHERE kind = 'request' AND reference = (SELECT ref FROM requests WHERE id = ?) ORDER BY id", req.id));
  assert.deepEqual(logged.map((l) => l.units), [24, 24, 6, 1, 1]);
  assert.equal(logged[0].code, 'JRK:SFJ-DRK-330:24', 'readable text is not stored as the code');

  // Releasing without a full scan: warehouse manager only, with a reason
  const mug = await id("SELECT id FROM products WHERE sku = 'KCC-GFT-MUG'");
  const move = { from_warehouse_id: jhb, to_warehouse_id: cpt, items: [{ product_id: mug, qty: 5 }] };
  assert.equal((await call('warehouse', 'POST', '/stock/transfer', move)).status, 409);
  assert.equal((await call('warehouse', 'POST', '/stock/transfer', { ...move, scan_override: 'Labels torn' })).status, 403);
  const released = await call('manager', 'POST', '/stock/transfer', { ...move, reference: 'TRF-OVR', scans: scans('KCC-GFT-MUG', 2), scan_override: 'Labels torn' });
  assert.equal(released.status, 201, JSON.stringify(released.data));
  const check = (await db.get("SELECT * FROM scan_checks WHERE kind = 'transfer' AND reference = 'TRF-OVR'"));
  assert.equal(check.matched, 0);
  assert.equal(check.override_reason, 'Labels torn');
  assert.match(check.differences, /KCC-GFT-MUG: scanned 2 of 5/);

  // Removing a pack retires its code
  const kept = await call('manager', 'PUT', `/products/${made.data.id}`, { ...made.data, packs: [{ qty: 24, name: 'Case' }] });
  assert.equal(kept.status, 200, JSON.stringify(kept.data));
  assert.deepEqual(kept.data.packs.map((p) => [p.name, p.qty, p.barcode]), [['Case', 24, null]]);
  assert.equal((await call('warehouse', 'GET', '/scan?code=JRK:TST-CAN:6')).status, 404);
});

test('BA collection/return form: issue condition, private ID numbers, manager check and clearing for payment', async () => {
  const juice = await id("SELECT id FROM campaigns WHERE name = 'Sunfresh Summer Tastings'");
  const sauce = await id("SELECT id FROM campaigns WHERE name = 'Braai Master Heritage Month'");
  const nomsa = await id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
  const cups = await id("SELECT id FROM products WHERE sku = 'SFJ-CUP-50'");
  const jhb = await id("SELECT id FROM warehouses WHERE name = 'JHB Main'");

  // Condition is recorded when stock is handed over
  const req = await call('lerato', 'POST', '/requests', { campaign_id: juice, promoter_id: nomsa, warehouse_id: jhb, items: [{ product_id: cups, qty: 1 }] });
  assert.equal(req.status, 201, JSON.stringify(req.data));
  const bad = await call('warehouse', 'POST', `/requests/${req.data.id}/dispatch`, { handover: { signature: SIG, condition: 'bad' }, scans: scans('SFJ-CUP-50', 1) });
  assert.equal(bad.status, 400);
  const ok = await call('warehouse', 'POST', `/requests/${req.data.id}/dispatch`, { handover: { signature: SIG, condition: 'average' }, scans: scans('SFJ-CUP-50', 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const form = (await call('manager', 'GET', `/baforms/${juice}/${nomsa}`)).data;
  assert.match(form.promoter.id_number, /^\d{13}$/);
  const cupLine = form.lines.find((l) => l.sku === 'SFJ-CUP-50');
  assert.ok(cupLine.issued >= 1);
  assert.equal(cupLine.issued, cupLine.used + cupLine.damaged_in_field + cupLine.returned + cupLine.outstanding, 'every unit is accounted for');
  assert.equal(form.issued_handovers.at(-1).stock_condition, 'average');
  assert.equal(form.issued_handovers.at(-1).staff_name, 'Sipho Nkosi');

  // ID numbers are personal: the promoter and the office see them, the account manager doesn't
  assert.equal((await call('nomsa', 'GET', `/baforms/${juice}/${nomsa}`)).data.promoter.id_number, form.promoter.id_number);
  assert.equal((await call('lerato', 'GET', `/baforms/${juice}/${nomsa}`)).data.promoter.id_number, undefined);
  assert.equal((await call('kagiso', 'GET', `/baforms/${juice}/${nomsa}`)).status, 404, "another promoter's form");
  assert.ok((await call('lerato', 'GET', '/users?role=promoter')).data.every((u) => u.id_number === undefined));

  // Office use: only the warehouse manager / office sign off, and not while stock is still out
  assert.equal((await call('warehouse', 'POST', `/baforms/${juice}/${nomsa}/check`, {})).status, 403);
  const checked = await call('manager', 'POST', `/baforms/${juice}/${nomsa}/check`, { comment: 'Matches the slip' });
  assert.equal(checked.data.clearance.checked_by_name, 'Bongani Mthembu');
  const early = await call('manager', 'POST', `/baforms/${juice}/${nomsa}/clear`, {});
  assert.equal(early.status, 409);
  assert.match(early.data.error, /still has/);

  // The finished campaign: whoever brought everything back is cleared, whoever still holds stock isn't
  const list = (await call('manager', 'GET', `/baforms?campaign_id=${sauce}`)).data;
  assert.ok(list.some((x) => x.outstanding === 0 && x.cleared_at));
  assert.ok(list.some((x) => x.outstanding > 0 && !x.cleared_at));
  assert.equal((await call('nomsa', 'GET', `/baforms?campaign_id=${juice}`)).data.length, 1, 'promoters only see their own');

  // Everything back but not cleared yet: the warehouse manager gets a reminder, and can clear it
  const done = list.find((x) => x.outstanding === 0 && x.cleared_at);
  (await db.run('UPDATE ba_clearances SET cleared_at = NULL, cleared_by = NULL WHERE campaign_id = ? AND promoter_id = ?', sauce, done.promoter_id));
  const reminder = (await call('manager', 'GET', '/reminders')).data.find((x) => x.type === 'ba_clear');
  assert.equal(reminder.link, `baform/${sauce}~${done.promoter_id}`);
  assert.ok(!(await call('warehouse', 'GET', '/reminders')).data.some((x) => x.type === 'ba_clear'), 'floor staff do not clear for payment');
  const cleared = await call('manager', 'POST', `/baforms/${sauce}/${done.promoter_id}/clear`, { comment: 'All back' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.clearance.cleared_by_name, 'Bongani Mthembu');
  assert.equal((await call('manager', 'POST', `/baforms/${sauce}/${done.promoter_id}/clear`, {})).status, 409, 'only once');
});

test('messages: job chats, campaign team, direct messages and the notice board follow access rules', async () => {
  const nomsa = await id("SELECT id FROM users WHERE email = 'promoter@jrpromo.test'");
  const kagiso = await id("SELECT id FROM users WHERE email = 'kagiso@jrpromo.test'");
  const sipho = await id("SELECT id FROM users WHERE email = 'warehouse@jrpromo.test'");
  const req = (await db.get('SELECT id FROM requests WHERE promoter_id = ? ORDER BY id DESC', nomsa));
  const thread = `request:${req.id}`;

  const before = (await call('warehouse', 'GET', '/messages/unread')).data.count;
  assert.equal((await call('nomsa', 'POST', '/messages', { thread, body: 'Is my stock ready?' })).status, 201);
  assert.equal((await call('warehouse', 'GET', '/messages/unread')).data.count, before + 1, 'warehouse sees the new message');
  const opened = (await call('warehouse', 'GET', `/messages/thread?thread=${thread}`)).data;
  assert.equal(opened.messages.at(-1).body, 'Is my stock ready?');
  assert.equal(opened.messages.at(-1).user_name, 'Nomsa Khumalo');
  assert.equal((await call('warehouse', 'GET', '/messages/unread')).data.count, before, 'reading clears it');
  assert.equal((await call('kagiso', 'GET', `/messages/thread?thread=${thread}`)).status, 404, "not Kagiso's request");
  assert.equal((await call('kagiso', 'POST', '/messages', { thread, body: 'hi' })).status, 404);

  // Notice board: everyone reads, managers and office post
  assert.equal((await call('nomsa', 'POST', '/messages', { thread: 'notice', body: 'x' })).status, 403);
  assert.equal((await call('manager', 'POST', '/messages', { thread: 'notice', body: 'Stock take on Friday' })).status, 201);
  assert.equal((await call('kagiso', 'GET', '/messages/thread?thread=notice')).data.messages.at(-1).body, 'Stock take on Friday');

  // Direct messages: promoters message staff, not each other; nobody else can read them
  assert.equal((await call('nomsa', 'POST', '/messages', { to: kagiso, body: 'hey' })).status, 403);
  const dm = await call('nomsa', 'POST', '/messages', { to: sipho, body: 'Running 10 minutes late' });
  assert.equal(dm.status, 201);
  const inbox = (await call('warehouse', 'GET', '/messages/inbox')).data;
  const conv = inbox.find((t) => t.thread === dm.data.thread);
  assert.equal(conv.title, 'Nomsa Khumalo');
  assert.equal(conv.unread, 1);
  assert.equal((await call('lerato', 'GET', `/messages/thread?thread=${dm.data.thread}`)).status, 404);
  assert.ok(!(await call('director', 'GET', '/messages/inbox')).data.some((t) => t.thread === dm.data.thread), 'not even directors read DMs');
  assert.ok((await call('nomsa', 'GET', '/messages/people')).data.every((p) => p.role !== 'promoter'));
});

test('signed sessions work across separate copies of the app (serverless)', async () => {
  process.env.SESSION_SECRET = 'test-secret-for-two-copies';
  const copies = [];
  try {
    // Two servers, each with its own connections to the same database, like two Vercel instances
    for (let i = 0; i < 2; i++) {
      const copyDb = await open(TEST_URL);
      const srv = createApp(copyDb).listen(0);
      srv.on('close', () => copyDb.close());
      await new Promise((r) => srv.once('listening', r));
      copies.push({ srv, url: `http://127.0.0.1:${srv.address().port}` });
    }
    const login = await fetch(`${copies[0].url}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'manager@jrpromo.test', password: DEMO_PASSWORD }),
    }).then((r) => r.json());
    // Signed in on copy 1, the token works on copy 2, by header and by cookie
    const byHeader = await fetch(`${copies[1].url}/api/auth/me`, { headers: { Authorization: `Bearer ${login.token}` } });
    assert.equal(byHeader.status, 200);
    assert.equal((await byHeader.json()).name, 'Bongani Mthembu');
    const byCookie = await fetch(`${copies[1].url}/api/dashboard`, { headers: { Cookie: `jr_session=${login.token}` } });
    assert.equal(byCookie.status, 200);
    // Tampering with the user id or signature is rejected
    const [, exp, mac] = login.token.split('.');
    assert.equal((await fetch(`${copies[1].url}/api/auth/me`, { headers: { Authorization: `Bearer 1.${exp}.${mac}` } })).status, 401);
    assert.equal((await fetch(`${copies[1].url}/api/auth/me`, { headers: { Authorization: `Bearer ${login.token.slice(0, -2)}00` } })).status, 401);
  } finally {
    delete process.env.SESSION_SECRET;
    copies.forEach((c) => c.srv.close());
  }
});

// Runs last so it checks the ledger after every other test has moved stock
test('ledger reconciles with stock tables for every product', async () => {
  const rows = (await db.all(`SELECT p.sku,
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
       FROM products p LEFT JOIN movements m ON m.product_id = p.id GROUP BY p.id`));
  for (const r of rows) {
    assert.equal(r.on_hand, r.ledger_on_hand, `warehouse stock for ${r.sku}`);
    assert.equal(r.in_field, r.ledger_field, `field stock for ${r.sku}`);
    assert.equal(r.in_laundry, r.ledger_laundry, `laundry for ${r.sku}`);
    if (r.tracks_expiry) assert.equal(r.batched, r.on_hand, `batches add up for ${r.sku}`);
  }
});
