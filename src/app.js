'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, authenticate } = require('./auth');
const { authRoutes, sessionRoutes, userRoutes, warehouseRoutes, clientRoutes } = require('./routes/admin');
const { productRoutes, stockRoutes } = require('./routes/inventory');
const { campaignRoutes } = require('./routes/campaigns');
const { requestRoutes, returnRoutes, usageRoutes } = require('./routes/workflow');
const { dashboardRoutes } = require('./routes/dashboard');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes(db));

  const api = express.Router();
  api.use(authenticate(db));
  api.use('/auth', sessionRoutes(db));
  api.use('/users', userRoutes(db));
  api.use('/warehouses', warehouseRoutes(db));
  api.use('/clients', clientRoutes(db));
  api.use('/products', productRoutes(db));
  api.use('/stock', stockRoutes(db));
  api.use('/campaigns', campaignRoutes(db));
  api.use('/requests', requestRoutes(db));
  api.use('/returns', returnRoutes(db));
  api.use('/usage', usageRoutes(db));
  api.use('/dashboard', dashboardRoutes(db));
  app.use('/api', api);

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Request body is not valid JSON');
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
  });

  return app;
}

module.exports = { createApp };
