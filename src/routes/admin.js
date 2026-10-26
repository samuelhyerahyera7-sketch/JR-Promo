'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { ROLES, MANAGEMENT, WAREHOUSE, HttpError, hashPassword, verifyPassword, createSession, allow, isManagement } = require('../auth');
const v = require('../validate');
const { clientScope } = require('../access');

const USER_COLUMNS =
  'u.id, u.name, u.email, u.phone, u.role, u.region, u.warehouse_id, u.gender, u.uniform_size, u.badge_code, u.id_number, u.active, u.created_at';
const newBadge = () => crypto.randomBytes(10).toString('hex');

/** SA (13 digits), Namibian (11) or passport numbers: letters and digits only. */
function idNumber(value) {
  const id = v.str(value, 'ID / passport number', { max: 20 });
  if (id && !/^[A-Za-z0-9]{6,20}$/.test(id.replace(/\s/g, ''))) throw new HttpError(400, 'ID / passport number can only contain letters and digits');
  return id ? id.replace(/\s/g, '').toUpperCase() : null;
}

function authRoutes(db) {
  const r = express.Router();

  r.post('/login', (req, res) => {
    const email = v.str(req.body.email, 'Email', { required: true });
    const password = v.str(req.body.password, 'Password', { required: true });
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Incorrect email or password');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    const token = createSession(db, user.id);
    res.cookie('jr_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 14 * 864e5 });
    res.json({ token, user: publicUser(user) });
  });

  return r;
}

function sessionRoutes(db) {
  const r = express.Router();

  r.get('/me', (req, res) => res.json(req.user));

  r.post('/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.clearCookie('jr_session');
    res.json({ ok: true });
  });

  r.post('/password', (req, res) => {
    const current = v.str(req.body.current, 'Current password', { required: true });
    const next = v.str(req.body.next, 'New password', { required: true });
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, row.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.token);
    res.json({ ok: true });
  });

  return r;
}

function publicUser(u) {
  const { password_hash, ...rest } = u;
  return rest;
}

// Warehouse managers look after their floor staff and the promoters who collect from them
const MANAGER_CAN_MANAGE = ['warehouse', 'promoter'];
const USER_ADMINS = ['director', 'warehouse_manager'];

/** Throws unless the signed-in user may give an account this role. */
function assertCanManageRole(actor, role) {
  if (actor.role === 'director') return;
  if (actor.role === 'warehouse_manager' && MANAGER_CAN_MANAGE.includes(role)) return;
  throw new HttpError(403, 'Warehouse managers can only manage warehouse staff and promoter accounts');
}

function userRoutes(db) {
  const r = express.Router();

  // Account managers need the promoter list to staff campaigns; warehouse needs it to see who stock goes to.
  r.get('/', allow(MANAGEMENT, 'account_manager', WAREHOUSE), (req, res) => {
    const where = ['1=1'];
    const params = [];
    if (req.user.role === 'warehouse_manager') where.push("u.role IN ('warehouse_manager', 'warehouse', 'promoter')");
    else if (!isManagement(req.user)) where.push("u.role = 'promoter' AND u.active = 1");
    if (req.query.role) {
      where.push('u.role = ?');
      params.push(req.query.role);
    }
    const rows = db
      .prepare(
        `SELECT ${USER_COLUMNS}, w.name AS warehouse_name FROM users u
         LEFT JOIN warehouses w ON w.id = u.warehouse_id
         WHERE ${where.join(' AND ')} ORDER BY u.active DESC, u.role, u.name`,
      )
      .all(...params);
    if (req.user.role === 'account_manager') for (const row of rows) delete row.badge_code;
    // ID numbers are personal information: only management and the warehouse manager see them
    if (!USER_ADMINS.includes(req.user.role) && !isManagement(req.user)) for (const row of rows) delete row.id_number;
    res.json(rows);
  });

  r.post('/', allow(USER_ADMINS), (req, res) => {
    const b = req.body;
    assertCanManageRole(req.user, v.oneOf(b.role, 'Role', ROLES, { required: true }));
    const password = v.str(b.password, 'Password', { required: true });
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    const email = v.email(b.email, 'Email', { required: true });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already in use');
    const info = db
      .prepare(
        `INSERT INTO users (name, email, phone, role, region, warehouse_id, gender, uniform_size, badge_code, password_hash, id_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.str(b.name, 'Name', { required: true }),
        email,
        v.str(b.phone, 'Phone'),
        v.oneOf(b.role, 'Role', ROLES, { required: true }),
        v.str(b.region, 'Region'),
        v.int(b.warehouse_id, 'Warehouse'),
        v.oneOf(b.gender, 'Gender', ['female', 'male']),
        v.str(b.uniform_size, 'Uniform size', { max: 10 }),
        newBadge(),
        hashPassword(password),
        idNumber(b.id_number),
      );
    res.status(201).json(getUser(db, info.lastInsertRowid));
  });

  r.patch('/:id', allow(USER_ADMINS), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const user = v.found(getUser(db, id), 'User');
    const b = req.body;
    assertCanManageRole(req.user, user.role);
    const fields = {
      name: b.name !== undefined ? v.str(b.name, 'Name', { required: true }) : user.name,
      email: b.email !== undefined ? v.email(b.email, 'Email', { required: true }) : user.email,
      phone: b.phone !== undefined ? v.str(b.phone, 'Phone') : user.phone,
      role: b.role !== undefined ? v.oneOf(b.role, 'Role', ROLES, { required: true }) : user.role,
      region: b.region !== undefined ? v.str(b.region, 'Region') : user.region,
      warehouse_id: b.warehouse_id !== undefined ? v.int(b.warehouse_id, 'Warehouse') : user.warehouse_id,
      gender: b.gender !== undefined ? v.oneOf(b.gender, 'Gender', ['female', 'male']) : user.gender,
      uniform_size: b.uniform_size !== undefined ? v.str(b.uniform_size, 'Uniform size', { max: 10 }) : user.uniform_size,
      active: b.active !== undefined ? (b.active ? 1 : 0) : user.active,
      id_number: b.id_number !== undefined ? idNumber(b.id_number) : user.id_number,
    };
    assertCanManageRole(req.user, fields.role);
    if (id === req.user.id && (fields.active === 0 || fields.role !== user.role)) {
      throw new HttpError(400, 'You cannot deactivate or demote your own account');
    }
    const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(fields.email, id);
    if (clash) throw new HttpError(409, 'That email is already in use');
    db.prepare(
      'UPDATE users SET name=?, email=?, phone=?, role=?, region=?, warehouse_id=?, gender=?, uniform_size=?, active=?, id_number=? WHERE id=?',
    ).run(
      fields.name,
      fields.email,
      fields.phone,
      fields.role,
      fields.region,
      fields.warehouse_id,
      fields.gender,
      fields.uniform_size,
      fields.active,
      fields.id_number,
      id,
    );
    if (b.password) {
      if (String(b.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(b.password)), id);
    }
    if (!fields.active || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json(getUser(db, id));
  });

  // Lost or shared badge: issue a new QR code so the old one stops working
  r.post('/:id/badge', allow(MANAGEMENT, 'warehouse_manager'), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    const user = v.found(getUser(db, id), 'User');
    if (req.user.role === 'warehouse_manager') assertCanManageRole(req.user, user.role);
    db.prepare('UPDATE users SET badge_code = ? WHERE id = ?').run(newBadge(), id);
    res.json(getUser(db, id));
  });

  return r;
}

function getUser(db, id) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).get(id);
}

function warehouseRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT w.*,
             COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.warehouse_id = w.id), 0) AS units
           FROM warehouses w ORDER BY w.active DESC, w.name`,
        )
        .all(),
    );
  });

  const fields = (b) => [
    v.str(b.name, 'Name', { required: true }),
    v.str(b.city, 'City', { required: true }),
    v.str(b.province, 'Province', { required: true }),
    v.str(b.address, 'Address'),
    b.active === undefined ? 1 : b.active ? 1 : 0,
  ];

  r.post('/', allow(MANAGEMENT), (req, res) => {
    const info = db
      .prepare('INSERT INTO warehouses (name, city, province, address, active) VALUES (?, ?, ?, ?, ?)')
      .run(...fields(req.body));
    res.status(201).json(db.prepare('SELECT * FROM warehouses WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/:id', allow(MANAGEMENT), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    v.found(db.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(id), 'Warehouse');
    db.prepare('UPDATE warehouses SET name=?, city=?, province=?, address=?, active=? WHERE id=?').run(...fields(req.body), id);
    res.json(db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id));
  });

  return r;
}

function clientRoutes(db) {
  const r = express.Router();

  r.get('/', allow(MANAGEMENT, 'account_manager', WAREHOUSE), (req, res) => {
    const scope = clientScope(req.user);
    res.json(
      db
        .prepare(
          `SELECT cl.*, u.name AS account_manager_name,
             (SELECT COUNT(*) FROM products p WHERE p.client_id = cl.id AND p.active = 1) AS product_count,
             (SELECT COUNT(*) FROM campaigns c WHERE c.client_id = cl.id AND c.status = 'active') AS active_campaigns,
             COALESCE((SELECT SUM(s.qty) FROM stock s JOIN products p ON p.id = s.product_id
                       WHERE p.client_id = cl.id), 0) AS units
           FROM clients cl LEFT JOIN users u ON u.id = cl.account_manager_id
           WHERE ${scope.sql} ORDER BY cl.is_house DESC, cl.active DESC, cl.name`,
        )
        .all(...scope.params),
    );
  });

  const fields = (b) => {
    const amId = v.int(b.account_manager_id, 'Account manager');
    if (amId) {
      const am = db.prepare('SELECT role FROM users WHERE id = ?').get(amId);
      if (!am || am.role !== 'account_manager') throw new HttpError(400, 'Account manager must be a user with that role');
    }
    return [
      v.str(b.name, 'Client name', { required: true }),
      v.str(b.contact_name, 'Contact name'),
      v.email(b.contact_email, 'Contact email'),
      v.str(b.contact_phone, 'Contact phone'),
      amId,
      b.active === undefined ? 1 : b.active ? 1 : 0,
      b.is_house ? 1 : 0,
    ];
  };

  r.post('/', allow(MANAGEMENT), (req, res) => {
    const f = fields(req.body);
    if (db.prepare('SELECT 1 FROM clients WHERE name = ?').get(f[0])) throw new HttpError(409, 'A client with that name exists');
    const info = db
      .prepare(
        `INSERT INTO clients (name, contact_name, contact_email, contact_phone, account_manager_id, active, is_house)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...f);
    res.status(201).json(db.prepare('SELECT * FROM clients WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/:id', allow(MANAGEMENT), (req, res) => {
    const id = v.int(req.params.id, 'id', { required: true });
    v.found(db.prepare('SELECT 1 FROM clients WHERE id = ?').get(id), 'Client');
    db.prepare(
      'UPDATE clients SET name=?, contact_name=?, contact_email=?, contact_phone=?, account_manager_id=?, active=?, is_house=? WHERE id=?',
    ).run(...fields(req.body), id);
    res.json(db.prepare('SELECT * FROM clients WHERE id = ?').get(id));
  });

  return r;
}

module.exports = { authRoutes, sessionRoutes, userRoutes, warehouseRoutes, clientRoutes };
