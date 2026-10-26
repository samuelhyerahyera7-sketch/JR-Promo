'use strict';

/**
 * Demo data: fictional clients and staff so the system can be explored
 * straight away. All brand and person names are made up.
 */

const path = require('node:path');
const { hashPassword } = require('./auth');
const { tx } = require('./db');
const stock = require('./stock');

const DEMO_PASSWORD = 'password123';

function seed(db) {
  tx(db, () => {
    const hash = hashPassword(DEMO_PASSWORD);
    const ins = (sql, ...params) => db.prepare(sql).run(...params).lastInsertRowid;

    const wh = {
      jhb: ins("INSERT INTO warehouses (name, city, province, address) VALUES ('JHB Main', 'Midrand', 'Gauteng', '14 Allandale Rd, Midrand')"),
      cpt: ins("INSERT INTO warehouses (name, city, province, address) VALUES ('Cape Town', 'Montague Gardens', 'Western Cape', '7 Marconi Rd, Montague Gardens')"),
      dbn: ins("INSERT INTO warehouses (name, city, province, address) VALUES ('Durban', 'Pinetown', 'KwaZulu-Natal', '22 Old Main Rd, Pinetown')"),
    };

    const user = (name, email, role, region, phone, warehouseId = null) =>
      ins(
        'INSERT INTO users (name, email, phone, role, region, warehouse_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
        name, email, phone, role, region, warehouseId, hash,
      );

    const u = {
      director: user('Rina Jansen', 'director@jrpromo.test', 'director', 'Gauteng', '082 555 0101'),
      office: user('Thandi Mokoena', 'office@jrpromo.test', 'office', 'Gauteng', '082 555 0102'),
      am1: user('Lerato Dlamini', 'lerato@jrpromo.test', 'account_manager', 'Gauteng', '083 555 0201'),
      am2: user('Pieter van Wyk', 'pieter@jrpromo.test', 'account_manager', 'Western Cape', '083 555 0202'),
      whJhb: user('Sipho Nkosi', 'warehouse@jrpromo.test', 'warehouse', 'Gauteng', '084 555 0301', wh.jhb),
      whCpt: user('Charlene Adams', 'charlene@jrpromo.test', 'warehouse', 'Western Cape', '084 555 0302', wh.cpt),
      whDbn: user('Ashwin Naidoo', 'ashwin@jrpromo.test', 'warehouse', 'KwaZulu-Natal', '084 555 0303', wh.dbn),
      p1: user('Nomsa Khumalo', 'promoter@jrpromo.test', 'promoter', 'Gauteng', '071 555 0401'),
      p2: user('Kagiso Molefe', 'kagiso@jrpromo.test', 'promoter', 'Gauteng', '071 555 0402'),
      p3: user('Zanele Ndlovu', 'zanele@jrpromo.test', 'promoter', 'KwaZulu-Natal', '071 555 0403'),
      p4: user('Liam Petersen', 'liam@jrpromo.test', 'promoter', 'Western Cape', '071 555 0404'),
      p5: user('Ayanda Zulu', 'ayanda@jrpromo.test', 'promoter', 'KwaZulu-Natal', '071 555 0405'),
    };

    const client = (name, contact, email, am) =>
      ins('INSERT INTO clients (name, contact_name, contact_email, account_manager_id) VALUES (?, ?, ?, ?)', name, contact, email, am);
    const cl = {
      juice: client('Sunfresh Juices', 'Megan Botha', 'megan@sunfresh.test', u.am1),
      coffee: client('Kalahari Coffee Co.', 'David Mahlangu', 'david@kalaharicoffee.test', u.am1),
      mobile: client('Ubuntu Mobile', 'Priya Govender', 'priya@ubuntumobile.test', u.am2),
      skin: client('Protea Skincare', 'Anel du Plessis', 'anel@proteaskin.test', u.am2),
      sauce: client('Braai Master Sauces', 'Johan Kruger', 'johan@braaimaster.test', u.am1),
    };

    const product = (sku, name, clientId, category, unitCost, reorder, unit = 'unit') =>
      ins(
        'INSERT INTO products (sku, name, client_id, category, unit, unit_cost, reorder_level, barcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        sku, name, clientId, category, unit, unitCost, reorder, `600${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`,
      );
    const p = {
      juiceSample: product('SFJ-SMP-200', 'Sunfresh Mango 200ml sample', cl.juice, 'Sample', 4.5, 1500),
      juiceCup: product('SFJ-CUP-50', 'Tasting cups (sleeve of 50)', cl.juice, 'Sample', 18, 60, 'sleeve'),
      juiceAframe: product('SFJ-POS-AFR', 'Sunfresh A-frame board', cl.juice, 'POS Material', 650, 6),
      juiceTee: product('SFJ-UNI-TEE', 'Sunfresh promoter T-shirt', cl.juice, 'Uniform', 85, 20),
      coffeeSachet: product('KCC-SMP-SCH', 'Kalahari instant sachet', cl.coffee, 'Sample', 2.2, 3000),
      coffeeMug: product('KCC-GFT-MUG', 'Branded enamel mug', cl.coffee, 'Giveaway', 42, 150),
      coffeeUrn: product('KCC-EQP-URN', 'Hot water urn 20L', cl.coffee, 'Equipment', 1450, 2),
      coffeeWobbler: product('KCC-POS-WOB', 'Shelf wobbler', cl.coffee, 'POS Material', 6.5, 400),
      mobileSim: product('UBM-SIM-STK', 'Starter pack SIM', cl.mobile, 'Merchandise', 1.8, 2000),
      mobileGazebo: product('UBM-EQP-GAZ', 'Branded 3x3m gazebo', cl.mobile, 'Equipment', 4200, 3),
      mobileCap: product('UBM-GFT-CAP', 'Ubuntu Mobile cap', cl.mobile, 'Giveaway', 38, 200),
      mobileFlyer: product('UBM-POS-FLY', 'A5 data bundle flyer', cl.mobile, 'POS Material', 0.9, 5000),
      skinTester: product('PRS-SMP-TST', 'Protea day cream tester 5ml', cl.skin, 'Sample', 7.5, 800),
      skinBag: product('PRS-GFT-BAG', 'Protea cotton tote bag', cl.skin, 'Giveaway', 29, 250),
      skinStand: product('PRS-POS-STD', 'Counter display stand', cl.skin, 'POS Material', 320, 8),
      sauceSachet: product('BMS-SMP-SCH', 'Braai sauce 20ml sachet', cl.sauce, 'Sample', 1.6, 2500),
      sauceApron: product('BMS-GFT-APR', 'Braai Master apron', cl.sauce, 'Giveaway', 95, 60),
      sauceTable: product('BMS-EQP-TBL', 'Folding tasting table', cl.sauce, 'Equipment', 890, 4),
    };

    // Back-date the ledger so the dashboard has a history to show
    const stamp = (daysAgo, hour = 9) => {
      const d = new Date(Date.now() - daysAgo * 864e5);
      d.setUTCHours(hour, Math.floor(Math.random() * 60), 0, 0);
      return d.toISOString().replace('T', ' ').slice(0, 19);
    };
    let lastMovement = 0;
    const dated = (daysAgo, fn) => {
      fn();
      db.prepare('UPDATE movements SET created_at = ? WHERE id > ?').run(stamp(daysAgo, 8 + Math.floor(Math.random() * 8)), lastMovement);
      lastMovement = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM movements').get().n;
    };

    const receive = (daysAgo, warehouseId, ref, lines, userId) =>
      dated(daysAgo, () => {
        for (const [productId, qty] of lines) stock.receive(db, { productId, warehouseId, qty, reference: ref, userId });
      });

    receive(28, wh.jhb, 'GRN-24101', [[p.juiceSample, 6000], [p.juiceCup, 200], [p.juiceAframe, 12], [p.juiceTee, 60]], u.whJhb);
    receive(27, wh.jhb, 'GRN-24102', [[p.coffeeSachet, 10000], [p.coffeeMug, 400], [p.coffeeUrn, 6], [p.coffeeWobbler, 1200]], u.whJhb);
    receive(26, wh.cpt, 'GRN-24103', [[p.mobileSim, 8000], [p.mobileGazebo, 6], [p.mobileCap, 600], [p.mobileFlyer, 20000]], u.whCpt);
    receive(25, wh.cpt, 'GRN-24104', [[p.skinTester, 3000], [p.skinBag, 500], [p.skinStand, 20]], u.whCpt);
    receive(24, wh.dbn, 'GRN-24105', [[p.sauceSachet, 9000], [p.sauceApron, 120], [p.sauceTable, 8]], u.whDbn);
    receive(20, wh.jhb, 'GRN-24110', [[p.sauceSachet, 4000], [p.sauceApron, 80], [p.skinTester, 1200]], u.whJhb);
    dated(18, () => {
      stock.transfer(db, { productId: p.mobileCap, fromWarehouseId: wh.cpt, toWarehouseId: wh.jhb, qty: 200, reference: 'TRF-0001', userId: u.whCpt });
      stock.transfer(db, { productId: p.mobileSim, fromWarehouseId: wh.cpt, toWarehouseId: wh.dbn, qty: 2500, reference: 'TRF-0001', userId: u.whCpt });
    });

    const campaign = (name, clientId, am, region, start, end, status, promoters) => {
      const id = ins(
        'INSERT INTO campaigns (name, client_id, account_manager_id, region, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        name, clientId, am, region, start, end, status,
      );
      for (const pid of promoters) ins('INSERT INTO campaign_promoters (campaign_id, promoter_id) VALUES (?, ?)', id, pid);
      return id;
    };
    const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
    const c = {
      juice: campaign('Sunfresh Summer Tastings', cl.juice, u.am1, 'Gauteng', day(-21), day(30), 'active', [u.p1, u.p2]),
      coffee: campaign('Kalahari Morning Commute', cl.coffee, u.am1, 'Gauteng', day(-14), day(14), 'active', [u.p2]),
      mobile: campaign('Ubuntu Mobile Taxi Rank Drive', cl.mobile, u.am2, 'KwaZulu-Natal', day(-15), day(45), 'active', [u.p3, u.p5]),
      skin: campaign('Protea Mall Sampling', cl.skin, u.am2, 'Western Cape', day(-10), day(20), 'active', [u.p4]),
      sauce: campaign('Braai Master Heritage Month', cl.sauce, u.am1, 'KwaZulu-Natal', day(-40), day(-3), 'completed', [u.p3, u.p5]),
      juiceDbn: campaign('Sunfresh Durban Launch', cl.juice, u.am1, 'KwaZulu-Natal', day(10), day(40), 'planned', [u.p5]),
    };

    let reqNo = 0;
    const request = ({ campaignId, warehouseId, promoterId, by, lines, status, daysAgo, approver, dispatcher, method = 'collect', waybill = null, neededIn = 3 }) => {
      reqNo += 1;
      const ref = `REQ-${String(reqNo).padStart(5, '0')}`;
      const approved = status !== 'pending' && status !== 'rejected';
      const id = ins(
        `INSERT INTO requests (ref, campaign_id, warehouse_id, promoter_id, requested_by, status, needed_by, delivery_method,
           courier, waybill, approved_by, approved_at, dispatched_by, dispatched_at, delivered_at, created_at, decision_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ref, campaignId, warehouseId, promoterId, by, status, day(-daysAgo + neededIn), method,
        waybill ? 'The Courier Guy' : null, waybill,
        status === 'pending' ? null : approver, status === 'pending' ? null : stamp(daysAgo, 11),
        ['dispatched', 'delivered'].includes(status) ? dispatcher : null,
        ['dispatched', 'delivered'].includes(status) ? stamp(daysAgo - 1, 10) : null,
        status === 'delivered' ? stamp(daysAgo - 2, 14) : null,
        stamp(daysAgo, 8),
        status === 'rejected' ? 'Please use remaining stock from last week first' : null,
      );
      for (const [productId, qty] of lines) {
        const dispatched = ['dispatched', 'delivered'].includes(status);
        ins(
          'INSERT INTO request_items (request_id, product_id, qty_requested, qty_approved, qty_dispatched) VALUES (?, ?, ?, ?, ?)',
          id, productId, qty, approved ? qty : null, dispatched ? qty : null,
        );
        if (dispatched) {
          dated(daysAgo - 1, () =>
            stock.dispatch(db, { productId, warehouseId, promoterId, campaignId, qty, reference: ref, userId: dispatcher }),
          );
        }
      }
      return ref;
    };

    request({ campaignId: c.sauce, warehouseId: wh.dbn, promoterId: u.p3, by: u.p3, approver: u.am1, dispatcher: u.whDbn, status: 'delivered', daysAgo: 22,
      lines: [[p.sauceSachet, 3000], [p.sauceApron, 40], [p.sauceTable, 2]] });
    request({ campaignId: c.sauce, warehouseId: wh.dbn, promoterId: u.p5, by: u.am1, approver: u.am1, dispatcher: u.whDbn, status: 'delivered', daysAgo: 21,
      lines: [[p.sauceSachet, 2500], [p.sauceApron, 30], [p.sauceTable, 1]] });
    request({ campaignId: c.juice, warehouseId: wh.jhb, promoterId: u.p1, by: u.p1, approver: u.am1, dispatcher: u.whJhb, status: 'delivered', daysAgo: 19,
      lines: [[p.juiceSample, 2000], [p.juiceCup, 60], [p.juiceAframe, 2], [p.juiceTee, 4]] });
    request({ campaignId: c.juice, warehouseId: wh.jhb, promoterId: u.p2, by: u.p2, approver: u.am1, dispatcher: u.whJhb, status: 'delivered', daysAgo: 18,
      lines: [[p.juiceSample, 1800], [p.juiceCup, 50], [p.juiceAframe, 2], [p.juiceTee, 4]] });
    request({ campaignId: c.mobile, warehouseId: wh.dbn, promoterId: u.p3, by: u.p3, approver: u.am2, dispatcher: u.whDbn, status: 'delivered', daysAgo: 14,
      method: 'courier', waybill: 'TCG84412093', lines: [[p.mobileSim, 1500]] });
    request({ campaignId: c.mobile, warehouseId: wh.cpt, promoterId: u.p5, by: u.p5, approver: u.am2, dispatcher: u.whCpt, status: 'delivered', daysAgo: 13,
      method: 'courier', waybill: 'TCG84412871', lines: [[p.mobileGazebo, 1], [p.mobileCap, 150], [p.mobileFlyer, 5000]] });
    request({ campaignId: c.coffee, warehouseId: wh.jhb, promoterId: u.p2, by: u.am1, approver: u.am1, dispatcher: u.whJhb, status: 'delivered', daysAgo: 12,
      lines: [[p.coffeeSachet, 4000], [p.coffeeMug, 120], [p.coffeeUrn, 1], [p.coffeeWobbler, 300]] });
    request({ campaignId: c.skin, warehouseId: wh.cpt, promoterId: u.p4, by: u.p4, approver: u.am2, dispatcher: u.whCpt, status: 'delivered', daysAgo: 9,
      lines: [[p.skinTester, 1200], [p.skinBag, 200], [p.skinStand, 2]] });
    request({ campaignId: c.juice, warehouseId: wh.jhb, promoterId: u.p1, by: u.p1, approver: u.am1, dispatcher: u.whJhb, status: 'dispatched', daysAgo: 3,
      method: 'courier', waybill: 'TCG84419920', lines: [[p.juiceSample, 1600], [p.juiceCup, 40]] });
    request({ campaignId: c.coffee, warehouseId: wh.jhb, promoterId: u.p2, by: u.p2, approver: u.am1, status: 'approved', daysAgo: 1,
      lines: [[p.coffeeSachet, 3000], [p.coffeeMug, 100], [p.coffeeWobbler, 400]] });
    request({ campaignId: c.mobile, warehouseId: wh.dbn, promoterId: u.p5, by: u.p5, approver: u.am2, status: 'picking', daysAgo: 1,
      lines: [[p.mobileSim, 800]] });
    request({ campaignId: c.skin, warehouseId: wh.cpt, promoterId: u.p4, by: u.p4, status: 'pending', daysAgo: 0,
      lines: [[p.skinTester, 900], [p.skinBag, 150]] });
    request({ campaignId: c.juice, warehouseId: wh.jhb, promoterId: u.p2, by: u.p2, status: 'pending', daysAgo: 0,
      lines: [[p.juiceSample, 1500], [p.juiceTee, 2]] });
    request({ campaignId: c.mobile, warehouseId: wh.cpt, promoterId: u.p3, by: u.p3, approver: u.am2, status: 'rejected', daysAgo: 5,
      lines: [[p.mobileCap, 300]] });

    // Promoter activation reports
    let useNo = 0;
    const usage = (daysAgo, campaignId, promoterId, store, lines) => {
      const id = ins(
        'INSERT INTO usage_reports (campaign_id, promoter_id, report_date, store, created_at) VALUES (?, ?, ?, ?, ?)',
        campaignId, promoterId, day(-daysAgo), store, stamp(daysAgo, 17),
      );
      useNo = id;
      dated(daysAgo, () => {
        for (const [productId, used, damaged = 0] of lines) {
          stock.consume(db, { productId, promoterId, campaignId, qtyUsed: used, qtyDamaged: damaged, reference: `USE-${String(useNo).padStart(5, '0')}`, userId: promoterId });
          ins('INSERT INTO usage_items (report_id, product_id, qty_used, qty_damaged) VALUES (?, ?, ?, ?)', id, productId, used, damaged);
        }
      });
    };
    const stores = {
      gp: ['Checkers Hyper Sandton City', 'Pick n Pay Rosebank', 'Spar Fourways Crossing', 'Woolworths Menlyn', 'Shoprite Soweto Maponya Mall'],
      kzn: ['Pick n Pay Gateway Umhlanga', 'Spar Pinetown', 'Checkers Pavilion', 'Warwick Junction taxi rank', 'Shoprite Durban Station'],
      wc: ['Clicks Canal Walk', 'Dis-Chem V&A Waterfront', 'Clicks Tyger Valley', 'Woolworths Cavendish'],
    };
    for (let d = 17; d >= 1; d -= 2) {
      usage(d, c.juice, u.p1, stores.gp[d % 5], [[p.juiceSample, 160 + (d % 4) * 20], [p.juiceCup, 4]]);
      usage(d, c.juice, u.p2, stores.gp[(d + 2) % 5], [[p.juiceSample, 140 + (d % 3) * 25], [p.juiceCup, 4, d === 9 ? 1 : 0]]);
    }
    for (let d = 11; d >= 1; d -= 1) usage(d, c.coffee, u.p2, `Park Station concourse`, [[p.coffeeSachet, 280 + (d % 5) * 15], [p.coffeeMug, 8]]);
    for (let d = 12; d >= 2; d -= 2) {
      usage(d, c.mobile, u.p3, stores.kzn[d % 5], [[p.mobileSim, 110 + (d % 3) * 10]]);
      usage(d, c.mobile, u.p5, stores.kzn[(d + 1) % 5], [[p.mobileCap, 12], [p.mobileFlyer, 400]]);
    }
    for (let d = 8; d >= 1; d -= 1) usage(d, c.skin, u.p4, stores.wc[d % 4], [[p.skinTester, 120 + (d % 4) * 10], [p.skinBag, 20]]);
    for (let d = 20; d >= 4; d -= 2) {
      usage(d, c.sauce, u.p3, stores.kzn[d % 5], [[p.sauceSachet, 300], [p.sauceApron, 4]]);
      usage(d, c.sauce, u.p5, stores.kzn[(d + 3) % 5], [[p.sauceSachet, 260], [p.sauceApron, 3]]);
    }

    // Completed campaign: leftover stock coming back
    const ret = (ref, campaignId, promoterId, warehouseId, lines, received, daysAgo) => {
      const id = ins(
        `INSERT INTO returns (ref, campaign_id, promoter_id, warehouse_id, status, received_by, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ref, campaignId, promoterId, warehouseId, received ? 'received' : 'pending',
        received ? u.whDbn : null, received ? stamp(daysAgo, 12) : null, stamp(daysAgo + 1, 9),
      );
      for (const [productId, qty, damaged = 0] of lines) {
        ins('INSERT INTO return_items (return_id, product_id, qty, qty_good, qty_damaged) VALUES (?, ?, ?, ?, ?)',
          id, productId, qty, received ? qty - damaged : null, received ? damaged : null);
        if (received) {
          dated(daysAgo, () =>
            stock.returnToWarehouse(db, { productId, warehouseId, promoterId, campaignId, qtyGood: qty - damaged, qtyDamaged: damaged, reference: ref, userId: u.whDbn }),
          );
        }
      }
    };
    const held = (productId, promoterId, campaignId) => stock.fieldQty(db, productId, promoterId, campaignId);
    ret('RET-00001', c.sauce, u.p3, wh.dbn,
      [[p.sauceSachet, held(p.sauceSachet, u.p3, c.sauce)], [p.sauceApron, held(p.sauceApron, u.p3, c.sauce)], [p.sauceTable, 2, 1]], true, 2);
    ret('RET-00002', c.sauce, u.p5, wh.dbn,
      [[p.sauceSachet, held(p.sauceSachet, u.p5, c.sauce)], [p.sauceApron, held(p.sauceApron, u.p5, c.sauce)], [p.sauceTable, 1]], false, 0);

    db.prepare("UPDATE stock SET bin = 'A-' || (product_id % 9 + 1) || '-0' || (product_id % 4 + 1)").run();
  });
}

module.exports = { seed, DEMO_PASSWORD };

if (require.main === module) {
  const fs = require('node:fs');
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'jr-promo.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const { open } = require('./db');
  seed(open(file));
  console.log(`Demo data written to ${file}. Sign in with any demo account, password "${DEMO_PASSWORD}".`);
}
