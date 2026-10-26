'use strict';

const crypto = require('node:crypto');

const SESSION_DAYS = 14;

const ROLES = ['director', 'office', 'account_manager', 'warehouse_manager', 'warehouse', 'promoter'];
// Directors and office staff run the business and see everything.
const MANAGEMENT = ['director', 'office'];
// Everyone who works the warehouse floor (manager included) can receive, pick, dispatch and check in
const WAREHOUSE = ['warehouse_manager', 'warehouse'];
// Who may approve stock-count differences and write-offs
const STOCK_APPROVERS = [...MANAGEMENT, 'warehouse_manager'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

function readToken(req) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookie = req.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)jr_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

function authenticate(db) {
  const stmt = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.region, u.phone, u.warehouse_id, u.gender, u.uniform_size, u.badge_code
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, res, next) => {
    const token = readToken(req);
    const user = token && stmt.get(token, new Date().toISOString());
    if (!user) return next(new HttpError(401, 'Please sign in'));
    req.user = { ...user };
    req.token = token;
    next();
  };
}

/** Express middleware: allow only the listed roles. */
function allow(...roles) {
  const set = new Set(roles.flat(Infinity));
  return (req, res, next) => {
    if (!set.has(req.user.role)) return next(new HttpError(403, 'You do not have access to this'));
    next();
  };
}

const isManagement = (user) => MANAGEMENT.includes(user.role);
const isWarehouse = (user) => WAREHOUSE.includes(user.role);
const isStockApprover = (user) => STOCK_APPROVERS.includes(user.role);

module.exports = {
  ROLES,
  MANAGEMENT,
  WAREHOUSE,
  STOCK_APPROVERS,
  HttpError,
  hashPassword,
  verifyPassword,
  createSession,
  readToken,
  authenticate,
  allow,
  isManagement,
  isWarehouse,
  isStockApprover,
};
