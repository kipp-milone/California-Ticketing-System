import express from 'express';
import crypto from 'node:crypto';
import { hashPassword, requireRole, STAFF_ROLES } from '../auth.js';
import { transaction } from '../db.js';
import { HttpError, asyncRouter, badRequest, conflict, isEmail, notFound, requireFields, sha256, toCsv, toDbTime, toInt } from '../util.js';
import { availability, getPerformance, salesStatus } from '../services/inventory.js';
import { getOrder, refundOrder, TICKET_SELECT } from '../services/orders.js';
import { describeDatasets, OPERATORS, runQuery } from '../services/query.js';
import { queueEmail } from '../services/mailer.js';

export function adminRoutes({ db, gateway }) {
  const r = asyncRouter(express);
  const audit = (req, action, entity, id, detail) =>
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)').run(req.user?.id ?? null, action, entity, id ?? null, detail ? JSON.stringify(detail) : null);
  const anyStaff = requireRole(...STAFF_ROLES);
  const ops = requireRole('boxoffice');
  const finance = requireRole('finance');
  const marketing = requireRole('marketing');
  const admin = requireRole();

  // ---- Dashboard ---------------------------------------------------------
  r.get('/dashboard', anyStaff, (_req, res) => {
    const today = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents),0) AS revenue_cents FROM orders WHERE status = 'paid' AND date(created_at) = date('now')`).get();
    const totals = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents),0) AS revenue_cents, COALESCE(SUM(donation_cents),0) AS donation_cents FROM orders WHERE status = 'paid'`).get();
    const ticketsSold = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status != 'void'").get().n;
    const upcoming = db.prepare("SELECT id FROM performances WHERE status = 'scheduled' AND starts_at > datetime('now') ORDER BY starts_at LIMIT 12").all()
      .map(({ id }) => {
        const p = getPerformance(db, id);
        const a = availability(db, p);
        const scanned = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE performance_id = ? AND status = 'scanned'").get(id).n;
        const gross = db.prepare("SELECT COALESCE(SUM(price_cents),0) AS g FROM tickets WHERE performance_id = ? AND status != 'void'").get(id).g;
        return { id, event_title: p.event_title, starts_at: p.starts_at, venue_name: p.venue_name, stage_name: p.stage_name, seating_mode: p.seating_mode, sales_status: salesStatus(p), ...a, scanned, gross_cents: gross };
      });
    const openSupport = db.prepare("SELECT COUNT(*) AS n FROM support_requests WHERE status != 'resolved'").get().n;
    res.json({ today, totals, tickets_sold: ticketsSold, upcoming, open_support: openSupport });
  });

  // ---- Venues, stages, seating charts ------------------------------------
  r.get('/venues', anyStaff, (_req, res) => {
    const venues = db.prepare('SELECT * FROM venues ORDER BY id').all();
    for (const v of venues) {
      v.stages = db.prepare('SELECT * FROM stages WHERE venue_id = ? ORDER BY id').all(v.id);
      for (const s of v.stages) {
        s.sections = db.prepare(`SELECT sc.id, sc.name, sc.sort_order, COUNT(st.id) AS seat_count, GROUP_CONCAT(DISTINCT st.zone) AS zones
          FROM sections sc LEFT JOIN seats st ON st.section_id = sc.id WHERE sc.stage_id = ? GROUP BY sc.id ORDER BY sc.sort_order, sc.id`).all(s.id);
      }
    }
    res.json(venues);
  });

  r.post('/venues', admin, (req, res) => {
    requireFields(req.body, ['name']);
    const id = db.prepare('INSERT INTO venues (name, address, description) VALUES (?, ?, ?)').run(req.body.name, req.body.address || null, req.body.description || null).lastInsertRowid;
    audit(req, 'venue.create', 'venue', id);
    res.status(201).json(db.prepare('SELECT * FROM venues WHERE id = ?').get(id));
  });

  r.post('/venues/:id/stages', admin, (req, res) => {
    requireFields(req.body, ['name', 'seating_type']);
    if (!['assigned', 'general'].includes(req.body.seating_type)) throw badRequest('seating_type must be assigned or general');
    if (!db.prepare('SELECT 1 FROM venues WHERE id = ?').get(req.params.id)) throw notFound('Venue');
    const id = db.prepare('INSERT INTO stages (venue_id, name, seating_type, ga_capacity) VALUES (?, ?, ?, ?)')
      .run(req.params.id, req.body.name, req.body.seating_type, toInt(req.body.ga_capacity ?? 0, 'ga_capacity', { min: 0 })).lastInsertRowid;
    audit(req, 'stage.create', 'stage', id);
    res.status(201).json(db.prepare('SELECT * FROM stages WHERE id = ?').get(id));
  });

  // Generate a section of seats: rows ["A","B",...] x seats_per_row.
  r.post('/stages/:id/sections', admin, (req, res) => {
    requireFields(req.body, ['name', 'rows', 'seats_per_row']);
    const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(req.params.id);
    if (!stage) throw notFound('Stage');
    const rows = Array.isArray(req.body.rows) ? req.body.rows : String(req.body.rows).split(',').map((s) => s.trim()).filter(Boolean);
    const perRow = toInt(req.body.seats_per_row, 'seats_per_row', { min: 1, max: 200 });
    const zone = req.body.zone || 'A';
    const accessible = new Set((req.body.accessible_seats || []).map(String)); // e.g. ["A1","A2"]
    const id = transaction(db, () => {
      const sectionId = db.prepare('INSERT INTO sections (stage_id, name, sort_order) VALUES (?, ?, ?)').run(stage.id, req.body.name, toInt(req.body.sort_order ?? 0, 'sort_order')).lastInsertRowid;
      const stmt = db.prepare('INSERT INTO seats (section_id, row_label, seat_number, zone, accessible) VALUES (?, ?, ?, ?, ?)');
      for (const row of rows) for (let n = 1; n <= perRow; n++) stmt.run(sectionId, row, n, zone, accessible.has(`${row}${n}`) ? 1 : 0);
      return sectionId;
    });
    audit(req, 'section.create', 'section', id, { rows, perRow, zone });
    res.status(201).json({ id, seats: rows.length * perRow });
  });

  r.patch('/seats/zone', admin, (req, res) => {
    // Re-zone seats (e.g. make rows A-C "Premium").
    requireFields(req.body, ['section_id', 'rows', 'zone']);
    const rows = Array.isArray(req.body.rows) ? req.body.rows : String(req.body.rows).split(',').map((s) => s.trim());
    const info = db.prepare(`UPDATE seats SET zone = ? WHERE section_id = ? AND row_label IN (${rows.map(() => '?').join(',')})`).run(req.body.zone, req.body.section_id, ...rows);
    res.json({ updated: info.changes });
  });

  // ---- Events & performances ---------------------------------------------
  r.get('/events', anyStaff, (_req, res) => {
    const events = db.prepare('SELECT * FROM events ORDER BY id DESC').all();
    for (const e of events) {
      e.performances = db.prepare('SELECT id FROM performances WHERE event_id = ? ORDER BY starts_at').all(e.id).map(({ id }) => {
        const p = getPerformance(db, id);
        return { ...p, ...availability(db, p), sales_status: salesStatus(p), price_levels: db.prepare('SELECT * FROM price_levels WHERE performance_id = ?').all(id) };
      });
    }
    res.json(events);
  });

  r.post('/events', ops, (req, res) => {
    requireFields(req.body, ['title']);
    const status = req.body.status || 'draft';
    if (!['draft', 'published', 'cancelled'].includes(status)) throw badRequest('Invalid status');
    const id = db.prepare('INSERT INTO events (title, description, category, image_url, status) VALUES (?, ?, ?, ?, ?)')
      .run(req.body.title, req.body.description || null, req.body.category || null, req.body.image_url || null, status).lastInsertRowid;
    audit(req, 'event.create', 'event', id);
    res.status(201).json(db.prepare('SELECT * FROM events WHERE id = ?').get(id));
  });

  r.patch('/events/:id', ops, (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!e) throw notFound('Event');
    const next = { ...e, ...pick(req.body, ['title', 'description', 'category', 'image_url', 'status']) };
    if (!['draft', 'published', 'cancelled'].includes(next.status)) throw badRequest('Invalid status');
    db.prepare('UPDATE events SET title = ?, description = ?, category = ?, image_url = ?, status = ? WHERE id = ?').run(next.title, next.description, next.category, next.image_url, next.status, e.id);
    audit(req, 'event.update', 'event', e.id, req.body);
    res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(e.id));
  });

  r.get('/events/:id/share', marketing, (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!e) throw notFound('Event');
    const url = `${process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`}/event.html?id=${e.id}`;
    const text = `${e.title} — get tickets`;
    const u = encodeURIComponent(url);
    const t = encodeURIComponent(text);
    res.json({
      url,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
      x: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
      email: `mailto:?subject=${t}&body=${u}`,
    });
  });

  r.post('/performances', ops, (req, res) => {
    requireFields(req.body, ['event_id', 'stage_id', 'starts_at']);
    const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(req.body.stage_id);
    if (!stage) throw badRequest('Invalid stage');
    if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(req.body.event_id)) throw badRequest('Invalid event');
    // Sales parameters default from the stage but are set per performance.
    const mode = req.body.seating_mode || stage.seating_type;
    if (!['assigned', 'general'].includes(mode)) throw badRequest('Invalid seating_mode');
    if (mode === 'assigned' && !db.prepare('SELECT 1 FROM sections WHERE stage_id = ?').get(stage.id)) throw badRequest('Stage has no seating chart; use general admission');
    const capacity = mode === 'general' ? toInt(req.body.capacity ?? stage.ga_capacity, 'capacity', { min: 1 }) : 0;
    const id = transaction(db, () => {
      const pid = db.prepare('INSERT INTO performances (event_id, stage_id, starts_at, seating_mode, capacity, on_sale_at, off_sale_at, max_per_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.body.event_id, stage.id, toDbTime(req.body.starts_at), mode, capacity, toDbTime(req.body.on_sale_at), toDbTime(req.body.off_sale_at), toInt(req.body.max_per_order ?? 10, 'max_per_order', { min: 1 })).lastInsertRowid;
      for (const pl of req.body.price_levels || []) insertPriceLevel(pid, pl);
      return pid;
    });
    audit(req, 'performance.create', 'performance', id);
    res.status(201).json(getPerformance(db, id));
  });

  r.patch('/performances/:id', ops, (req, res) => {
    const p = db.prepare('SELECT * FROM performances WHERE id = ?').get(req.params.id);
    if (!p) throw notFound('Performance');
    const b = req.body;
    const next = {
      starts_at: b.starts_at !== undefined ? toDbTime(b.starts_at) : p.starts_at,
      on_sale_at: b.on_sale_at !== undefined ? toDbTime(b.on_sale_at) : p.on_sale_at,
      off_sale_at: b.off_sale_at !== undefined ? toDbTime(b.off_sale_at) : p.off_sale_at,
      max_per_order: b.max_per_order !== undefined ? toInt(b.max_per_order, 'max_per_order', { min: 1 }) : p.max_per_order,
      capacity: b.capacity !== undefined ? toInt(b.capacity, 'capacity', { min: 0 }) : p.capacity,
      status: b.status ?? p.status,
    };
    if (!['scheduled', 'cancelled'].includes(next.status)) throw badRequest('Invalid status');
    if (p.seating_mode === 'general' && next.capacity < availability(db, getPerformance(db, p.id)).sold) throw conflict('Capacity is below tickets already sold');
    db.prepare('UPDATE performances SET starts_at = ?, on_sale_at = ?, off_sale_at = ?, max_per_order = ?, capacity = ?, status = ? WHERE id = ?')
      .run(next.starts_at, next.on_sale_at, next.off_sale_at, next.max_per_order, next.capacity, next.status, p.id);
    audit(req, 'performance.update', 'performance', p.id, b);
    res.json(getPerformance(db, p.id));
  });

  function insertPriceLevel(performanceId, pl) {
    requireFields(pl, ['name']);
    return db.prepare('INSERT INTO price_levels (performance_id, name, zone, price_cents, fee_cents, public) VALUES (?, ?, ?, ?, ?, ?)')
      .run(performanceId, pl.name, pl.zone || null, toInt(pl.price_cents ?? 0, 'price_cents', { min: 0 }), toInt(pl.fee_cents ?? 0, 'fee_cents', { min: 0 }), pl.public === false ? 0 : 1).lastInsertRowid;
  }

  r.post('/performances/:id/price-levels', ops, (req, res) => {
    if (!db.prepare('SELECT 1 FROM performances WHERE id = ?').get(req.params.id)) throw notFound('Performance');
    const id = insertPriceLevel(Number(req.params.id), req.body);
    res.status(201).json(db.prepare('SELECT * FROM price_levels WHERE id = ?').get(id));
  });

  r.delete('/price-levels/:id', ops, (req, res) => {
    if (db.prepare('SELECT 1 FROM tickets WHERE price_level_id = ?').get(req.params.id)) throw conflict('Price level has sold tickets; make it non-public instead');
    db.prepare('DELETE FROM price_levels WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  r.patch('/price-levels/:id', ops, (req, res) => {
    const pl = db.prepare('SELECT * FROM price_levels WHERE id = ?').get(req.params.id);
    if (!pl) throw notFound('Price level');
    const next = { ...pl, ...pick(req.body, ['name', 'zone', 'price_cents', 'fee_cents', 'public']) };
    db.prepare('UPDATE price_levels SET name = ?, zone = ?, price_cents = ?, fee_cents = ?, public = ? WHERE id = ?')
      .run(next.name, next.zone || null, toInt(next.price_cents, 'price_cents', { min: 0 }), toInt(next.fee_cents, 'fee_cents', { min: 0 }), next.public ? 1 : 0, pl.id);
    res.json(db.prepare('SELECT * FROM price_levels WHERE id = ?').get(pl.id));
  });

  r.get('/performances/:id/manifest', anyStaff, (req, res) => {
    const tickets = db.prepare(`${TICKET_SELECT} WHERE t.performance_id = ? AND t.status != 'void' ORDER BY sc.name, se.row_label, se.seat_number, t.holder_name`).all(req.params.id);
    if (req.query.format === 'csv') return res.type('text/csv').attachment(`manifest-${req.params.id}.csv`).send(toCsv(tickets, ['code', 'holder_name', 'holder_email', 'section', 'row_label', 'seat_number', 'price_level', 'series_name', 'status', 'scanned_at']));
    res.json(tickets);
  });

  // ---- Series & subscriptions --------------------------------------------
  r.get('/series', anyStaff, (_req, res) => {
    const rows = db.prepare('SELECT * FROM series ORDER BY id DESC').all();
    for (const s of rows) {
      s.performance_ids = db.prepare('SELECT performance_id FROM series_performances WHERE series_id = ?').all(s.id).map((x) => x.performance_id);
      s.subscribers = db.prepare("SELECT COUNT(DISTINCT order_id) AS n FROM tickets WHERE series_id = ? AND status != 'void'").get(s.id).n;
    }
    res.json(rows);
  });

  r.post('/series', ops, (req, res) => {
    requireFields(req.body, ['name', 'kind']);
    if (!['series', 'subscription'].includes(req.body.kind)) throw badRequest('kind must be series or subscription');
    const ids = (req.body.performance_ids || []).map(Number);
    if (!ids.length) throw badRequest('performance_ids required');
    const id = transaction(db, () => {
      const sid = db.prepare('INSERT INTO series (name, description, kind, price_cents, fee_cents, on_sale_at, off_sale_at, max_per_order, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.body.name, req.body.description || null, req.body.kind, toInt(req.body.price_cents ?? 0, 'price_cents', { min: 0 }), toInt(req.body.fee_cents ?? 0, 'fee_cents', { min: 0 }),
          toDbTime(req.body.on_sale_at), toDbTime(req.body.off_sale_at), toInt(req.body.max_per_order ?? 8, 'max_per_order', { min: 1 }), req.body.status || 'published').lastInsertRowid;
      const stmt = db.prepare('INSERT INTO series_performances (series_id, performance_id) VALUES (?, ?)');
      for (const pid of ids) {
        if (!db.prepare('SELECT 1 FROM performances WHERE id = ?').get(pid)) throw badRequest(`Unknown performance ${pid}`);
        stmt.run(sid, pid);
      }
      return sid;
    });
    audit(req, 'series.create', 'series', id);
    res.status(201).json(db.prepare('SELECT * FROM series WHERE id = ?').get(id));
  });

  r.patch('/series/:id', ops, (req, res) => {
    const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
    if (!s) throw notFound('Series');
    const next = { ...s, ...pick(req.body, ['name', 'description', 'price_cents', 'fee_cents', 'max_per_order', 'status']) };
    db.prepare('UPDATE series SET name = ?, description = ?, price_cents = ?, fee_cents = ?, max_per_order = ?, status = ? WHERE id = ?')
      .run(next.name, next.description, toInt(next.price_cents, 'price_cents', { min: 0 }), toInt(next.fee_cents, 'fee_cents', { min: 0 }), toInt(next.max_per_order, 'max_per_order', { min: 1 }), next.status, s.id);
    res.json(db.prepare('SELECT * FROM series WHERE id = ?').get(s.id));
  });

  // ---- Donation funds / entities -----------------------------------------
  r.get('/funds', anyStaff, (_req, res) => {
    res.json(db.prepare(`SELECT f.*, COALESCE(SUM(CASE WHEN d.status = 'received' THEN d.amount_cents END), 0) AS raised_cents, COUNT(d.id) AS gift_count
      FROM funds f LEFT JOIN donations d ON d.fund_id = f.id GROUP BY f.id ORDER BY f.id`).all());
  });

  r.post('/funds', finance, (req, res) => {
    requireFields(req.body, ['name', 'entity_name', 'gl_account']);
    const id = db.prepare('INSERT INTO funds (name, entity_name, ein, gl_account, tax_deductible, description) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.body.name, req.body.entity_name, req.body.ein || null, req.body.gl_account, req.body.tax_deductible === false ? 0 : 1, req.body.description || null).lastInsertRowid;
    audit(req, 'fund.create', 'fund', id);
    res.status(201).json(db.prepare('SELECT * FROM funds WHERE id = ?').get(id));
  });

  r.patch('/funds/:id', finance, (req, res) => {
    const f = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
    if (!f) throw notFound('Fund');
    const n = { ...f, ...pick(req.body, ['name', 'entity_name', 'ein', 'gl_account', 'tax_deductible', 'description', 'active']) };
    db.prepare('UPDATE funds SET name = ?, entity_name = ?, ein = ?, gl_account = ?, tax_deductible = ?, description = ?, active = ? WHERE id = ?')
      .run(n.name, n.entity_name, n.ein, n.gl_account, n.tax_deductible ? 1 : 0, n.description, n.active ? 1 : 0, f.id);
    audit(req, 'fund.update', 'fund', f.id, req.body);
    res.json(db.prepare('SELECT * FROM funds WHERE id = ?').get(f.id));
  });

  // ---- Promo codes -------------------------------------------------------
  r.get('/promo-codes', marketing, (_req, res) => res.json(db.prepare('SELECT * FROM promo_codes ORDER BY id DESC').all()));
  r.post('/promo-codes', marketing, (req, res) => {
    requireFields(req.body, ['code']);
    const percent = toInt(req.body.percent_off ?? 0, 'percent_off', { min: 0, max: 100 });
    const amount = toInt(req.body.amount_off_cents ?? 0, 'amount_off_cents', { min: 0 });
    if (!percent && !amount) throw badRequest('percent_off or amount_off_cents required');
    const id = db.prepare('INSERT INTO promo_codes (code, description, percent_off, amount_off_cents, event_id, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(req.body.code).trim().toUpperCase(), req.body.description || null, percent, amount, req.body.event_id || null, req.body.max_uses ?? null, toDbTime(req.body.expires_at)).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id));
  });
  r.patch('/promo-codes/:id', marketing, (req, res) => {
    db.prepare('UPDATE promo_codes SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
    res.json(db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(req.params.id));
  });

  // ---- Orders, customers, refunds ----------------------------------------
  r.get('/orders', requireRole('boxoffice', 'finance'), (req, res) => {
    const q = req.query.q ? `%${req.query.q}%` : null;
    res.json(db.prepare(`SELECT * FROM orders WHERE (? IS NULL OR order_number LIKE ? OR email LIKE ? OR name LIKE ?)
      AND (? IS NULL OR channel = ?) ORDER BY id DESC LIMIT 200`).all(q, q, q, q, req.query.channel ?? null, req.query.channel ?? null));
  });
  r.get('/orders/:id', requireRole('boxoffice', 'finance'), (req, res) => res.json(getOrder(db, req.params.id)));
  r.post('/orders/:id/refund', requireRole('boxoffice', 'finance'), async (req, res) => {
    res.json(await refundOrder(db, gateway, Number(req.params.id), req.user, req.body.reason));
  });
  r.post('/orders/:id/resend', ops, (req, res) => {
    const order = getOrder(db, req.params.id);
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    queueEmail(db, { to: order.email, subject: `Your tickets for order ${order.order_number}`, kind: 'resend', body: order.tickets.filter((t) => t.status !== 'void').map((t) => `${t.event_title} ${t.starts_at}: ${base}/ticket.html?code=${t.code}`).join('\n') });
    res.json({ ok: true });
  });

  r.get('/customers', requireRole('boxoffice', 'marketing', 'finance'), (req, res) => {
    const filters = req.query.q ? [{ field: 'email', op: 'contains', value: req.query.q }] : [];
    const result = runQuery(db, 'customers', { filters, limit: 200 });
    res.json(result.rows);
  });

  // ---- Financial reports -------------------------------------------------
  r.get('/reports/sales', finance, (req, res) => {
    const from = toDbTime(req.query.from) || '0000-01-01';
    const to = toDbTime(req.query.to) || '9999-12-31';
    const byPerformance = db.prepare(`SELECT p.id AS performance_id, e.title AS event_title, p.starts_at, v.name AS venue, st.name AS stage,
        COUNT(t.id) AS tickets, SUM(CASE WHEN t.price_cents = 0 THEN 1 ELSE 0 END) AS free_tickets,
        COALESCE(SUM(t.price_cents),0) AS gross_cents, COALESCE(SUM(t.fee_cents),0) AS fee_cents
      FROM tickets t JOIN orders o ON o.id = t.order_id JOIN performances p ON p.id = t.performance_id JOIN events e ON e.id = p.event_id
      JOIN stages st ON st.id = p.stage_id JOIN venues v ON v.id = st.venue_id
      WHERE t.status != 'void' AND o.created_at BETWEEN ? AND ? GROUP BY p.id ORDER BY p.starts_at`).all(from, to);
    const byChannel = db.prepare(`SELECT channel, COUNT(*) AS orders, SUM(total_cents) AS total_cents FROM orders WHERE status = 'paid' AND created_at BETWEEN ? AND ? GROUP BY channel`).all(from, to);
    const settlement = db.prepare(`SELECT date(created_at) AS day, method, provider, SUM(CASE WHEN kind='charge' THEN amount_cents ELSE 0 END) AS charges_cents,
        SUM(CASE WHEN kind='refund' THEN amount_cents ELSE 0 END) AS refunds_cents, SUM(amount_cents) AS net_cents, COUNT(*) AS transactions
      FROM payments WHERE created_at BETWEEN ? AND ? GROUP BY day, method, provider ORDER BY day DESC`).all(from, to);
    const donations = db.prepare(`SELECT f.entity_name, f.name AS fund, f.ein, f.gl_account, COUNT(d.id) AS gifts, SUM(d.amount_cents) AS amount_cents, SUM(d.deductible_cents) AS deductible_cents
      FROM donations d JOIN funds f ON f.id = d.fund_id WHERE d.status = 'received' AND d.created_at BETWEEN ? AND ? GROUP BY f.id ORDER BY f.entity_name`).all(from, to);
    const concessions = db.prepare(`SELECT ol.description AS item, SUM(ol.quantity) AS quantity, SUM(ol.amount_cents) AS amount_cents FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE ol.kind = 'concession' AND o.status = 'paid' AND o.created_at BETWEEN ? AND ? GROUP BY ol.description ORDER BY amount_cents DESC`).all(from, to);
    res.json({ by_performance: byPerformance, by_channel: byChannel, settlement, donations, concessions });
  });

  r.get('/reports/trial-balance', finance, (_req, res) => {
    const rows = db.prepare(`SELECT account, SUM(debit_cents) AS debit_cents, SUM(credit_cents) AS credit_cents, SUM(debit_cents) - SUM(credit_cents) AS balance_cents
      FROM ledger_entries GROUP BY account ORDER BY account`).all();
    const totals = rows.reduce((t, r2) => ({ debit_cents: t.debit_cents + r2.debit_cents, credit_cents: t.credit_cents + r2.credit_cents }), { debit_cents: 0, credit_cents: 0 });
    res.json({ accounts: rows, totals, balanced: totals.debit_cents === totals.credit_cents });
  });

  // Recognise deferred ticket revenue for performances that have taken place.
  r.post('/reports/recognize-revenue', finance, (req, res) => {
    const perfRows = db.prepare(`SELECT t.order_id, p.id AS performance_id, SUM(t.price_cents) AS amount FROM tickets t JOIN performances p ON p.id = t.performance_id
      WHERE p.starts_at <= datetime('now') AND t.status != 'void' AND t.price_cents > 0
        AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.order_id = t.order_id AND l.memo = 'Revenue recognised: performance ' || p.id)
      GROUP BY t.order_id, p.id`).all();
    let total = 0;
    transaction(db, () => {
      const stmt = db.prepare('INSERT INTO ledger_entries (journal_id, order_id, account, debit_cents, credit_cents, memo) VALUES (?, ?, ?, ?, ?, ?)');
      for (const row of perfRows) {
        const jid = `RR-${row.order_id}-${row.performance_id}`;
        const memo = `Revenue recognised: performance ${row.performance_id}`;
        stmt.run(jid, row.order_id, '2300 Deferred Ticket Revenue', row.amount, 0, memo);
        stmt.run(jid, row.order_id, '4100 Ticket Revenue', 0, row.amount, memo);
        total += row.amount;
      }
    });
    audit(req, 'revenue.recognize', null, null, { total });
    res.json({ recognized_cents: total, journals: perfRows.length });
  });

  // ---- Selective data export ---------------------------------------------
  r.get('/exports/datasets', anyStaff, (_req, res) => res.json({ datasets: describeDatasets(), operators: OPERATORS }));

  const exportAccess = (req, dataset) => {
    const role = req.user.role;
    const allowed = { admin: '*', finance: ['orders', 'tickets', 'donations', 'ledger', 'customers'], marketing: ['customers', 'tickets', 'donations'], boxoffice: ['tickets', 'orders', 'scans'], scanner: ['scans'] };
    const a = allowed[role] || [];
    if (a !== '*' && !a.includes(dataset)) throw new HttpError(403, `Role ${role} cannot export ${dataset}`);
  };

  r.post('/exports/run', anyStaff, (req, res) => {
    requireFields(req.body, ['dataset']);
    exportAccess(req, req.body.dataset);
    const { columns, rows } = runQuery(db, req.body.dataset, { filters: req.body.filters || [], columns: req.body.columns, limit: req.body.preview ? 50 : undefined });
    audit(req, 'export.run', req.body.dataset, null, { filters: req.body.filters, rows: rows.length, preview: !!req.body.preview });
    if (req.body.format === 'csv') return res.type('text/csv').attachment(`${req.body.dataset}-${new Date().toISOString().slice(0, 10)}.csv`).send(toCsv(rows, columns));
    const count = req.body.preview ? runQuery(db, req.body.dataset, { filters: req.body.filters || [], columns: ['id'] }).rows.length : rows.length;
    res.json({ columns, rows, count });
  });

  r.get('/exports/saved', anyStaff, (_req, res) => res.json(db.prepare('SELECT * FROM saved_exports ORDER BY id DESC').all().map((s) => ({ ...s, definition: JSON.parse(s.definition_json) }))));
  r.post('/exports/saved', anyStaff, (req, res) => {
    requireFields(req.body, ['name', 'dataset']);
    exportAccess(req, req.body.dataset);
    runQuery(db, req.body.dataset, { filters: req.body.filters || [], columns: req.body.columns, limit: 1 }); // validate
    const id = db.prepare('INSERT INTO saved_exports (name, dataset, definition_json) VALUES (?, ?, ?)').run(req.body.name, req.body.dataset, JSON.stringify({ filters: req.body.filters || [], columns: req.body.columns || [] })).lastInsertRowid;
    res.status(201).json({ id });
  });
  r.delete('/exports/saved/:id', anyStaff, (req, res) => {
    db.prepare('DELETE FROM saved_exports WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---- Email & social marketing ------------------------------------------
  const segmentRecipients = (segment) => runQuery(db, 'customers', { filters: [...segment, { field: 'marketing_opt_in', op: 'eq', value: 1 }], columns: ['email', 'name'] }).rows;

  r.get('/campaigns', marketing, (_req, res) => res.json(db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all().map((c) => ({ ...c, segment: JSON.parse(c.segment_json) }))));

  r.post('/campaigns', marketing, (req, res) => {
    requireFields(req.body, ['name', 'channel', 'body']);
    if (!['email', 'social'].includes(req.body.channel)) throw badRequest('channel must be email or social');
    if (req.body.channel === 'email' && !req.body.subject) throw badRequest('subject required for email');
    const segment = req.body.segment || [];
    segmentRecipients(segment); // validates the segment definition
    const id = db.prepare('INSERT INTO campaigns (name, channel, subject, body, segment_json, event_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.body.name, req.body.channel, req.body.subject || null, req.body.body, JSON.stringify(segment), req.body.event_id || null).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id));
  });

  r.post('/campaigns/preview-segment', marketing, (req, res) => {
    const rows = segmentRecipients(req.body.segment || []);
    res.json({ count: rows.length, sample: rows.slice(0, 10) });
  });

  r.post('/campaigns/:id/send', marketing, (req, res) => {
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
    if (!c) throw notFound('Campaign');
    if (c.status === 'sent') throw conflict('Campaign already sent');
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const eventUrl = c.event_id ? `${base}/event.html?id=${c.event_id}` : base;
    if (c.channel === 'social') {
      // Social posts are published through the agency's social accounts; we
      // record the post and return ready-to-use share intents.
      db.prepare("UPDATE campaigns SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(c.id);
      const text = encodeURIComponent(c.body);
      const u = encodeURIComponent(eventUrl);
      return res.json({ status: 'sent', share: { facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}&quote=${text}`, x: `https://twitter.com/intent/tweet?text=${text}&url=${u}`, linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` } });
    }
    const recipients = segmentRecipients(JSON.parse(c.segment_json));
    transaction(db, () => {
      for (const rcpt of recipients) {
        const body = c.body.replaceAll('{{name}}', rcpt.name).replaceAll('{{event_url}}', eventUrl)
          + `\n\n—\nYou are receiving this because you opted in to updates. Unsubscribe: ${base}/unsubscribe.html?email=${encodeURIComponent(rcpt.email)}`;
        queueEmail(db, { to: rcpt.email, subject: c.subject, body, kind: 'campaign', campaignId: c.id });
      }
      db.prepare("UPDATE campaigns SET status = 'sent', sent_at = datetime('now'), recipients = ? WHERE id = ?").run(recipients.length, c.id);
    });
    audit(req, 'campaign.send', 'campaign', c.id, { recipients: recipients.length });
    res.json({ status: 'sent', recipients: recipients.length });
  });

  r.get('/outbox', anyStaff, (req, res) => {
    res.json(db.prepare('SELECT * FROM outbox WHERE (? IS NULL OR kind = ?) ORDER BY id DESC LIMIT 200').all(req.query.kind ?? null, req.query.kind ?? null));
  });

  // ---- POS catalogue -----------------------------------------------------
  r.get('/pos-items', anyStaff, (_req, res) => res.json(db.prepare('SELECT * FROM pos_items ORDER BY category, name').all()));
  r.post('/pos-items', ops, (req, res) => {
    requireFields(req.body, ['name', 'price_cents']);
    const id = db.prepare('INSERT INTO pos_items (venue_id, name, category, price_cents, taxable) VALUES (?, ?, ?, ?, ?)')
      .run(req.body.venue_id || null, req.body.name, req.body.category || 'Concessions', toInt(req.body.price_cents, 'price_cents', { min: 0 }), req.body.taxable === false ? 0 : 1).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM pos_items WHERE id = ?').get(id));
  });
  r.patch('/pos-items/:id', ops, (req, res) => {
    const it = db.prepare('SELECT * FROM pos_items WHERE id = ?').get(req.params.id);
    if (!it) throw notFound('POS item');
    const n = { ...it, ...pick(req.body, ['name', 'category', 'price_cents', 'taxable', 'active']) };
    db.prepare('UPDATE pos_items SET name = ?, category = ?, price_cents = ?, taxable = ?, active = ? WHERE id = ?').run(n.name, n.category, toInt(n.price_cents, 'price_cents', { min: 0 }), n.taxable ? 1 : 0, n.active ? 1 : 0, it.id);
    res.json(db.prepare('SELECT * FROM pos_items WHERE id = ?').get(it.id));
  });

  // ---- Integrations (API keys for website, POS, finance) ------------------
  r.get('/api-keys', admin, (_req, res) => res.json(db.prepare('SELECT id, name, key_prefix, scopes, active, created_at FROM api_keys ORDER BY id DESC').all()));
  r.post('/api-keys', admin, (req, res) => {
    requireFields(req.body, ['name', 'scopes']);
    const scopes = (Array.isArray(req.body.scopes) ? req.body.scopes : String(req.body.scopes).split(',')).map((s) => s.trim());
    const valid = ['pos', 'scan', 'export', 'catalog'];
    for (const s of scopes) if (!valid.includes(s)) throw badRequest(`Invalid scope ${s}; valid: ${valid.join(', ')}`);
    const raw = `ctk_${crypto.randomBytes(24).toString('base64url')}`;
    const id = db.prepare('INSERT INTO api_keys (name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?)').run(req.body.name, raw.slice(0, 10), sha256(raw), scopes.join(',')).lastInsertRowid;
    audit(req, 'apikey.create', 'api_key', id, { scopes });
    res.status(201).json({ id, key: raw, note: 'Store this key now; it cannot be shown again.' });
  });
  r.delete('/api-keys/:id', admin, (req, res) => {
    db.prepare('UPDATE api_keys SET active = 0 WHERE id = ?').run(req.params.id);
    audit(req, 'apikey.revoke', 'api_key', Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- Staff -------------------------------------------------------------
  r.get('/staff', admin, (_req, res) => res.json(db.prepare("SELECT id, email, name, role, created_at FROM users WHERE role != 'patron' ORDER BY id").all()));
  r.post('/staff', admin, (req, res) => {
    requireFields(req.body, ['email', 'name', 'role', 'password']);
    if (!STAFF_ROLES.includes(req.body.role)) throw badRequest('Invalid role');
    if (!isEmail(req.body.email)) throw badRequest('Invalid email');
    if (String(req.body.password).length < 10) throw badRequest('Staff passwords must be at least 10 characters');
    const email = String(req.body.email).toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw conflict('Email already in use');
    const id = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)').run(email, req.body.name, req.body.role, hashPassword(req.body.password)).lastInsertRowid;
    audit(req, 'staff.create', 'user', id, { role: req.body.role });
    res.status(201).json({ id, email, name: req.body.name, role: req.body.role });
  });
  r.patch('/staff/:id', admin, (req, res) => {
    if (!STAFF_ROLES.includes(req.body.role) && req.body.role !== 'patron') throw badRequest('Invalid role');
    if (Number(req.params.id) === req.user.id) throw badRequest('You cannot change your own role');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, req.params.id);
    audit(req, 'staff.role', 'user', Number(req.params.id), { role: req.body.role });
    res.json({ ok: true });
  });

  // ---- Support queue & audit ---------------------------------------------
  r.get('/support', anyStaff, (_req, res) => res.json(db.prepare("SELECT * FROM support_requests ORDER BY CASE status WHEN 'resolved' THEN 1 ELSE 0 END, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, id DESC").all()));
  r.patch('/support/:id', anyStaff, (req, res) => {
    if (!['open', 'in_progress', 'resolved'].includes(req.body.status)) throw badRequest('Invalid status');
    db.prepare("UPDATE support_requests SET status = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.status, req.params.id);
    res.json(db.prepare('SELECT * FROM support_requests WHERE id = ?').get(req.params.id));
  });
  r.get('/audit', admin, (_req, res) => res.json(db.prepare('SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300').all()));

  return r;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}
