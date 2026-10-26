'use strict';

/**
 * Demo data: fictional clients and staff so the system can be explored
 * straight away. All brand and person names are made up.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { hashPassword } = require('./auth');
const { tx } = require('./db');
const stock = require('./stock');

const DEMO_PASSWORD = 'password123';

/** A squiggly PNG "signature" for demo handovers, so the screens have something to show. */
function demoSignature(seedValue) {
  const W = 300;
  const H = 90;
  const px = Buffer.alloc((W + 1) * H, 255);
  for (let y = 0; y < H; y++) px[y * (W + 1)] = 0; // filter byte per row
  const a = 1 + (seedValue % 3);
  for (let x = 20; x < W - 20; x++) {
    const t = x / W;
    const y = Math.round(H / 2 + Math.sin(t * Math.PI * (3 + a)) * 22 * Math.sin(t * Math.PI) + Math.cos(t * 17 + seedValue) * 6);
    for (let dy = -1; dy <= 1; dy++) {
      const yy = Math.min(H - 1, Math.max(0, y + dy));
      px[yy * (W + 1) + 1 + x] = 20;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(px)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function seed(db) {
  tx(db, () => {
    const hash = hashPassword(DEMO_PASSWORD);
    const ins = (sql, ...params) => db.prepare(sql).run(...params).lastInsertRowid;

    const wh = {
      jhb: ins("INSERT INTO warehouses (name, city, province, address) VALUES ('JHB Main', 'Midrand', 'Gauteng', '14 Allandale Rd, Midrand')"),
      cpt: ins("INSERT INTO warehouses (name, city, province, address) VALUES ('Cape Town', 'Montague Gardens', 'Western Cape', '7 Marconi Rd, Montague Gardens')"),
      dbn: ins("INSERT INTO warehouses (name, city, province, address) VALUES ('Durban', 'Pinetown', 'KwaZulu-Natal', '22 Old Main Rd, Pinetown')"),
    };

    const user = (name, email, role, region, phone, warehouseId = null, gender = null, size = null) =>
      ins(
        `INSERT INTO users (name, email, phone, role, region, warehouse_id, gender, uniform_size, badge_code, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        name, email, phone, role, region, warehouseId, gender, size, crypto.createHash('sha256').update(`demo-badge:${email}`).digest('hex').slice(0, 20), hash,
      );

    const u = {
      director: user('Rina Jansen', 'director@jrpromo.test', 'director', 'Gauteng', '082 555 0101'),
      office: user('Thandi Mokoena', 'office@jrpromo.test', 'office', 'Gauteng', '082 555 0102'),
      am1: user('Lerato Dlamini', 'lerato@jrpromo.test', 'account_manager', 'Gauteng', '083 555 0201'),
      am2: user('Pieter van Wyk', 'pieter@jrpromo.test', 'account_manager', 'Western Cape', '083 555 0202'),
      whManager: user('Bongani Mthembu', 'manager@jrpromo.test', 'warehouse_manager', 'Gauteng', '084 555 0300', wh.jhb),
      whJhb: user('Sipho Nkosi', 'warehouse@jrpromo.test', 'warehouse', 'Gauteng', '084 555 0301', wh.jhb),
      whCpt: user('Charlene Adams', 'charlene@jrpromo.test', 'warehouse', 'Western Cape', '084 555 0302', wh.cpt),
      whDbn: user('Ashwin Naidoo', 'ashwin@jrpromo.test', 'warehouse', 'KwaZulu-Natal', '084 555 0303', wh.dbn),
      p1: user('Nomsa Khumalo', 'promoter@jrpromo.test', 'promoter', 'Gauteng', '071 555 0401', null, 'female', 'M'),
      p2: user('Kagiso Molefe', 'kagiso@jrpromo.test', 'promoter', 'Gauteng', '071 555 0402', null, 'male', 'L'),
      p3: user('Zanele Ndlovu', 'zanele@jrpromo.test', 'promoter', 'KwaZulu-Natal', '071 555 0403', null, 'female', 'S'),
      p4: user('Liam Petersen', 'liam@jrpromo.test', 'promoter', 'Western Cape', '071 555 0404', null, 'male', 'XL'),
      p5: user('Ayanda Zulu', 'ayanda@jrpromo.test', 'promoter', 'KwaZulu-Natal', '071 555 0405', null, 'male', 'M'),
    };

    const client = (name, contact, email, am) =>
      ins('INSERT INTO clients (name, contact_name, contact_email, account_manager_id) VALUES (?, ?, ?, ?)', name, contact, email, am);
    const cl = {
      house: ins(
        "INSERT INTO clients (name, contact_name, contact_email, is_house) VALUES ('JR Promotions (company stock)', 'Thandi Mokoena', 'office@jrpromo.test', 1)",
      ),
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
      juiceTee: product('SFJ-UNI-TEE', 'Sunfresh promoter T-shirt (Unisex · Orange · M)', cl.juice, 'Uniform', 85, 20),
      coffeeSachet: product('KCC-SMP-SCH', 'Kalahari instant sachet', cl.coffee, 'Sample', 2.2, 3000),
      coffeeMug: product('KCC-GFT-MUG', 'Branded enamel mug', cl.coffee, 'Giveaway', 42, 150),
      coffeeUrn: product('KCC-EQP-URN', 'Hot water urn 20L', cl.coffee, 'Equipment', 1450, 2),
      coffeeWobbler: product('KCC-POS-WOB', 'Shelf wobbler', cl.coffee, 'POS Material', 6.5, 400),
      mobileSim: product('UBM-SIM-STK', 'Starter pack SIM', cl.mobile, 'Merchandise', 1.8, 2000),
      mobileGazebo: product('UBM-EQP-GAZ', 'Ubuntu Mobile branded gazebo 3x3m', cl.mobile, 'Gazebo', 4200, 3),
      mobileBackwall: product('UBM-BWB-3X2', 'Ubuntu Mobile backwall banner 3x2.25m', cl.mobile, 'Backwall Banner', 2600, 2),
      mobilePullup: product('UBM-PUB-85', 'Ubuntu Mobile pull-up banner 850mm', cl.mobile, 'Pull-up Banner', 750, 4),
      juiceBackwall: product('SFJ-BWB-3X2', 'Sunfresh backwall banner 3x2.25m', cl.juice, 'Backwall Banner', 2600, 2),
      juicePullup: product('SFJ-PUB-85', 'Sunfresh pull-up banner 850mm', cl.juice, 'Pull-up Banner', 750, 4),
      coffeePullup: product('KCC-PUB-85', 'Kalahari Coffee pull-up banner 850mm', cl.coffee, 'Pull-up Banner', 750, 2),
      skinPullup: product('PRS-PUB-85', 'Protea pull-up banner 850mm', cl.skin, 'Pull-up Banner', 750, 2),
      mobileCap: product('UBM-GFT-CAP', 'Ubuntu Mobile cap', cl.mobile, 'Giveaway', 38, 200),
      mobileFlyer: product('UBM-POS-FLY', 'A5 data bundle flyer', cl.mobile, 'POS Material', 0.9, 5000),
      skinTester: product('PRS-SMP-TST', 'Protea day cream tester 5ml', cl.skin, 'Sample', 7.5, 800),
      skinBag: product('PRS-GFT-BAG', 'Protea cotton tote bag', cl.skin, 'Giveaway', 29, 250),
      skinStand: product('PRS-POS-STD', 'Counter display stand', cl.skin, 'POS Material', 320, 8),
      sauceSachet: product('BMS-SMP-SCH', 'Braai sauce 20ml sachet', cl.sauce, 'Sample', 1.6, 2500),
      sauceApron: product('BMS-GFT-APR', 'Braai Master apron', cl.sauce, 'Giveaway', 95, 60),
      sauceTable: product('BMS-EQP-TBL', 'Folding tasting table', cl.sauce, 'Equipment', 890, 4),
      // Company-owned stock any campaign can use
      table: product('JR-TBL-FOLD', 'Folding promoter table 1.8m', cl.house, 'Promoter Table', 950, 10),
      tableSmall: product('JR-TBL-POD', 'Round demo podium table', cl.house, 'Promoter Table', 1650, 4),
      cloth: product('JR-TBL-CLOTH', 'Black stretch table cloth', cl.house, 'Setup & Display', 280, 15),
      gazebo: product('JR-SET-GAZ', 'JR gazebo 3x3m (black)', cl.house, 'Gazebo', 3800, 3),
      gazeboSmall: product('JR-SET-GAZ2', 'JR gazebo 2x2m (black)', cl.house, 'Gazebo', 2900, 2),
      flag: product('JR-SET-FLAG', 'Telescopic banner flag with base', cl.house, 'Setup & Display', 650, 6),
      cooler: product('JR-EQP-COOL', 'Cooler box 40L', cl.house, 'Equipment', 720, 4),
    };
    db.prepare("UPDATE products SET gender = 'unisex', size = 'M', colour = 'Orange', style = 'Sunfresh promoter T-shirt' WHERE id = ?").run(p.juiceTee);
    // Samples with a shelf life are tracked by batch and expiry date
    for (const id of [p.juiceSample, p.coffeeSachet, p.skinTester, p.sauceSachet]) {
      db.prepare('UPDATE products SET tracks_expiry = 1 WHERE id = ?').run(id);
    }

    // JR promoter golf shirt range: ladies & mens, black & white, XS-XXL
    const polo = {};
    for (const gender of ['female', 'male']) {
      for (const colour of ['Black', 'White']) {
        for (const size of ['XS', 'S', 'M', 'L', 'XL', 'XXL']) {
          const sku = `JRU-POLO-${gender[0].toUpperCase()}-${colour.toUpperCase()}-${size}`;
          polo[`${gender[0]}-${colour}-${size}`] = ins(
            `INSERT INTO products (sku, name, client_id, category, unit_cost, reorder_level, gender, size, colour, style)
             VALUES (?, ?, ?, 'Uniform', 165, 3, ?, ?, ?, 'JR promoter golf shirt')`,
            sku, `JR promoter golf shirt (${gender === 'female' ? 'Ladies' : 'Mens'} · ${colour} · ${size})`, cl.house, gender, size, colour,
          );
        }
      }
    }
    const WAREHOUSE_GPS = { [wh.jhb]: [-25.9992, 28.1263], [wh.cpt]: [-33.864, 18.523], [wh.dbn]: [-29.81, 30.858] };
    const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

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

    // lines: [productId, qty, expiryOffsetDays?]
    const receive = (daysAgo, warehouseId, ref, lines, userId, note = null) =>
      dated(daysAgo, () => {
        for (const [productId, qty, expiresIn] of lines) {
          const expiryDate = expiresIn === undefined ? null : day(expiresIn);
          stock.receive(db, { productId, warehouseId, qty, reference: ref, batchNo: expiryDate ? `${ref}-L1` : null, expiryDate, note, userId });
        }
      });

    receive(35, wh.jhb, 'GRN-24088', [[p.juiceSample, 240, -5]], u.whJhb, 'Left over from winter promo');
    const house = (qtyTables, qtyCloths, qtyGazebos, qtyFlags, qtyCoolers) =>
      [[p.table, qtyTables], [p.tableSmall, Math.ceil(qtyTables / 4)], [p.cloth, qtyCloths], [p.gazebo, qtyGazebos], [p.flag, qtyFlags], [p.cooler, qtyCoolers]];
    receive(30, wh.jhb, 'GRN-24090', [...house(20, 30, 5, 10, 8), ...Object.values(polo).map((id) => [id, 8])], u.whJhb, 'Supplier: Cape Union Mart corporate');
    receive(30, wh.cpt, 'GRN-24091', house(8, 10, 2, 4, 3), u.whCpt);
    receive(30, wh.dbn, 'GRN-24092', [...house(6, 8, 2, 4, 3), ...Object.values(polo).map((id) => [id, 4])], u.whDbn);
    receive(29, wh.jhb, 'GRN-24095', [[p.gazeboSmall, 3], [p.juiceBackwall, 2], [p.juicePullup, 6], [p.coffeePullup, 3]], u.whJhb, 'Printed by Signage Express');
    receive(29, wh.dbn, 'GRN-24096', [[p.gazeboSmall, 2], [p.mobileBackwall, 2], [p.mobilePullup, 4]], u.whDbn, 'Printed by Signage Express');
    receive(29, wh.cpt, 'GRN-24097', [[p.skinPullup, 3], [p.mobilePullup, 2]], u.whCpt);
    receive(28, wh.jhb, 'GRN-24101', [[p.juiceSample, 6000, 20], [p.juiceCup, 200], [p.juiceAframe, 12], [p.juiceTee, 60]], u.whJhb, 'Courier: Ram Hand-to-Hand');
    receive(27, wh.jhb, 'GRN-24102', [[p.coffeeSachet, 10000, 200], [p.coffeeMug, 400], [p.coffeeUrn, 6], [p.coffeeWobbler, 1200]], u.whJhb);
    receive(26, wh.cpt, 'GRN-24103', [[p.mobileSim, 8000], [p.mobileGazebo, 6], [p.mobileCap, 600], [p.mobileFlyer, 20000]], u.whCpt);
    receive(25, wh.cpt, 'GRN-24104', [[p.skinTester, 3000, 90], [p.skinBag, 500], [p.skinStand, 20]], u.whCpt);
    receive(24, wh.dbn, 'GRN-24105', [[p.sauceSachet, 9000, 150], [p.sauceApron, 120], [p.sauceTable, 8]], u.whDbn);
    receive(20, wh.jhb, 'GRN-24110', [[p.sauceSachet, 4000, 45], [p.sauceApron, 80], [p.skinTester, 1200, 12]], u.whJhb);
    dated(18, () => {
      stock.transfer(db, { productId: p.mobileCap, fromWarehouseId: wh.cpt, toWarehouseId: wh.jhb, qty: 200, reference: 'TRF-0001', userId: u.whCpt });
      stock.transfer(db, { productId: p.mobileSim, fromWarehouseId: wh.cpt, toWarehouseId: wh.dbn, qty: 2500, reference: 'TRF-0001', userId: u.whCpt });
    });

    const campaign = (name, clientId, am, region, start, end, status, promoters, colour) => {
      const id = ins(
        'INSERT INTO campaigns (name, client_id, account_manager_id, region, start_date, end_date, status, colour) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        name, clientId, am, region, start, end, status, colour,
      );
      for (const pid of promoters) ins('INSERT INTO campaign_promoters (campaign_id, promoter_id) VALUES (?, ?)', id, pid);
      return id;
    };
    const c = {
      juice: campaign('Sunfresh Summer Tastings', cl.juice, u.am1, 'Gauteng', day(-21), day(30), 'active', [u.p1, u.p2], 'orange'),
      coffee: campaign('Kalahari Morning Commute', cl.coffee, u.am1, 'Gauteng', day(-14), day(14), 'active', [u.p2], 'brown'),
      mobile: campaign('Ubuntu Mobile Taxi Rank Drive', cl.mobile, u.am2, 'KwaZulu-Natal', day(-15), day(45), 'active', [u.p3, u.p5], 'yellow'),
      skin: campaign('Protea Mall Sampling', cl.skin, u.am2, 'Western Cape', day(-10), day(20), 'active', [u.p4], 'pink'),
      sauce: campaign('Braai Master Heritage Month', cl.sauce, u.am1, 'KwaZulu-Natal', day(-40), day(-3), 'completed', [u.p3, u.p5], 'red'),
      juiceDbn: campaign('Sunfresh Durban Launch', cl.juice, u.am1, 'KwaZulu-Natal', day(5), day(40), 'planned', [u.p5], 'lime'),
    };
    // Shelve each client's stock under its campaign colour (company stock stays untagged)
    const shelve = (campaignId, ids) => ids.forEach((pid) => db.prepare('UPDATE products SET campaign_id = ? WHERE id = ?').run(campaignId, pid));
    shelve(c.juice, [p.juiceSample, p.juiceCup, p.juiceAframe, p.juiceTee, p.juiceBackwall, p.juicePullup]);
    shelve(c.coffee, [p.coffeeSachet, p.coffeeMug, p.coffeeUrn, p.coffeeWobbler, p.coffeePullup]);
    shelve(c.mobile, [p.mobileSim, p.mobileGazebo, p.mobileCap, p.mobileFlyer, p.mobileBackwall, p.mobilePullup]);
    shelve(c.skin, [p.skinTester, p.skinBag, p.skinStand, p.skinPullup]);
    shelve(c.sauce, [p.sauceSachet, p.sauceApron, p.sauceTable]);

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
      // Handover records: who at the warehouse processed which promoter, with signature
      if (['dispatched', 'delivered'].includes(status)) {
        const uniforms = lines.some(([pid]) => db.prepare('SELECT category FROM products WHERE id = ?').get(pid).category === 'Uniform');
        const handover = (kind, staffId, signed, daysBack) =>
          ins(
            `INSERT INTO handovers (kind, request_id, promoter_id, staff_id, warehouse_id, signature, uniform_clean, uniform_ironed, created_at,
               lat, lng, accuracy)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            kind, id, promoterId, staffId, staffId ? warehouseId : null, signed ? demoSignature(id) : null,
            kind !== 'delivery' && uniforms ? 1 : null, kind !== 'delivery' && uniforms ? 1 : null, stamp(daysBack, 10),
            // Counter handovers are geotagged at the warehouse; courier deliveries were confirmed before geotagging existed
            kind === 'collection' ? WAREHOUSE_GPS[warehouseId][0] : null, kind === 'collection' ? WAREHOUSE_GPS[warehouseId][1] : null,
            kind === 'collection' ? 15 : null,
          );
        if (method === 'collect') {
          handover('collection', dispatcher, true, daysAgo - 1);
          db.prepare('UPDATE requests SET delivered_at = dispatched_at WHERE id = ?').run(id);
        } else {
          handover('dispatch', dispatcher, false, daysAgo - 1);
          if (status === 'delivered') handover('delivery', null, true, daysAgo - 2);
        }
      }
      return ref;
    };

    request({ campaignId: c.sauce, warehouseId: wh.dbn, promoterId: u.p3, by: u.p3, approver: u.am1, dispatcher: u.whDbn, status: 'delivered', daysAgo: 22,
      lines: [[p.sauceSachet, 3000], [p.sauceApron, 40], [p.sauceTable, 2], [p.cloth, 2], [polo['f-Black-S'], 2]] });
    request({ campaignId: c.sauce, warehouseId: wh.dbn, promoterId: u.p5, by: u.am1, approver: u.am1, dispatcher: u.whDbn, status: 'delivered', daysAgo: 21,
      lines: [[p.sauceSachet, 2500], [p.sauceApron, 30], [p.sauceTable, 1], [polo['m-Black-M'], 2]] });
    request({ campaignId: c.juice, warehouseId: wh.jhb, promoterId: u.p1, by: u.p1, approver: u.am1, dispatcher: u.whJhb, status: 'delivered', daysAgo: 19,
      lines: [[p.juiceSample, 2000], [p.juiceCup, 60], [p.juiceAframe, 2], [p.juiceTee, 4], [polo['f-White-M'], 2], [p.table, 1], [p.cloth, 1], [p.cooler, 1]] });
    request({ campaignId: c.juice, warehouseId: wh.jhb, promoterId: u.p2, by: u.p2, approver: u.am1, dispatcher: u.whJhb, status: 'delivered', daysAgo: 18,
      lines: [[p.juiceSample, 1800], [p.juiceCup, 50], [p.juiceAframe, 2], [p.juiceTee, 4], [polo['m-White-L'], 2], [p.table, 1], [p.cloth, 1]] });
    request({ campaignId: c.mobile, warehouseId: wh.dbn, promoterId: u.p3, by: u.p3, approver: u.am2, dispatcher: u.whDbn, status: 'delivered', daysAgo: 14,
      method: 'courier', waybill: 'TCG84412093', lines: [[p.mobileSim, 1500]] });
    request({ campaignId: c.mobile, warehouseId: wh.cpt, promoterId: u.p5, by: u.p5, approver: u.am2, dispatcher: u.whCpt, status: 'delivered', daysAgo: 13,
      method: 'courier', waybill: 'TCG84412871', lines: [[p.mobileGazebo, 1], [p.mobileCap, 150], [p.mobileFlyer, 5000]] });
    request({ campaignId: c.coffee, warehouseId: wh.jhb, promoterId: u.p2, by: u.am1, approver: u.am1, dispatcher: u.whJhb, status: 'delivered', daysAgo: 12,
      lines: [[p.coffeeSachet, 4000], [p.coffeeMug, 120], [p.coffeeUrn, 1], [p.coffeeWobbler, 300], [p.tableSmall, 1]] });
    request({ campaignId: c.skin, warehouseId: wh.cpt, promoterId: u.p4, by: u.p4, approver: u.am2, dispatcher: u.whCpt, status: 'delivered', daysAgo: 9,
      lines: [[p.skinTester, 1200], [p.skinBag, 200], [p.skinStand, 2], [p.table, 1], [p.cloth, 1]] });
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
    // Approximate public locations of the demo stores, for activation geotags
    const PLACES = {
      'Checkers Hyper Sandton City': [-26.1086, 28.0527],
      'Pick n Pay Rosebank': [-26.1458, 28.0436],
      'Spar Fourways Crossing': [-26.018, 28.008],
      'Woolworths Menlyn': [-25.7826, 28.2775],
      'Shoprite Soweto Maponya Mall': [-26.2595, 27.8796],
      'Pick n Pay Gateway Umhlanga': [-29.7275, 31.0663],
      'Spar Pinetown': [-29.8167, 30.8667],
      'Checkers Pavilion': [-29.8495, 30.9354],
      'Warwick Junction taxi rank': [-29.8566, 31.0119],
      'Shoprite Durban Station': [-29.8494, 31.0228],
      'Clicks Canal Walk': [-33.8935, 18.5115],
      'Dis-Chem V&A Waterfront': [-33.9036, 18.4207],
      'Clicks Tyger Valley': [-33.8735, 18.6347],
      'Woolworths Cavendish': [-33.9893, 18.4669],
      'Park Station concourse': [-26.1975, 28.042],
    };
    const jitter = () => (Math.random() - 0.5) * 0.0008;
    let usageCount = 0;
    const usage = (daysAgo, campaignId, promoterId, store, lines) => {
      usageCount += 1;
      // A few reports without a location, as happens when a phone denies GPS
      const place = usageCount % 9 === 0 ? null : PLACES[store];
      const id = ins(
        'INSERT INTO usage_reports (campaign_id, promoter_id, report_date, store, created_at, lat, lng, accuracy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        campaignId, promoterId, day(-daysAgo), store, stamp(daysAgo, 17),
        place ? place[0] + jitter() : null, place ? place[1] + jitter() : null, place ? 8 + Math.round(Math.random() * 25) : null,
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
      for (const [productId, qty, damaged = 0, laundry = 0] of lines) {
        const good = qty - damaged - laundry;
        ins('INSERT INTO return_items (return_id, product_id, qty, qty_good, qty_damaged, qty_laundry) VALUES (?, ?, ?, ?, ?, ?)',
          id, productId, qty, received ? good : null, received ? damaged : null, received ? laundry : null);
        if (received) {
          dated(daysAgo, () =>
            stock.returnToWarehouse(db, { productId, warehouseId, promoterId, campaignId, qtyGood: good, qtyDamaged: damaged, qtyLaundry: laundry, reference: ref, userId: u.whDbn }),
          );
        }
      }
      if (received) {
        const laundry = lines.some(([, , , l]) => l > 0);
        ins(
          `INSERT INTO handovers (kind, return_id, promoter_id, staff_id, warehouse_id, signature, uniform_clean, uniform_ironed, note, created_at)
           VALUES ('return', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, promoterId, u.whDbn, warehouseId, demoSignature(id + 7), laundry ? 0 : 1, laundry ? 0 : 1,
          laundry ? '1 golf shirt came back unwashed' : null, stamp(daysAgo, 12),
        );
      }
    };
    const held = (productId, promoterId, campaignId) => stock.fieldQty(db, productId, promoterId, campaignId);
    ret('RET-00001', c.sauce, u.p3, wh.dbn,
      [[p.sauceSachet, held(p.sauceSachet, u.p3, c.sauce)], [p.sauceApron, held(p.sauceApron, u.p3, c.sauce)], [p.sauceTable, 2, 1], [p.cloth, 2], [polo['f-Black-S'], 2, 0, 1]], true, 2);
    ret('RET-00002', c.sauce, u.p5, wh.dbn,
      [[p.sauceSachet, held(p.sauceSachet, u.p5, c.sauce)], [p.sauceApron, held(p.sauceApron, u.p5, c.sauce)], [p.sauceTable, 1], [polo['m-Black-M'], 2]], false, 0);

    // Kits: standard setups added to a request in one click
    const kit = (name, description, items) => {
      const id = ins('INSERT INTO kits (name, description) VALUES (?, ?)', name, description);
      for (const [productId, qty] of items) ins('INSERT INTO kit_items (kit_id, product_id, qty) VALUES (?, ?, ?)', id, productId, qty);
    };
    kit('In-store tasting setup', 'One table with cloth and a cooler box', [[p.table, 1], [p.cloth, 1], [p.cooler, 1]]);
    kit('Outdoor activation setup', 'Gazebo, table, cloth and two banner flags', [[p.gazebo, 1], [p.table, 1], [p.cloth, 1], [p.flag, 2]]);
    kit('Small mall setup', '2x2m gazebo, table and cloth', [[p.gazeboSmall, 1], [p.table, 1], [p.cloth, 1]]);
    kit('Demo podium setup', 'Round podium table with cloth', [[p.tableSmall, 1], [p.cloth, 1]]);

    // Campaign stock plans
    const plan = (campaignId, items) => {
      for (const [productId, qty] of items) ins('INSERT INTO campaign_plan (campaign_id, product_id, planned_qty) VALUES (?, ?, ?)', campaignId, productId, qty);
    };
    plan(c.juice, [[p.juiceSample, 7000], [p.juiceCup, 180], [p.juiceAframe, 4], [p.table, 2], [p.cloth, 2]]);
    plan(c.coffee, [[p.coffeeSachet, 7000], [p.coffeeMug, 220], [p.tableSmall, 1]]);
    plan(c.mobile, [[p.mobileSim, 3000], [p.mobileGazebo, 2], [p.mobileFlyer, 8000]]);
    plan(c.juiceDbn, [[p.juiceSample, 1500], [p.juiceCup, 40], [p.gazebo, 1], [p.table, 1], [p.cloth, 1], [polo['m-Black-M'], 2]]);

    db.prepare("UPDATE stock SET bin = 'A-' || (product_id % 9 + 1) || '-0' || (product_id % 4 + 1)").run();

    // Setups & strike downs: one done last week, one standing now (strike down today), one tomorrow
    let setupNo = 0;
    const localAt = (offsetDays, hhmm) => `${day(offsetDays)}T${hhmm}`;
    const setup = ({ campaignId, warehouseId, venue, address, contact, setupAt, strikeAt, lead, crew, items, status, loadedBy, ago }) => {
      setupNo += 1;
      const ref = `SET-${String(setupNo).padStart(5, '0')}`;
      const id = ins(
        `INSERT INTO setups (ref, campaign_id, warehouse_id, venue, address, contact, setup_at, strike_at, lead_id, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        ref, campaignId, warehouseId, venue, address, contact, setupAt, strikeAt, lead, u.whManager, stamp(ago + 3, 9),
      );
      for (const m of crew) ins('INSERT INTO setup_crew (setup_id, user_id) VALUES (?, ?)', id, m);
      const itemIds = items.map(([productId, qty]) => [ins('INSERT INTO setup_items (setup_id, product_id, qty) VALUES (?, ?, ?)', id, productId, qty), productId, qty]);
      if (status === 'scheduled') return;
      dated(ago, () => {
        for (const [itemId, productId, qty] of itemIds) {
          stock.dispatch(db, { productId, warehouseId, promoterId: lead, campaignId, qty, reference: ref, userId: loadedBy });
          db.prepare('UPDATE setup_items SET qty_out = ? WHERE id = ?').run(qty, itemId);
        }
      });
      const place = PLACES[venue.split(' (')[0]] || [null, null];
      db.prepare(`UPDATE setups SET status = 'loaded', loaded_by = ?, loaded_at = ?, set_up_by = ?, set_up_at = ?, set_up_lat = ?, set_up_lng = ? WHERE id = ?`)
        .run(loadedBy, stamp(ago, 6), lead, stamp(ago, 9), place[0], place[1], id);
      db.prepare("UPDATE setups SET status = 'set_up' WHERE id = ?").run(id);
      if (status === 'returned') {
        dated(ago - 2, () => {
          for (const [itemId, productId, qty] of itemIds) {
            const damaged = productId === p.cloth ? 1 : 0;
            stock.returnToWarehouse(db, { productId, warehouseId, promoterId: lead, campaignId, qtyGood: qty - damaged, qtyDamaged: damaged, reference: ref, userId: loadedBy });
            db.prepare('UPDATE setup_items SET qty_good = ?, qty_damaged = ? WHERE id = ?').run(qty - damaged, damaged, itemId);
          }
        });
        db.prepare(`UPDATE setups SET status = 'returned', struck_by = ?, struck_at = ?, struck_lat = ?, struck_lng = ?, returned_by = ?, returned_at = ? WHERE id = ?`)
          .run(lead, stamp(ago - 2, 17), place[0], place[1], loadedBy, stamp(ago - 3, 9), id);
      }
    };
    setup({
      campaignId: c.coffee, warehouseId: wh.jhb, venue: 'Park Station concourse', address: 'Park Station, Rissik St, Johannesburg',
      contact: 'Station manager, 011 555 0199', setupAt: localAt(-9, '05:00'), strikeAt: localAt(-7, '19:00'), lead: u.p2, crew: [u.whJhb],
      items: [[p.gazeboSmall, 1], [p.table, 2], [p.cloth, 2], [p.coffeePullup, 2]], status: 'returned', loadedBy: u.whJhb, ago: 9,
    });
    setup({
      campaignId: c.mobile, warehouseId: wh.dbn, venue: 'Warwick Junction taxi rank', address: 'Warwick Ave, Durban CBD',
      contact: 'Rank marshal: Mr Dube, 031 555 0144', setupAt: localAt(-2, '06:00'), strikeAt: localAt(0, '17:00'), lead: u.p3, crew: [u.p5, u.whDbn],
      items: [[p.gazebo, 1], [p.mobileBackwall, 1], [p.mobilePullup, 2], [p.table, 1], [p.cloth, 1]], status: 'set_up', loadedBy: u.whDbn, ago: 2,
    });
    setup({
      campaignId: c.juice, warehouseId: wh.jhb, venue: 'Checkers Hyper Sandton City', address: 'Sandton City, Rivonia Rd, Sandton',
      contact: 'Centre management, 011 555 0123', setupAt: localAt(1, '07:00'), strikeAt: localAt(3, '18:00'), lead: u.p1, crew: [u.p2, u.whJhb],
      items: [[p.gazebo, 1], [p.juiceBackwall, 1], [p.juicePullup, 2], [p.table, 2], [p.cloth, 2]], status: 'scheduled', ago: 0,
    });

    // Stock counts: one finished, one waiting for the manager, open ones on the floor
    let cnt = 0;
    const count = ({ warehouseId, counter, kind, daysAgo, lines, status }) => {
      cnt += 1;
      const ref = `CNT-${String(cnt).padStart(5, '0')}`;
      const submitted = status !== 'open' ? stamp(daysAgo, 15).replace(' ', 'T') + '.000Z' : null;
      const id = ins(
        `INSERT INTO stock_counts (ref, warehouse_id, kind, status, assigned_to, created_by, created_at, submitted_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ref, warehouseId, kind, status, counter, u.whManager, stamp(daysAgo, 7), submitted, status === 'closed' ? submitted : null,
      );
      const counterName = db.prepare('SELECT name FROM users WHERE id = ?').get(counter).name;
      for (const [productId, diff] of lines) {
        const bin = (db.prepare('SELECT bin FROM stock WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId) || {}).bin;
        const cost = db.prepare('SELECT unit_cost FROM products WHERE id = ?').get(productId).unit_cost;
        if (status === 'open') {
          ins('INSERT INTO count_lines (count_id, product_id, bin) VALUES (?, ?, ?)', id, productId, bin);
          continue;
        }
        const system = stock.warehouseQty(db, productId, warehouseId);
        const lineStatus = diff === 0 ? 'matched' : status === 'closed' ? 'auto' : 'pending';
        ins(
          `INSERT INTO count_lines (count_id, product_id, bin, counted_qty, system_qty, variance, unit_cost, status, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, productId, bin, system + diff, system, diff, cost, lineStatus, lineStatus === 'pending' ? null : submitted,
        );
        if (lineStatus === 'auto') {
          dated(daysAgo, () => stock.adjustBy(db, { productId, warehouseId, delta: diff, reference: ref, note: `Counted by ${counterName}, within tolerance`, userId: counter }));
        }
      }
    };
    count({ warehouseId: wh.jhb, counter: u.whJhb, kind: 'cycle', daysAgo: 10, status: 'closed',
      lines: [[p.table, 0], [p.cloth, 0], [p.coffeeMug, -1], [p.juiceAframe, 0], [p.coffeeUrn, 0], [p.cooler, 0]] });
    count({ warehouseId: wh.jhb, counter: u.whJhb, kind: 'cycle', daysAgo: 1, status: 'submitted',
      lines: [[p.sauceApron, -6], [p.coffeeWobbler, -40], [p.tableSmall, 0], [p.flag, 0], [p.gazebo, 0]] });
    count({ warehouseId: wh.jhb, counter: u.whJhb, kind: 'cycle', daysAgo: 0, status: 'open',
      lines: [[p.mobileCap, null], [p.skinTester, null], [p.sauceSachet, null], [polo['f-Black-M'], null], [polo['m-Black-L'], null], [polo['f-White-S'], null]] });
    count({ warehouseId: wh.dbn, counter: u.whDbn, kind: 'spot', daysAgo: 0, status: 'open',
      lines: [[p.sauceTable, null], [p.sauceApron, null], [p.table, null]] });
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
