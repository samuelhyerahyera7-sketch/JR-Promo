'use strict';

/**
 * Vercel entry point. The database is PostgreSQL (Supabase) at DATABASE_URL, so
 * everything is kept between requests and deployments. The first request on a
 * fresh instance connects and checks the schema; later requests reuse it.
 */

const { start } = require('../src/bootstrap');

let ready = null;

module.exports = async (req, res) => {
  if (!ready) {
    ready = start().catch((err) => {
      ready = null;
      throw err;
    });
  }
  try {
    const { app } = await ready;
    return app(req, res);
  } catch (err) {
    console.error(err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'The database is not reachable right now. Please try again in a minute.' }));
  }
};
