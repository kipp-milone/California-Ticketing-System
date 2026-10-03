import express from 'express';
import { requireRoleOrScope } from '../auth.js';
import { asyncRouter, toCsv } from '../util.js';
import { checkout } from '../services/orders.js';
import { scanTicket } from '../services/tickets.js';
import { getPerformance, availability } from '../services/inventory.js';

/**
 * Endpoints used by door scanners, concession POS terminals and other
 * systems. Each accepts either a staff session or an API key with the scope.
 */
export function integrationRoutes({ db, gateway }) {
  const r = asyncRouter(express);

  // ---- Door scanning ------------------------------------------------------
  r.post('/scan', requireRoleOrScope('scan', 'scanner', 'boxoffice'), (req, res) => {
    res.json(scanTicket(db, req.body, req.user));
  });

  r.get('/scan/performances', requireRoleOrScope('scan', 'scanner', 'boxoffice'), (_req, res) => {
    const rows = db.prepare(`SELECT id FROM performances WHERE status = 'scheduled'
      AND starts_at BETWEEN datetime('now', '-1 day') AND datetime('now', '+7 days') ORDER BY starts_at`).all();
    res.json(rows.map(({ id }) => {
      const p = getPerformance(db, id);
      const scanned = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE performance_id = ? AND status = 'scanned'").get(id).n;
      return { id, event_title: p.event_title, starts_at: p.starts_at, venue_name: p.venue_name, stage_name: p.stage_name, sold: availability(db, p).sold, scanned };
    }));
  });

  // Offline-capable scanners download the valid codes for a performance and
  // sync scans back via POST /scan when connectivity returns.
  r.get('/scan/performances/:id/codes', requireRoleOrScope('scan', 'scanner', 'boxoffice'), (req, res) => {
    res.json(db.prepare("SELECT code, status FROM tickets WHERE performance_id = ? AND status != 'void'").all(req.params.id));
  });

  // ---- Concessions POS -----------------------------------------------------
  r.get('/pos/items', requireRoleOrScope('pos', 'boxoffice'), (req, res) => {
    res.json(db.prepare('SELECT id, name, category, price_cents, taxable FROM pos_items WHERE active = 1 AND (? IS NULL OR venue_id IS NULL OR venue_id = ?) ORDER BY category, name')
      .all(req.query.venue_id ?? null, req.query.venue_id ?? null));
  });

  // A POS sale is a regular order on the 'pos' channel, so concessions flow
  // into the same ledger, reports and exports as ticketing.
  r.post('/pos/sales', requireRoleOrScope('pos', 'boxoffice'), async (req, res) => {
    const body = {
      ...req.body,
      channel: 'pos',
      customer: req.body.customer?.email ? req.body.customer : { name: 'Walk-up customer', email: 'walkup@pos.local' },
    };
    const result = await checkout(db, gateway, body, { user: req.user, apiKey: req.apiKey });
    res.status(201).json(result.order);
  });

  // ---- Finance system feed -------------------------------------------------
  r.get('/finance/journal', requireRoleOrScope('export', 'finance'), (req, res) => {
    const since = Number(req.query.since_id || 0);
    const rows = db.prepare(`SELECT l.id, l.journal_id, l.account, l.debit_cents, l.credit_cents, l.memo, l.created_at, o.order_number
      FROM ledger_entries l LEFT JOIN orders o ON o.id = l.order_id WHERE l.id > ? ORDER BY l.id LIMIT 5000`).all(since);
    if (req.query.format === 'csv') return res.type('text/csv').send(toCsv(rows));
    res.json({ entries: rows, next_since_id: rows.length ? rows[rows.length - 1].id : since });
  });

  return r;
}
