import { transaction } from '../db.js';
import { badRequest, conflict, isEmail, notFound, nowIso, randomCode } from '../util.js';
import { TICKET_SELECT } from './orders.js';
import { queueEmail } from './mailer.js';

export function ticketByCode(db, code) {
  const t = db.prepare(`${TICKET_SELECT} WHERE t.code = ?`).get(String(code || '').toUpperCase());
  if (!t) throw notFound('Ticket');
  t.pending_transfer = db.prepare("SELECT id, to_email, to_name, created_at FROM ticket_transfers WHERE ticket_id = ? AND status = 'pending'").get(t.id) || null;
  return t;
}

export function ticketsForEmail(db, email) {
  return db.prepare(`${TICKET_SELECT} WHERE t.holder_email = ? AND t.status != 'void' ORDER BY p.starts_at`).all(email);
}

/**
 * Start a transfer. The ticket code itself is the bearer credential, so the
 * caller must present it (from their wallet or confirmation email).
 */
export function startTransfer(db, code, { to_email, to_name }, baseUrl = '') {
  const ticket = ticketByCode(db, code);
  if (ticket.status !== 'valid') throw conflict(`Ticket cannot be transferred (status: ${ticket.status})`);
  if (ticket.starts_at <= nowIso()) throw conflict('Performance has already started');
  if (ticket.pending_transfer) throw conflict('A transfer is already pending for this ticket');
  const email = String(to_email || '').trim().toLowerCase();
  if (!isEmail(email)) throw badRequest('Valid recipient email required');
  if (email === ticket.holder_email.toLowerCase()) throw badRequest('Ticket is already held by this email');
  const name = String(to_name || '').trim();
  if (!name) throw badRequest('Recipient name required');
  const token = randomCode(24);
  db.prepare('INSERT INTO ticket_transfers (ticket_id, from_email, to_email, to_name, token) VALUES (?, ?, ?, ?, ?)').run(ticket.id, ticket.holder_email, email, name, token);
  queueEmail(db, {
    to: email,
    subject: `${ticket.holder_name} sent you a ticket to ${ticket.event_title}`,
    kind: 'transfer_offer',
    body: `${ticket.holder_name} is transferring a ticket for ${ticket.event_title} (${ticket.starts_at} UTC) to you.\nAccept it here: ${baseUrl}/transfer.html?token=${token}`,
  });
  return { token, status: 'pending' };
}

export function getTransfer(db, token) {
  const tr = db.prepare('SELECT * FROM ticket_transfers WHERE token = ?').get(String(token || ''));
  if (!tr) throw notFound('Transfer');
  const t = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(tr.ticket_id);
  return { status: tr.status, to_email: tr.to_email, to_name: tr.to_name, from_name: t.holder_name, event_title: t.event_title, starts_at: t.starts_at, venue_name: t.venue_name, section: t.section, row_label: t.row_label, seat_number: t.seat_number };
}

/** Accepting re-issues the ticket under a new code so the sender's copy is void. */
export function acceptTransfer(db, token, baseUrl = '') {
  return transaction(db, () => {
    const tr = db.prepare('SELECT * FROM ticket_transfers WHERE token = ?').get(String(token || ''));
    if (!tr) throw notFound('Transfer');
    if (tr.status !== 'pending') throw conflict(`Transfer is ${tr.status}`);
    const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(tr.ticket_id);
    if (t.status !== 'valid') throw conflict(`Ticket is ${t.status} and can no longer be transferred`);
    const newCode = randomCode(12);
    db.prepare('UPDATE tickets SET code = ?, holder_name = ?, holder_email = ? WHERE id = ?').run(newCode, tr.to_name, tr.to_email, t.id);
    db.prepare("UPDATE ticket_transfers SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?").run(tr.id);
    queueEmail(db, { to: tr.from_email, subject: 'Your ticket transfer was accepted', kind: 'transfer_accepted', body: `${tr.to_name} accepted your ticket. Your original copy of the ticket is no longer valid.` });
    queueEmail(db, { to: tr.to_email, subject: 'Your ticket', kind: 'transfer_ticket', body: `Your ticket is ready: ${baseUrl}/ticket.html?code=${newCode}` });
    return ticketByCode(db, newCode);
  });
}

export function cancelTransfer(db, code) {
  const ticket = ticketByCode(db, code);
  if (!ticket.pending_transfer) throw conflict('No pending transfer');
  db.prepare("UPDATE ticket_transfers SET status = 'cancelled' WHERE id = ?").run(ticket.pending_transfer.id);
  return { status: 'cancelled' };
}

/**
 * Validate a scanned code at the door. Results:
 *   admitted | already_scanned | void | wrong_performance | not_found
 */
export function scanTicket(db, { code, performance_id, device }, user) {
  if (!code) throw badRequest('code required');
  const normalized = String(code).trim().toUpperCase();
  return transaction(db, () => {
    const t = db.prepare(`${TICKET_SELECT} WHERE t.code = ?`).get(normalized);
    let result;
    if (!t) {
      // A code that was rotated by a transfer is reported distinctly from garbage.
      result = 'not_found';
    } else if (t.status === 'void') result = 'void';
    else if (performance_id && Number(performance_id) !== t.performance_id) result = 'wrong_performance';
    else if (t.status === 'scanned') result = 'already_scanned';
    else {
      db.prepare("UPDATE tickets SET status = 'scanned', scanned_at = datetime('now'), scanned_by = ? WHERE id = ? AND status = 'valid'").run(user?.id ?? null, t.id);
      db.prepare("UPDATE ticket_transfers SET status = 'cancelled' WHERE ticket_id = ? AND status = 'pending'").run(t.id);
      result = 'admitted';
    }
    db.prepare('INSERT INTO scans (ticket_id, code, performance_id, result, scanned_by, device) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t?.id ?? null, normalized, performance_id ? Number(performance_id) : null, result, user?.id ?? null, device ? String(device).slice(0, 64) : null);
    const fresh = t ? db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(t.id) : null;
    return {
      result,
      admitted: result === 'admitted',
      ticket: fresh && { holder_name: fresh.holder_name, event_title: fresh.event_title, starts_at: fresh.starts_at, section: fresh.section, row_label: fresh.row_label, seat_number: fresh.seat_number, price_level: fresh.price_level, scanned_at: fresh.scanned_at, performance_id: fresh.performance_id },
    };
  });
}
