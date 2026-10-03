import express from 'express';
import QRCode from 'qrcode';
import { hashPassword, issueToken, requireUser, verifyPassword } from '../auth.js';
import { HttpError, asyncRouter, badRequest, isEmail, notFound, requireFields } from '../util.js';
import { availability, getPerformance, holdSeats, releaseSeats, salesStatus, seatMap, HOLD_MINUTES } from '../services/inventory.js';
import { checkout, getOrder, priceCart } from '../services/orders.js';
import { acceptTransfer, cancelTransfer, getTransfer, startTransfer, ticketByCode, ticketsForEmail } from '../services/tickets.js';

export function publicRoutes({ db, gateway, secret }) {
  const r = asyncRouter(express);
  const baseUrl = (req) => process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

  function performanceSummary(p) {
    const avail = availability(db, p);
    const levels = db.prepare('SELECT id, name, zone, price_cents, fee_cents FROM price_levels WHERE performance_id = ? AND public = 1 ORDER BY price_cents DESC').all(p.id);
    return {
      id: p.id, event_id: p.event_id, starts_at: p.starts_at, seating_mode: p.seating_mode, stage_name: p.stage_name, venue_name: p.venue_name, venue_id: p.venue_id,
      max_per_order: p.max_per_order, on_sale_at: p.on_sale_at, off_sale_at: p.off_sale_at,
      sales_status: salesStatus(p), available: avail.available, capacity: avail.capacity, price_levels: levels,
      min_price_cents: levels.length ? Math.min(...levels.map((l) => l.price_cents)) : null,
    };
  }

  // ---- Catalog -----------------------------------------------------------
  r.get('/venues', (_req, res) => {
    const venues = db.prepare('SELECT * FROM venues ORDER BY name').all();
    for (const v of venues) v.stages = db.prepare('SELECT id, name, seating_type, ga_capacity FROM stages WHERE venue_id = ?').all(v.id);
    res.json(venues);
  });

  r.get('/events', (req, res) => {
    const { venue_id, category, q } = req.query;
    const events = db.prepare(`SELECT DISTINCT e.id, e.title, e.description, e.category, e.image_url FROM events e
      JOIN performances p ON p.event_id = e.id JOIN stages s ON s.id = p.stage_id
      WHERE e.status = 'published' AND p.status = 'scheduled' AND p.starts_at > datetime('now')
        AND (? IS NULL OR s.venue_id = ?) AND (? IS NULL OR e.category = ?) AND (? IS NULL OR e.title LIKE '%' || ? || '%')
      ORDER BY (SELECT MIN(starts_at) FROM performances WHERE event_id = e.id AND starts_at > datetime('now'))`)
      .all(venue_id ?? null, venue_id ?? null, category ?? null, category ?? null, q ?? null, q ?? null);
    for (const e of events) {
      const perfs = db.prepare("SELECT id FROM performances WHERE event_id = ? AND status = 'scheduled' AND starts_at > datetime('now') ORDER BY starts_at").all(e.id);
      e.performances = perfs.map((p) => performanceSummary(getPerformance(db, p.id)));
      const prices = e.performances.map((p) => p.min_price_cents).filter((x) => x != null);
      e.min_price_cents = prices.length ? Math.min(...prices) : null;
      e.venues = [...new Set(e.performances.map((p) => p.venue_name))];
    }
    res.json(events);
  });

  r.get('/events/:id', (req, res) => {
    const e = db.prepare("SELECT id, title, description, category, image_url FROM events WHERE id = ? AND status = 'published'").get(req.params.id);
    if (!e) throw notFound('Event');
    const perfs = db.prepare("SELECT id FROM performances WHERE event_id = ? AND status = 'scheduled' ORDER BY starts_at").all(e.id);
    e.performances = perfs.map((p) => performanceSummary(getPerformance(db, p.id)));
    e.series = db.prepare(`SELECT DISTINCT s.id, s.name, s.kind FROM series s JOIN series_performances sp ON sp.series_id = s.id
      JOIN performances p ON p.id = sp.performance_id WHERE p.event_id = ? AND s.status = 'published'`).all(e.id);
    res.json(e);
  });

  r.get('/performances/:id', (req, res) => {
    const p = getPerformance(db, req.params.id);
    if (p.event_status !== 'published') throw notFound('Performance');
    res.json({ ...performanceSummary(p), event_title: p.event_title, image_url: p.image_url });
  });

  r.get('/performances/:id/seats', (req, res) => {
    const p = getPerformance(db, req.params.id);
    if (p.event_status !== 'published') throw notFound('Performance');
    res.json({ sections: seatMap(db, p, req.query.cart_token) });
  });

  r.post('/performances/:id/holds', (req, res) => {
    const p = getPerformance(db, req.params.id);
    const status = salesStatus(p);
    const staff = req.user && ['admin', 'boxoffice'].includes(req.user.role);
    if (status !== 'on_sale' && !(staff && ['not_yet_on_sale', 'off_sale', 'past'].includes(status))) throw new HttpError(409, `Not on sale: ${status}`);
    const seatIds = (req.body.seat_ids || []).map(Number);
    if (!seatIds.length) throw badRequest('seat_ids required');
    const mine = db.prepare('SELECT COUNT(*) AS n FROM seat_holds WHERE performance_id = ? AND cart_token = ?').get(p.id, req.body.cart_token || '').n;
    if (!staff && mine + seatIds.length > p.max_per_order) throw badRequest(`Maximum ${p.max_per_order} seats per order`);
    res.json({ ...holdSeats(db, p, seatIds, req.body.cart_token), hold_minutes: HOLD_MINUTES });
  });

  r.delete('/performances/:id/holds', (req, res) => {
    releaseSeats(db, Number(req.params.id), (req.body.seat_ids || []).map(Number), req.body.cart_token);
    res.json({ ok: true });
  });

  r.get('/series', (_req, res) => {
    const series = db.prepare("SELECT id, name, description, kind, price_cents, fee_cents, on_sale_at, off_sale_at, max_per_order FROM series WHERE status = 'published' ORDER BY name").all();
    for (const s of series) {
      s.performances = db.prepare(`SELECT p.id, p.starts_at, e.id AS event_id, e.title AS event_title, st.name AS stage_name, v.name AS venue_name
        FROM series_performances sp JOIN performances p ON p.id = sp.performance_id JOIN events e ON e.id = p.event_id
        JOIN stages st ON st.id = p.stage_id JOIN venues v ON v.id = st.venue_id WHERE sp.series_id = ? ORDER BY p.starts_at`).all(s.id);
    }
    res.json(series);
  });

  r.get('/funds', (_req, res) => {
    res.json(db.prepare('SELECT id, name, entity_name, ein, tax_deductible, description FROM funds WHERE active = 1 ORDER BY id').all());
  });

  // ---- Cart & checkout ---------------------------------------------------
  r.post('/cart/quote', (req, res) => {
    const staff = req.user && ['admin', 'boxoffice'].includes(req.user.role);
    const priced = priceCart(db, req.body, { staff });
    res.json({ lines: priced.lines.map((l) => ({ ...l, amount: l.unit * l.quantity })), totals: priced.totals, ticket_count: priced.tickets.length });
  });

  r.post('/checkout', async (req, res) => {
    const result = await checkout(db, gateway, req.body, { user: req.user, apiKey: req.apiKey, baseUrl: baseUrl(req) });
    res.status(201).json(result.order);
  });

  r.post('/orders/lookup', (req, res) => {
    requireFields(req.body, ['order_number', 'email']);
    const order = db.prepare('SELECT id, email FROM orders WHERE order_number = ?').get(String(req.body.order_number).trim());
    if (!order || order.email.toLowerCase() !== String(req.body.email).trim().toLowerCase()) throw notFound('Order');
    res.json(getOrder(db, order.id));
  });

  // ---- Mobile tickets, transfers ----------------------------------------
  r.get('/tickets/:code', (req, res) => res.json(ticketByCode(db, req.params.code)));

  r.get('/tickets/:code/qr.svg', async (req, res) => {
    const t = ticketByCode(db, req.params.code);
    const svg = await QRCode.toString(t.code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  });

  r.post('/tickets/:code/transfer', (req, res) => res.status(201).json(startTransfer(db, req.params.code, req.body, baseUrl(req))));
  r.delete('/tickets/:code/transfer', (req, res) => res.json(cancelTransfer(db, req.params.code)));
  r.get('/transfers/:token', (req, res) => res.json(getTransfer(db, req.params.token)));
  r.post('/transfers/:token/accept', (req, res) => res.json(acceptTransfer(db, req.params.token, baseUrl(req))));

  // ---- Accounts ----------------------------------------------------------
  r.post('/auth/register', (req, res) => {
    requireFields(req.body, ['email', 'name', 'password']);
    const email = String(req.body.email).trim().toLowerCase();
    if (!isEmail(email)) throw badRequest('Invalid email');
    if (String(req.body.password).length < 8) throw badRequest('Password must be at least 8 characters');
    const existing = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
    // Box office and POS sales create password-less customer records; let the
    // customer claim that record by registering.
    if (existing?.password_hash) throw new HttpError(409, 'An account with this email already exists');
    let id;
    if (existing) {
      db.prepare('UPDATE users SET name = ?, password_hash = ?, phone = COALESCE(?, phone), marketing_opt_in = ? WHERE id = ?')
        .run(req.body.name, hashPassword(req.body.password), req.body.phone || null, req.body.marketing_opt_in ? 1 : 0, existing.id);
      id = existing.id;
    } else {
      id = db.prepare('INSERT INTO users (email, name, phone, postal_code, password_hash, marketing_opt_in) VALUES (?, ?, ?, ?, ?, ?)')
        .run(email, req.body.name, req.body.phone || null, req.body.postal_code || null, hashPassword(req.body.password), req.body.marketing_opt_in ? 1 : 0).lastInsertRowid;
    }
    db.prepare('UPDATE orders SET user_id = ? WHERE email = ? AND user_id IS NULL').run(id, email);
    const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(id);
    res.status(201).json({ token: issueToken(secret, id), user });
  });

  r.post('/auth/login', (req, res) => {
    requireFields(req.body, ['email', 'password']);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body.email).trim().toLowerCase());
    if (!user || !verifyPassword(String(req.body.password), user.password_hash)) throw new HttpError(401, 'Invalid email or password');
    res.json({ token: issueToken(secret, user.id), user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  r.get('/me', requireUser, (req, res) => res.json(req.user));

  r.patch('/me', requireUser, (req, res) => {
    const { name, phone, marketing_opt_in } = req.body;
    db.prepare('UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone), marketing_opt_in = COALESCE(?, marketing_opt_in) WHERE id = ?')
      .run(name ?? null, phone ?? null, marketing_opt_in == null ? null : marketing_opt_in ? 1 : 0, req.user.id);
    res.json(db.prepare('SELECT id, email, name, role, phone, marketing_opt_in FROM users WHERE id = ?').get(req.user.id));
  });

  r.get('/me/tickets', requireUser, (req, res) => res.json(ticketsForEmail(db, req.user.email)));

  r.get('/me/orders', requireUser, (req, res) => {
    const ids = db.prepare('SELECT id FROM orders WHERE email = ? OR user_id = ? ORDER BY id DESC').all(req.user.email, req.user.id);
    res.json(ids.map((o) => getOrder(db, o.id)));
  });

  // One-click unsubscribe link used in marketing email footers.
  r.post('/unsubscribe', (req, res) => {
    if (!isEmail(req.body.email)) throw badRequest('Valid email required');
    db.prepare('UPDATE users SET marketing_opt_in = 0 WHERE email = ?').run(String(req.body.email).toLowerCase());
    res.json({ ok: true });
  });

  // ---- Support -----------------------------------------------------------
  r.post('/support', (req, res) => {
    requireFields(req.body, ['name', 'email', 'subject', 'message']);
    if (!isEmail(req.body.email)) throw badRequest('Invalid email');
    const priority = ['low', 'normal', 'high', 'urgent'].includes(req.body.priority) ? req.body.priority : 'normal';
    const id = db.prepare('INSERT INTO support_requests (name, email, subject, message, priority) VALUES (?, ?, ?, ?, ?)')
      .run(req.body.name, req.body.email, String(req.body.subject).slice(0, 200), String(req.body.message).slice(0, 5000), priority).lastInsertRowid;
    res.status(201).json({ id, status: 'open' });
  });

  return r;
}
