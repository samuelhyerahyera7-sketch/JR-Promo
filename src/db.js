'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('director','office','account_manager','warehouse','promoter')),
  region TEXT,
  warehouse_id INTEGER REFERENCES warehouses(id),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  city TEXT NOT NULL,
  province TEXT NOT NULL,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  account_manager_id INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  category TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'unit',
  unit_cost REAL NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  barcode TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- Stock on hand in each warehouse
CREATE TABLE IF NOT EXISTS stock (
  product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  bin TEXT,
  PRIMARY KEY (product_id, warehouse_id)
);

-- Stock held by promoters in the field, per campaign
CREATE TABLE IF NOT EXISTS field_stock (
  product_id INTEGER NOT NULL REFERENCES products(id),
  promoter_id INTEGER NOT NULL REFERENCES users(id),
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (product_id, promoter_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  account_manager_id INTEGER REFERENCES users(id),
  region TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','cancelled')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_promoters (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  promoter_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (campaign_id, promoter_id)
);

-- Stock requests: promoter/AM asks for stock -> AM/director approves -> warehouse dispatches -> promoter confirms
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  promoter_id INTEGER NOT NULL REFERENCES users(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','picking','dispatched','delivered','cancelled')),
  needed_by TEXT,
  delivery_method TEXT,
  delivery_address TEXT,
  courier TEXT,
  waybill TEXT,
  notes TEXT,
  decision_note TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  dispatched_by INTEGER REFERENCES users(id),
  dispatched_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_items (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty_requested INTEGER NOT NULL CHECK (qty_requested > 0),
  qty_approved INTEGER,
  qty_dispatched INTEGER
);

-- Returns of unused field stock back to a warehouse
CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  promoter_id INTEGER NOT NULL REFERENCES users(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','cancelled')),
  notes TEXT,
  received_by INTEGER REFERENCES users(id),
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  qty_good INTEGER,
  qty_damaged INTEGER
);

-- Promoter activation reports: what was handed out / used at a store
CREATE TABLE IF NOT EXISTS usage_reports (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  promoter_id INTEGER NOT NULL REFERENCES users(id),
  report_date TEXT NOT NULL,
  store TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_items (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES usage_reports(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty_used INTEGER NOT NULL DEFAULT 0 CHECK (qty_used >= 0),
  qty_damaged INTEGER NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0)
);

-- Immutable ledger of every stock change
CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('receipt','dispatch','transfer','adjustment','return','usage','damage')),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  from_warehouse_id INTEGER REFERENCES warehouses(id),
  to_warehouse_id INTEGER REFERENCES warehouses(id),
  promoter_id INTEGER REFERENCES users(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  reference TEXT,
  note TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_movements_product ON movements(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_products_client ON products(client_id);
`;

// Schema changes after the first release. Each entry upgrades the database by one version.
const MIGRATIONS = [
  // v2: uniforms, house stock, expiry batches, laundry, kits, campaign plans, handovers, attachments
  `
  ALTER TABLE products ADD COLUMN gender TEXT;
  ALTER TABLE products ADD COLUMN size TEXT;
  ALTER TABLE products ADD COLUMN colour TEXT;
  ALTER TABLE products ADD COLUMN style TEXT;
  ALTER TABLE products ADD COLUMN tracks_expiry INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clients ADD COLUMN is_house INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN badge_code TEXT;
  ALTER TABLE users ADD COLUMN gender TEXT;
  ALTER TABLE users ADD COLUMN uniform_size TEXT;
  UPDATE users SET badge_code = lower(hex(randomblob(10))) WHERE badge_code IS NULL;
  CREATE UNIQUE INDEX idx_users_badge ON users(badge_code);
  ALTER TABLE return_items ADD COLUMN qty_laundry INTEGER;

  -- Expiry-tracked stock is held in batches; their total always equals stock.qty
  CREATE TABLE stock_batches (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    batch_no TEXT NOT NULL,
    expiry_date TEXT,
    qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
    UNIQUE (product_id, warehouse_id, batch_no)
  );

  -- Returned uniforms waiting to be washed and ironed before they can be issued again
  CREATE TABLE laundry_stock (
    product_id INTEGER NOT NULL REFERENCES products(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
    PRIMARY KEY (product_id, warehouse_id)
  );

  -- Ready-made sets, e.g. a tasting table setup
  CREATE TABLE kits (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE kit_items (
    kit_id INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL CHECK (qty > 0),
    PRIMARY KEY (kit_id, product_id)
  );

  -- Stock a campaign is planned to need
  CREATE TABLE campaign_plan (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    planned_qty INTEGER NOT NULL CHECK (planned_qty >= 0),
    PRIMARY KEY (campaign_id, product_id)
  );

  -- Who handed what to whom: warehouse staff member, promoter, signature, uniform check
  CREATE TABLE handovers (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('collection','dispatch','delivery','return')),
    request_id INTEGER REFERENCES requests(id),
    return_id INTEGER REFERENCES returns(id),
    promoter_id INTEGER NOT NULL REFERENCES users(id),
    staff_id INTEGER REFERENCES users(id),
    warehouse_id INTEGER REFERENCES warehouses(id),
    signature TEXT,
    uniform_clean INTEGER,
    uniform_ironed INTEGER,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_handovers_promoter ON handovers(promoter_id);

  -- Photos (waybills, delivery notes, damage) attached to deliveries, requests and returns
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('receipt','request','return')),
    reference TEXT,
    warehouse_id INTEGER REFERENCES warehouses(id),
    request_id INTEGER REFERENCES requests(id),
    return_id INTEGER REFERENCES returns(id),
    caption TEXT,
    filename TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_attachments_ref ON attachments(kind, reference);

  -- Rebuild the ledger to allow the new movement types and record batches
  CREATE TABLE movements_v2 (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('receipt','dispatch','transfer','adjustment','return','usage','damage',
                                       'laundry','laundered','write_off')),
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL,
    from_warehouse_id INTEGER REFERENCES warehouses(id),
    to_warehouse_id INTEGER REFERENCES warehouses(id),
    promoter_id INTEGER REFERENCES users(id),
    campaign_id INTEGER REFERENCES campaigns(id),
    batch_no TEXT,
    expiry_date TEXT,
    reference TEXT,
    note TEXT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO movements_v2 (id, type, product_id, qty, from_warehouse_id, to_warehouse_id, promoter_id, campaign_id,
                            reference, note, user_id, created_at)
    SELECT id, type, product_id, qty, from_warehouse_id, to_warehouse_id, promoter_id, campaign_id,
           reference, note, user_id, created_at FROM movements;
  DROP TABLE movements;
  ALTER TABLE movements_v2 RENAME TO movements;
  CREATE INDEX idx_movements_product ON movements(product_id);
  CREATE INDEX idx_movements_created ON movements(created_at);
  CREATE INDEX idx_movements_reference ON movements(reference);
  `,
  // v3: geotags (phone GPS position) on activation reports, handovers and photos
  `
  ALTER TABLE usage_reports ADD COLUMN lat REAL;
  ALTER TABLE usage_reports ADD COLUMN lng REAL;
  ALTER TABLE usage_reports ADD COLUMN accuracy REAL;
  ALTER TABLE handovers ADD COLUMN lat REAL;
  ALTER TABLE handovers ADD COLUMN lng REAL;
  ALTER TABLE handovers ADD COLUMN accuracy REAL;
  ALTER TABLE attachments ADD COLUMN lat REAL;
  ALTER TABLE attachments ADD COLUMN lng REAL;
  ALTER TABLE attachments ADD COLUMN accuracy REAL;
  `,
  // v4: warehouse manager role, controlled stock counts (blind counting + approval), settings
  {
    // Rebuilding users (to widen the role list) needs foreign key checks off while the table is swapped
    foreignKeysOff: true,
    sql: `
  CREATE TABLE users_v4 (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT,
    role TEXT NOT NULL CHECK (role IN ('director','office','account_manager','warehouse_manager','warehouse','promoter')),
    region TEXT,
    warehouse_id INTEGER REFERENCES warehouses(id),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    gender TEXT,
    uniform_size TEXT,
    badge_code TEXT
  );
  INSERT INTO users_v4 (id, name, email, phone, role, region, warehouse_id, password_hash, active, created_at, gender, uniform_size, badge_code)
    SELECT id, name, email, phone, role, region, warehouse_id, password_hash, active, created_at, gender, uniform_size, badge_code FROM users;
  DROP TABLE users;
  ALTER TABLE users_v4 RENAME TO users;
  CREATE UNIQUE INDEX idx_users_badge ON users(badge_code);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Count differences within both limits are adjusted automatically; bigger ones wait for a manager
  INSERT INTO settings (key, value) VALUES ('count_tolerance_units', '2'), ('count_tolerance_value', '200');

  -- A stock count: a list of products in one warehouse, counted blind by one person
  CREATE TABLE stock_counts (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    kind TEXT NOT NULL DEFAULT 'spot' CHECK (kind IN ('cycle','full','spot')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','closed','cancelled')),
    assigned_to INTEGER NOT NULL REFERENCES users(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    submitted_at TEXT,
    closed_at TEXT
  );
  CREATE TABLE count_lines (
    id INTEGER PRIMARY KEY,
    count_id INTEGER NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    bin TEXT,
    counted_qty INTEGER CHECK (counted_qty >= 0),
    -- system_qty and variance are only filled in when the count is submitted (blind counting)
    system_qty INTEGER,
    variance INTEGER,
    unit_cost REAL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','auto','pending','approved','rejected')),
    decided_by INTEGER REFERENCES users(id),
    decided_at TEXT,
    decision_note TEXT,
    UNIQUE (count_id, product_id)
  );
  CREATE INDEX idx_count_lines_status ON count_lines(status);
  `,
  },
  // v5: campaign shelf colours, gazebo / banner categories, setups & strike downs, setup photos
  `
  ALTER TABLE campaigns ADD COLUMN colour TEXT;
  -- The campaign a product is shelved for, so its shelf can carry that campaign's colour
  ALTER TABLE products ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id);
  UPDATE products SET category = 'Gazebo' WHERE lower(name) LIKE '%gazebo%';

  -- A setup job: equipment goes out to a venue, gets built, and is struck down and brought back later
  CREATE TABLE setups (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    venue TEXT NOT NULL,
    address TEXT,
    contact TEXT,
    setup_at TEXT NOT NULL,
    strike_at TEXT,
    lead_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled','loaded','set_up','struck','returned','cancelled')),
    notes TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    loaded_by INTEGER REFERENCES users(id),
    loaded_at TEXT,
    set_up_by INTEGER REFERENCES users(id),
    set_up_at TEXT,
    set_up_lat REAL,
    set_up_lng REAL,
    struck_by INTEGER REFERENCES users(id),
    struck_at TEXT,
    struck_lat REAL,
    struck_lng REAL,
    returned_by INTEGER REFERENCES users(id),
    returned_at TEXT
  );
  CREATE INDEX idx_setups_dates ON setups(setup_at, strike_at);
  CREATE TABLE setup_crew (
    setup_id INTEGER NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (setup_id, user_id)
  );
  CREATE TABLE setup_items (
    id INTEGER PRIMARY KEY,
    setup_id INTEGER NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL CHECK (qty > 0),
    qty_out INTEGER,
    qty_good INTEGER,
    qty_damaged INTEGER,
    UNIQUE (setup_id, product_id)
  );

  -- Attachments can now belong to a setup (proof photos); widen the kind list
  CREATE TABLE attachments_v5 (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('receipt','request','return','setup')),
    reference TEXT,
    warehouse_id INTEGER REFERENCES warehouses(id),
    request_id INTEGER REFERENCES requests(id),
    return_id INTEGER REFERENCES returns(id),
    setup_id INTEGER REFERENCES setups(id),
    caption TEXT,
    filename TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    lat REAL,
    lng REAL,
    accuracy REAL
  );
  INSERT INTO attachments_v5 (id, kind, reference, warehouse_id, request_id, return_id, caption, filename, mime, size, data,
                              uploaded_by, created_at, lat, lng, accuracy)
    SELECT id, kind, reference, warehouse_id, request_id, return_id, caption, filename, mime, size, data,
           uploaded_by, created_at, lat, lng, accuracy FROM attachments;
  DROP TABLE attachments;
  ALTER TABLE attachments_v5 RENAME TO attachments;
  CREATE INDEX idx_attachments_ref ON attachments(kind, reference);

  -- Count approvals are by units only (no money in the system)
  DELETE FROM settings WHERE key = 'count_tolerance_value';
  `,

  // v6: packs (6-packs, boxes of 24) with their own QR codes, and scanning stock out of the warehouse
  `
  CREATE TABLE product_packs (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty >= 2),
    barcode TEXT UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (product_id, qty)
  );

  -- Every label scanned as stock leaves (dispatch, counter issue, setup load-out, transfer)
  CREATE TABLE scans_out (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('request','setup','transfer')),
    reference TEXT NOT NULL,
    warehouse_id INTEGER REFERENCES warehouses(id),
    code TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    pack_id INTEGER REFERENCES product_packs(id),
    units INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_scans_out_ref ON scans_out(kind, reference);

  -- One per load-out: did the scans match, or did a manager release it without a full scan?
  CREATE TABLE scan_checks (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('request','setup','transfer')),
    reference TEXT NOT NULL,
    warehouse_id INTEGER REFERENCES warehouses(id),
    expected_units INTEGER NOT NULL,
    scanned_units INTEGER NOT NULL,
    matched INTEGER NOT NULL,
    override_reason TEXT,
    differences TEXT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_scan_checks_ref ON scan_checks(kind, reference);
  `,

  // v7: BA collection/return form (ID number, stock condition, manager check, cleared for payment) and messaging
  `
  ALTER TABLE users ADD COLUMN id_number TEXT;
  ALTER TABLE handovers ADD COLUMN stock_condition TEXT CHECK (stock_condition IN ('good','average','poor'));

  -- Office use on the BA form: one per promoter per campaign
  CREATE TABLE ba_clearances (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    promoter_id INTEGER NOT NULL REFERENCES users(id),
    checked_by INTEGER REFERENCES users(id),
    checked_at TEXT,
    check_comment TEXT,
    cleared_by INTEGER REFERENCES users(id),
    cleared_at TEXT,
    clear_comment TEXT,
    PRIMARY KEY (campaign_id, promoter_id)
  );

  -- Messages. thread is 'request:<id>', 'setup:<id>', 'return:<id>', 'campaign:<id>' (team chat),
  -- 'dm:<lowId>:<highId>' (between two people) or 'notice' (notice board for everyone)
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    thread TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_messages_thread ON messages(thread, id);
  CREATE TABLE message_reads (
    user_id INTEGER NOT NULL REFERENCES users(id),
    thread TEXT NOT NULL,
    last_read_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, thread)
  );
  `,
];

function migrate(db) {
  // Version 0 means either a brand-new file or one made before versioning; SCHEMA is idempotent for both.
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    db.exec(SCHEMA);
    db.exec('PRAGMA user_version = 1');
    version = 1;
  }
  for (let v = version; v <= MIGRATIONS.length; v++) {
    const step = typeof MIGRATIONS[v - 1] === 'string' ? { sql: MIGRATIONS[v - 1] } : MIGRATIONS[v - 1];
    // foreign_keys can only be toggled outside a transaction
    if (step.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        db.exec(step.sql);
        if (step.foreignKeysOff && db.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error(`Database upgrade to version ${v + 1} would break foreign keys`);
        }
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      if (step.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

/** Run fn inside a transaction; rolls back on any thrown error. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, tx, SCHEMA, SCHEMA_VERSION: MIGRATIONS.length + 1 };
