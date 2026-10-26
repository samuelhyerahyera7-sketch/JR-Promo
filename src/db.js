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
    tx(db, () => {
      db.exec(MIGRATIONS[v - 1]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
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
