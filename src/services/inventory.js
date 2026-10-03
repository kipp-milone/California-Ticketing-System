import { badRequest, conflict, notFound, nowIso } from '../util.js';

export const HOLD_MINUTES = 10;

export function getPerformance(db, id) {
  const perf = db.prepare(`
    SELECT p.*, e.title AS event_title, e.status AS event_status, e.image_url, e.category,
           s.name AS stage_name, v.name AS venue_name, v.id AS venue_id
    FROM performances p
    JOIN events e ON e.id = p.event_id
    JOIN stages s ON s.id = p.stage_id
    JOIN venues v ON v.id = s.venue_id
    WHERE p.id = ?`).get(id);
  if (!perf) throw notFound('Performance');
  return perf;
}

export function releaseExpiredHolds(db) {
  db.prepare('DELETE FROM seat_holds WHERE expires_at <= ?').run(nowIso());
}

// Seats sold (non-void tickets) for a performance.
export function soldCount(db, performanceId) {
  return db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE performance_id = ? AND status != 'void'").get(performanceId).n;
}

export function performanceCapacity(db, perf) {
  if (perf.seating_mode === 'general') return perf.capacity;
  return db.prepare('SELECT COUNT(*) AS n FROM seats st JOIN sections sc ON sc.id = st.section_id WHERE sc.stage_id = ?').get(perf.stage_id).n;
}

export function availability(db, perf) {
  releaseExpiredHolds(db);
  const capacity = performanceCapacity(db, perf);
  const sold = soldCount(db, perf.id);
  const held = perf.seating_mode === 'assigned'
    ? db.prepare('SELECT COUNT(*) AS n FROM seat_holds WHERE performance_id = ?').get(perf.id).n
    : 0;
  return { capacity, sold, held, available: Math.max(0, capacity - sold - held) };
}

export function salesStatus(perf, now = new Date()) {
  if (perf.status === 'cancelled' || perf.event_status === 'cancelled') return 'cancelled';
  if (perf.event_status !== 'published') return 'unpublished';
  const t = now.toISOString().replace('T', ' ').slice(0, 19);
  if (perf.on_sale_at && t < perf.on_sale_at) return 'not_yet_on_sale';
  if (perf.off_sale_at && t >= perf.off_sale_at) return 'off_sale';
  if (t >= perf.starts_at) return 'past';
  return 'on_sale';
}

/** Full seat map with each seat's status relative to the given cart. */
export function seatMap(db, perf, cartToken) {
  if (perf.seating_mode !== 'assigned') throw badRequest('Performance is general admission');
  releaseExpiredHolds(db);
  const rows = db.prepare(`
    SELECT st.id, st.row_label, st.seat_number, st.zone, st.accessible, sc.id AS section_id, sc.name AS section,
      (SELECT 1 FROM tickets t WHERE t.performance_id = ? AND t.seat_id = st.id AND t.status != 'void') AS sold,
      (SELECT cart_token FROM seat_holds h WHERE h.performance_id = ? AND h.seat_id = st.id) AS hold_token
    FROM seats st JOIN sections sc ON sc.id = st.section_id
    WHERE sc.stage_id = ?
    ORDER BY sc.sort_order, sc.id, st.row_label, st.seat_number`).all(perf.id, perf.id, perf.stage_id);
  const sections = [];
  const byId = new Map();
  for (const r of rows) {
    let section = byId.get(r.section_id);
    if (!section) {
      section = { id: r.section_id, name: r.section, rows: [] };
      byId.set(r.section_id, section);
      sections.push(section);
    }
    let row = section.rows.find((x) => x.label === r.row_label);
    if (!row) section.rows.push((row = { label: r.row_label, seats: [] }));
    let status = 'available';
    if (r.sold) status = 'sold';
    else if (r.hold_token && r.hold_token === cartToken) status = 'mine';
    else if (r.hold_token) status = 'held';
    row.seats.push({ id: r.id, number: r.seat_number, zone: r.zone, accessible: !!r.accessible, status });
  }
  return sections;
}

export function holdSeats(db, perf, seatIds, cartToken) {
  if (!cartToken || cartToken.length < 16) throw badRequest('cart_token (min 16 chars) required');
  if (perf.seating_mode !== 'assigned') throw badRequest('Seat holds only apply to assigned seating');
  releaseExpiredHolds(db);
  const expires = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  for (const seatId of seatIds) {
    assertSeatSellable(db, perf, seatId, cartToken);
    db.prepare(`INSERT INTO seat_holds (performance_id, seat_id, cart_token, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (performance_id, seat_id) DO UPDATE SET expires_at = excluded.expires_at`).run(perf.id, seatId, cartToken, expires);
  }
  // Extending any seat extends the whole cart so seats expire together.
  db.prepare('UPDATE seat_holds SET expires_at = ? WHERE cart_token = ?').run(expires, cartToken);
  return { expires_at: expires };
}

export function releaseSeats(db, perfId, seatIds, cartToken) {
  const stmt = db.prepare('DELETE FROM seat_holds WHERE performance_id = ? AND seat_id = ? AND cart_token = ?');
  for (const seatId of seatIds) stmt.run(perfId, seatId, cartToken);
}

export function assertSeatSellable(db, perf, seatId, cartToken) {
  const seat = db.prepare(`SELECT st.*, sc.name AS section FROM seats st JOIN sections sc ON sc.id = st.section_id
    WHERE st.id = ? AND sc.stage_id = ?`).get(seatId, perf.stage_id);
  if (!seat) throw badRequest(`Seat ${seatId} is not part of this performance's stage`);
  const sold = db.prepare("SELECT 1 FROM tickets WHERE performance_id = ? AND seat_id = ? AND status != 'void'").get(perf.id, seatId);
  if (sold) throw conflict(`Seat ${seat.section} ${seat.row_label}${seat.seat_number} is no longer available`);
  const hold = db.prepare('SELECT cart_token FROM seat_holds WHERE performance_id = ? AND seat_id = ? AND expires_at > ?').get(perf.id, seatId, nowIso());
  if (hold && hold.cart_token !== cartToken) throw conflict(`Seat ${seat.section} ${seat.row_label}${seat.seat_number} is being held by another customer`);
  return seat;
}

/** Best-available allocation used for subscriptions and box-office quick sale. */
export function bestAvailableSeats(db, perf, quantity, zone, cartToken, exclude = new Set()) {
  releaseExpiredHolds(db);
  const seats = db.prepare(`
    SELECT st.id, st.row_label, st.seat_number, sc.id AS section_id
    FROM seats st JOIN sections sc ON sc.id = st.section_id
    WHERE sc.stage_id = ? AND (? IS NULL OR st.zone = ?)
      AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.performance_id = ? AND t.seat_id = st.id AND t.status != 'void')
      AND NOT EXISTS (SELECT 1 FROM seat_holds h WHERE h.performance_id = ? AND h.seat_id = st.id AND h.cart_token != ?)
    ORDER BY sc.sort_order, sc.id, st.row_label, st.seat_number`).all(perf.stage_id, zone ?? null, zone ?? null, perf.id, perf.id, cartToken ?? '')
    .filter((s) => !exclude.has(s.id));
  if (seats.length < quantity) return null;
  // Prefer a contiguous block in a single row; fall back to first available.
  for (let i = 0; i + quantity <= seats.length; i++) {
    const block = seats.slice(i, i + quantity);
    const sameRow = block.every((s) => s.section_id === block[0].section_id && s.row_label === block[0].row_label);
    const contiguous = block.every((s, j) => j === 0 || s.seat_number === block[j - 1].seat_number + 1);
    if (sameRow && contiguous) return block.map((s) => s.id);
  }
  return seats.slice(0, quantity).map((s) => s.id);
}
