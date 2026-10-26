'use strict';

const express = require('express');
const { MANAGEMENT, HttpError } = require('../auth');
const v = require('../validate');
const { assertCampaign } = require('../access');
const { loadRequest, loadReturn } = require('./workflow');
const { loadSetup } = require('./setups');

// Who can post on the notice board everyone reads
const NOTICE_POSTERS = [...MANAGEMENT, 'account_manager', 'warehouse_manager'];
const ROLE_LABEL = { director: 'Director', office: 'Office', account_manager: 'Account manager', warehouse_manager: 'Warehouse manager', warehouse: 'Warehouse', promoter: 'Promoter' };

/**
 * Message threads hang off things people already work on:
 *   request:<id> / setup:<id> / return:<id>  chat about that job, for everyone who can see it
 *   campaign:<id>                            the campaign team (promoters, account manager, warehouse, office)
 *   dm:<low>:<high>                          two people
 *   notice                                   notice board for everyone
 * Access follows the same rules as the thing itself. Throws 404 if the user may not see it.
 */
async function threadInfo(db, user, thread) {
  const [kind, a, b] = String(thread || '').split(':');
  const id = Number(a);
  if (kind === 'notice' && a === undefined) return { title: 'Notice board', link: null, can_post: NOTICE_POSTERS.includes(user.role) };
  if (kind === 'request') {
    const q = await loadRequest(db, user, id);
    return { title: `${q.ref} · ${q.promoter_name}`, subtitle: q.campaign_name, link: `requests/${q.id}`, can_post: true };
  }
  if (kind === 'setup') {
    const s = await loadSetup(db, user, id);
    return { title: `${s.ref} · ${s.venue}`, subtitle: s.campaign_name, link: `setups/${s.id}`, can_post: true };
  }
  if (kind === 'return') {
    const r = await loadReturn(db, user, id);
    return { title: `${r.ref} · ${r.promoter_name}`, subtitle: r.campaign_name, link: 'returns', can_post: true };
  }
  if (kind === 'campaign') {
    const c = await assertCampaign(db, user, id);
    return { title: `${c.name} team`, subtitle: 'Campaign chat', link: `campaigns/${c.id}`, can_post: true };
  }
  if (kind === 'dm') {
    const [low, high] = [Number(a), Number(b)];
    if (!(low < high) || (user.id !== low && user.id !== high)) throw new HttpError(404, 'Conversation not found');
    const other = (await db.get('SELECT id, name, role, phone, active FROM users WHERE id = ?', user.id === low ? high : low));
    if (!other) throw new HttpError(404, 'Conversation not found');
    return {
      title: other.name,
      subtitle: ROLE_LABEL[other.role],
      link: null,
      can_post: !!other.active,
      phone: user.role === 'promoter' && other.role === 'promoter' ? null : other.phone,
    };
  }
  throw new HttpError(404, 'Conversation not found');
}

/** Can these two message each other? Promoters talk to staff, not to each other (their numbers stay private). */
function assertCanDm(user, other) {
  if (!other || !other.active) throw new HttpError(404, 'Person not found');
  if (other.id === user.id) throw new HttpError(400, "You can't message yourself");
  if (user.role === 'promoter' && other.role === 'promoter') throw new HttpError(403, 'Promoters can message staff, or each other in their campaign team chat');
}

const dmThread = (x, y) => `dm:${Math.min(x, y)}:${Math.max(x, y)}`;

async function inbox(db, user) {
  const threads = (await db.all(`SELECT m.thread, MAX(m.id) AS last_id,
         COALESCE(SUM(CASE WHEN m.id > COALESCE(r.last_read_id, 0) AND m.user_id != :me THEN 1 ELSE 0 END), 0) AS unread
       FROM messages m LEFT JOIN message_reads r ON r.thread = m.thread AND r.user_id = :me
       GROUP BY m.thread ORDER BY last_id DESC`, { me: user.id }));
  const lastMsg = db.stmt('SELECT m.body, m.created_at, m.user_id, u.name AS user_name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?');
  const out = [];
  for (const t of threads) {
    // Direct messages are only ever listed for the two people in them
    if (t.thread.startsWith('dm:') && !t.thread.split(':').slice(1).map(Number).includes(user.id)) continue;
    let info;
    try {
      info = await threadInfo(db, user, t.thread);
    } catch {
      continue;
    }
    out.push({ thread: t.thread, ...info, last: await lastMsg.get(t.last_id), unread: t.unread });
  }
  return out;
}

function messageRoutes(db) {
  const r = express.Router();

  r.get('/inbox', async (req, res) => res.json(await inbox(db, req.user)));

  r.get('/unread', async (req, res) => res.json({ count: (await inbox(db, req.user)).reduce((a, t) => a + t.unread, 0) }));

  // People you can start a conversation with
  r.get('/people', async (req, res) => {
    const rows = (await db.all(`SELECT u.id, u.name, u.role, u.region, w.name AS warehouse_name FROM users u LEFT JOIN warehouses w ON w.id = u.warehouse_id
         WHERE u.active = 1 AND u.id != ? ${req.user.role === 'promoter' ? "AND u.role != 'promoter'" : ''}
         ORDER BY CASE u.role WHEN 'promoter' THEN 1 ELSE 0 END, u.name`, req.user.id));
    res.json(rows.map((u) => ({ ...u, role_label: ROLE_LABEL[u.role] })));
  });

  r.get('/thread', async (req, res) => {
    const thread = v.str(req.query.thread, 'Conversation', { required: true, max: 40 });
    const info = await threadInfo(db, req.user, thread);
    const messages = (await db.all(`SELECT m.id, m.user_id, m.body, m.created_at, u.name AS user_name, u.role AS user_role
         FROM messages m JOIN users u ON u.id = m.user_id WHERE m.thread = ? ORDER BY m.id DESC LIMIT 200`, thread))
      .reverse();
    for (const m of messages) m.role_label = ROLE_LABEL[m.user_role];
    if (messages.length) {
      (await db.run(`INSERT INTO message_reads (user_id, thread, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT (user_id, thread) DO UPDATE SET last_read_id = GREATEST(message_reads.last_read_id, excluded.last_read_id)`, req.user.id, thread, messages[messages.length - 1].id));
    }
    res.json({ thread, ...info, messages });
  });

  r.post('/', async (req, res) => {
    let thread = v.str(req.body.thread, 'Conversation', { max: 40 });
    const to = v.int(req.body.to, 'Person');
    if (to) {
      assertCanDm(req.user, (await db.get('SELECT id, role, active FROM users WHERE id = ?', to)));
      thread = dmThread(req.user.id, to);
    }
    if (!thread) throw new HttpError(400, 'Choose who the message is for');
    const info = await threadInfo(db, req.user, thread);
    if (!info.can_post) throw new HttpError(403, thread === 'notice' ? 'Only managers and the office can post on the notice board' : 'You can’t post here');
    const body = v.str(req.body.body, 'Message', { required: true, max: 2000 });
    const id = (await db.insert('INSERT INTO messages (thread, user_id, body) VALUES (?, ?, ?)', thread, req.user.id, body));
    (await db.run(`INSERT INTO message_reads (user_id, thread, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id, thread) DO UPDATE SET last_read_id = excluded.last_read_id`, req.user.id, thread, id));
    res.status(201).json({ id, thread });
  });

  return r;
}

module.exports = { messageRoutes, dmThread };
