'use strict';

const path = require('node:path');
const { open } = require('./db');
const { createApp } = require('./app');
const { seed } = require('./seed');
const { hashPassword } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'jr-promo.db');

const db = open(DB_FILE);
const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
if (n === 0) {
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    // Production start: one director account, no demo data
    db.prepare("INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, 'director', ?)").run(
      ADMIN_NAME || 'Director',
      ADMIN_EMAIL,
      hashPassword(ADMIN_PASSWORD),
    );
    console.log(`Created director account ${ADMIN_EMAIL}`);
  } else {
    seed(db);
    console.log('Empty database: loaded demo data (all demo passwords are "password123")');
  }
}

createApp(db).listen(PORT, () => {
  console.log(`JR Promotions stock system running on http://localhost:${PORT}`);
});
