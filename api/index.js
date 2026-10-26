'use strict';

/**
 * Vercel entry point for the online demo. Serverless functions have no
 * permanent disk, so the database lives in /tmp and is filled with demo data
 * whenever a fresh instance starts. Nothing entered here is kept long-term.
 * For real use, run `npm start` on a server with a persistent disk.
 */

const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

const db = open(process.env.DB_FILE || '/tmp/jr-promo-demo.db');
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) seed(db);

module.exports = createApp(db);
