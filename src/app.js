import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authenticate } from './auth.js';
import { HttpError } from './util.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin.js';
import { integrationRoutes } from './routes/integrations.js';
import { createGateway } from './services/payments.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ db, gateway = createGateway(), secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex') } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors *",
    });
    next();
  });

  // The public catalog API is CORS-enabled so the McCoy Center website (and
  // any other agency site) can render listings directly.
  app.use('/api', (req, res, next) => {
    const allowed = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());
    const origin = req.get('origin');
    if (origin && (allowed.includes('*') || allowed.includes(origin))) {
      res.set('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(authenticate(db, secret));

  app.get('/api/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', time: new Date().toISOString(), payment_provider: gateway.name });
  });

  app.use('/api', publicRoutes({ db, gateway, secret }));
  app.use('/api', integrationRoutes({ db, gateway }));
  app.use('/api/admin', adminRoutes({ db, gateway }));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 && !(err instanceof HttpError) ? 'Internal server error' : err.message;
    res.status(status).json({ error: message, ...(err.details ? { details: err.details } : {}) });
  });

  return app;
}
