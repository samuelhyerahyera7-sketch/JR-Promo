'use strict';

const { open } = require('./db');
const { createApp } = require('./app');
const { seed } = require('./seed');
const { hashPassword } = require('./auth');

/**
 * Connect, bring the schema up to date and, on an empty database, either create
 * the first director (ADMIN_EMAIL / ADMIN_PASSWORD) or load the demo data.
 * Safe when several servers start at once: only one does the first-run setup.
 */
async function start(url = process.env.DATABASE_URL) {
  const db = await open(url);
  await db.tx(async () => {
    await db.exec('SELECT pg_advisory_xact_lock(4712)');
    if ((await db.get('SELECT COUNT(*) AS n FROM users')).n > 0) return;
    const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
      // Production start: one director account, no demo data
      await db.run("INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, 'director', ?)", ADMIN_NAME || 'Director', ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD));
      console.log(`Created director account ${ADMIN_EMAIL}`);
    } else {
      await seed(db);
      console.log('Empty database: loaded demo data (all demo passwords are "password123")');
    }
  });
  return { db, app: createApp(db) };
}

module.exports = { start };
