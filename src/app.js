'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, authenticate } = require('./auth');
const { authRoutes, sessionRoutes, userRoutes, warehouseRoutes, clientRoutes } = require('./routes/admin');
const { productRoutes, stockRoutes } = require('./routes/inventory');
const { campaignRoutes } = require('./routes/campaigns');
const { requestRoutes, returnRoutes, usageRoutes, handoverRoutes, counterRoutes } = require('./routes/workflow');
const { dashboardRoutes } = require('./routes/dashboard');
const { attachmentRoutes, deliveryRoutes } = require('./routes/attachments');
const { qrRoutes, kitRoutes } = require('./routes/misc');
const { reminderRoutes } = require('./routes/reminders');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  // Photo uploads (waybills) need a bigger body limit than everything else
  const smallJson = express.json({ limit: '1mb' });
  const uploadJson = express.json({ limit: '15mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/attachments') ? uploadJson : smallJson)(req, res, next));
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
  api.use('/handovers', handoverRoutes(db));
  api.use('/counter', counterRoutes(db));
  api.use('/attachments', attachmentRoutes(db));
  api.use('/deliveries', deliveryRoutes(db));
  api.use('/kits', kitRoutes(db));
  api.use('/reminders', reminderRoutes(db));
  api.use('/', qrRoutes(db));
  app.use('/api', api);

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));
  // QR decoder for phones without the browser BarcodeDetector API (e.g. iPhones)
  app.use('/vendor', express.static(path.dirname(require.resolve('jsqr')), { maxAge: '7d' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Request body is not valid JSON');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'That upload is too large');
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
  });

  return app;
}

module.exports = { createApp };
