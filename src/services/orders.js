import { transaction } from '../db.js';
import { HttpError, badRequest, conflict, formatMoney, isEmail, notFound, randomCode, toInt } from '../util.js';
import { assertSeatSellable, availability, bestAvailableSeats, getPerformance, salesStatus } from './inventory.js';
import { ACCOUNTS, cashAccount, postJournal, reverseOrder } from './ledger.js';
import { queueEmail } from './mailer.js';

export const SALES_TAX_RATE = Number(process.env.SALES_TAX_RATE ?? 0.0725);
const STAFF_METHODS = ['cash', 'card', 'free'];

/**
 * Build a fully priced, validated order from a cart without writing anything.
 * Called twice per checkout: once before charging the card and again inside
 * the write transaction (so inventory taken while the charge was in flight is
 * detected and the charge refunded).
 *
 * cart = {
 *   cart_token, channel, promo_code,
 *   customer: { name, email },
 *   items: [ { type: 'ticket', performance_id, price_level_id, seat_id } |
 *            { type: 'ticket', performance_id, price_level_id, quantity }   // GA
 *            { type: 'subscription', series_id, quantity, zone } ],
 *   donations: [ { fund_id, amount_cents } ],
 *   concessions: [ { pos_item_id, quantity } ],
 * }
 */
export function priceCart(db, cart, { staff = false, now = new Date() } = {}) {
  const items = Array.isArray(cart.items) ? cart.items : [];
  const donations = Array.isArray(cart.donations) ? cart.donations : [];
  const concessions = Array.isArray(cart.concessions) ? cart.concessions : [];
  if (!items.length && !donations.length && !concessions.length) throw badRequest('Cart is empty');

  const tickets = []; // { performance, price_level_id, seat_id, price, fee, description, series_id }
  const lines = [];
  const perPerformanceQty = new Map();
  const seatsInCart = new Set();
  const gaRequested = new Map();
  const perfCache = new Map();
  const perf = (id) => {
    if (!perfCache.has(id)) perfCache.set(id, getPerformance(db, id));
    return perfCache.get(id);
  };

  const checkOnSale = (p) => {
    const status = salesStatus(p, now);
    // Box office can sell before public on-sale and after online off-sale
    // (walk-up), but never for cancelled or unpublished shows.
    const allowed = staff ? ['on_sale', 'not_yet_on_sale', 'off_sale', 'past'] : ['on_sale'];
    if (!allowed.includes(status)) throw conflict(`${p.event_title} (${p.starts_at}) is not on sale: ${status.replaceAll('_', ' ')}`);
  };

  for (const item of items) {
    if (item.type === 'ticket') {
      const p = perf(toInt(item.performance_id, 'performance_id', { min: 1 }));
      checkOnSale(p);
      const level = db.prepare('SELECT * FROM price_levels WHERE id = ? AND performance_id = ?').get(item.price_level_id, p.id);
      if (!level) throw badRequest('Invalid price level for performance');
      if (!level.public && !staff) throw new HttpError(403, `Price level "${level.name}" is restricted`);
      const desc = `${p.event_title} — ${p.starts_at} — ${level.name}`;
      if (p.seating_mode === 'assigned') {
        if (item.seat_id == null) throw badRequest('seat_id required for assigned seating');
        const seatId = toInt(item.seat_id, 'seat_id', { min: 1 });
        const key = `${p.id}:${seatId}`;
        if (seatsInCart.has(key)) throw badRequest('Duplicate seat in cart');
        seatsInCart.add(key);
        const seat = assertSeatSellable(db, p, seatId, cart.cart_token);
        if (level.zone && level.zone !== seat.zone) throw badRequest(`Price level "${level.name}" is not valid for zone ${seat.zone}`);
        tickets.push({ performance: p, price_level_id: level.id, seat_id: seatId, price: level.price_cents, fee: level.fee_cents, description: `${desc} — ${seat.section} Row ${seat.row_label} Seat ${seat.seat_number}` });
        perPerformanceQty.set(p.id, (perPerformanceQty.get(p.id) || 0) + 1);
        lines.push({ kind: 'ticket', description: `${desc} — ${seat.section} ${seat.row_label}${seat.seat_number}`, ref_id: p.id, quantity: 1, unit: level.price_cents });
      } else {
        const qty = toInt(item.quantity ?? 1, 'quantity', { min: 1 });
        for (let i = 0; i < qty; i++) tickets.push({ performance: p, price_level_id: level.id, seat_id: null, price: level.price_cents, fee: level.fee_cents, description: desc });
        perPerformanceQty.set(p.id, (perPerformanceQty.get(p.id) || 0) + qty);
        gaRequested.set(p.id, (gaRequested.get(p.id) || 0) + qty);
        lines.push({ kind: 'ticket', description: desc, ref_id: p.id, quantity: qty, unit: level.price_cents });
      }
    } else if (item.type === 'subscription') {
      const series = db.prepare("SELECT * FROM series WHERE id = ? AND kind = 'subscription'").get(item.series_id);
      if (!series || (series.status !== 'published' && !staff)) throw notFound('Subscription package');
      const t = now.toISOString().replace('T', ' ').slice(0, 19);
      if (!staff && ((series.on_sale_at && t < series.on_sale_at) || (series.off_sale_at && t >= series.off_sale_at))) throw conflict(`${series.name} is not on sale`);
      const qty = toInt(item.quantity ?? 1, 'quantity', { min: 1, max: series.max_per_order });
      const perfIds = db.prepare('SELECT performance_id FROM series_performances sp JOIN performances p ON p.id = sp.performance_id WHERE series_id = ? ORDER BY p.starts_at').all(series.id).map((r) => r.performance_id);
      if (!perfIds.length) throw conflict('Subscription has no performances');
      // Allocate package price across performances so ticket revenue per
      // performance sums exactly to the package price.
      const base = Math.floor(series.price_cents / perfIds.length);
      const remainder = series.price_cents - base * perfIds.length;
      for (let n = 0; n < qty; n++) {
        perfIds.forEach((pid, idx) => {
          const p = perf(pid);
          if (p.status === 'cancelled') throw conflict(`${p.event_title} is cancelled`);
          tickets.push({ performance: p, price_level_id: null, seat_id: undefined, zone: item.zone || null, series_id: series.id, price: base + (idx === 0 ? remainder : 0), fee: idx === 0 ? series.fee_cents : 0, description: `${series.name}: ${p.event_title} — ${p.starts_at}` });
          if (p.seating_mode === 'general') gaRequested.set(p.id, (gaRequested.get(p.id) || 0) + 1);
        });
      }
      lines.push({ kind: 'subscription', description: `${series.name} subscription`, ref_id: series.id, quantity: qty, unit: series.price_cents });
    } else {
      throw badRequest(`Unknown item type "${item.type}"`);
    }
  }

  for (const [pid, qty] of perPerformanceQty) {
    const p = perf(pid);
    if (!staff && qty > p.max_per_order) throw badRequest(`Maximum ${p.max_per_order} tickets per order for ${p.event_title}`);
  }
  for (const [pid, qty] of gaRequested) {
    const p = perf(pid);
    if (p.seating_mode !== 'general') continue;
    const avail = availability(db, p);
    if (qty > avail.available) throw conflict(`Only ${avail.available} tickets remain for ${p.event_title} (${p.starts_at})`);
  }
  // Subscription seats on assigned stages are allocated best-available.
  const subNeeds = new Map();
  for (const t of tickets) if (t.seat_id === undefined && t.performance.seating_mode === 'assigned') {
    const key = `${t.performance.id}|${t.zone || ''}`;
    if (!subNeeds.has(key)) subNeeds.set(key, []);
    subNeeds.get(key).push(t);
  }
  for (const group of subNeeds.values()) {
    const p = group[0].performance;
    const taken = new Set([...seatsInCart].filter((k) => k.startsWith(`${p.id}:`)).map((k) => Number(k.split(':')[1])));
    const free = bestAvailableSeats(db, p, group.length, group[0].zone, cart.cart_token, taken);
    if (!free) throw conflict(`Not enough seats remain for ${p.event_title} (${p.starts_at})`);
    group.forEach((t, i) => { t.seat_id = free[i]; seatsInCart.add(`${p.id}:${free[i]}`); });
  }
  for (const t of tickets) if (t.seat_id === undefined) t.seat_id = null;

  // Donations to one or more funds / legal entities.
  const donationRows = [];
  for (const d of donations) {
    const fund = db.prepare('SELECT * FROM funds WHERE id = ? AND active = 1').get(d.fund_id);
    if (!fund) throw badRequest('Invalid donation fund');
    const amount = toInt(d.amount_cents, 'amount_cents', { min: 100 });
    donationRows.push({ fund, amount });
    lines.push({ kind: 'donation', description: `Gift to ${fund.name} (${fund.entity_name})`, ref_id: fund.id, quantity: 1, unit: amount });
  }

  // Concessions / merchandise (POS or pre-order).
  let taxable = 0;
  let concessionTotal = 0;
  for (const c of concessions) {
    const pi = db.prepare('SELECT * FROM pos_items WHERE id = ? AND active = 1').get(c.pos_item_id);
    if (!pi) throw badRequest('Invalid POS item');
    const qty = toInt(c.quantity ?? 1, 'quantity', { min: 1 });
    concessionTotal += pi.price_cents * qty;
    if (pi.taxable) taxable += pi.price_cents * qty;
    lines.push({ kind: 'concession', description: pi.name, ref_id: pi.id, quantity: qty, unit: pi.price_cents });
  }

  const ticketSubtotal = tickets.reduce((s, t) => s + t.price, 0);
  const fees = tickets.reduce((s, t) => s + t.fee, 0);

  // Promo code: discounts single-ticket face value (not subscriptions, which
  // are already package-priced).
  let discount = 0;
  let promo = null;
  if (cart.promo_code) {
    promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND active = 1').get(String(cart.promo_code).trim());
    const t = now.toISOString().replace('T', ' ').slice(0, 19);
    if (!promo || (promo.expires_at && t >= promo.expires_at) || (promo.max_uses != null && promo.uses >= promo.max_uses)) throw badRequest('Promo code is invalid or expired');
    const eligible = tickets.filter((x) => !x.series_id && (!promo.event_id || x.performance.event_id === promo.event_id)).reduce((s, x) => s + x.price, 0);
    if (!eligible) throw badRequest('Promo code does not apply to items in cart');
    discount = Math.min(eligible, Math.round((eligible * promo.percent_off) / 100) + promo.amount_off_cents);
  }

  const donationTotal = donationRows.reduce((s, d) => s + d.amount, 0);
  const tax = Math.round(taxable * SALES_TAX_RATE);
  const subtotal = ticketSubtotal + concessionTotal;
  const total = subtotal - discount + fees + donationTotal + tax;

  if (fees) lines.push({ kind: 'fee', description: 'Service fees', quantity: 1, unit: fees });
  if (discount) lines.push({ kind: 'discount', description: `Promo ${promo.code}`, ref_id: promo.id, quantity: 1, unit: -discount });
  if (tax) lines.push({ kind: 'tax', description: `Sales tax ${(SALES_TAX_RATE * 100).toFixed(2)}%`, quantity: 1, unit: tax });

  return {
    tickets, lines, donations: donationRows, promo, cartToken: cart.cart_token,
    totals: { ticket_cents: ticketSubtotal, concession_cents: concessionTotal, subtotal_cents: subtotal, discount_cents: discount, fees_cents: fees, donation_cents: donationTotal, tax_cents: tax, total_cents: total },
  };
}

function nextOrderNumber() {
  return `CT-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomCode(6)}`;
}

/**
 * Validate, charge, and record an order.
 * payment = { method: 'card' | 'cash' | 'external' | 'free', token, reference }
 */
export async function checkout(db, gateway, cart, { user = null, apiKey = null, baseUrl = '' } = {}) {
  const staff = !!user && ['admin', 'boxoffice'].includes(user.role);
  const integration = !!apiKey?.scopes.includes('pos');
  const customer = cart.customer || {};
  const name = String(customer.name || user?.name || '').trim();
  const email = String(customer.email || user?.email || '').trim().toLowerCase();
  if (!name) throw badRequest('Customer name required');
  if (!isEmail(email)) throw badRequest('Valid customer email required');

  let channel = cart.channel || 'web';
  if (!['web', 'mobile', 'boxoffice', 'pos', 'api'].includes(channel)) throw badRequest('Invalid channel');
  if (['boxoffice', 'pos'].includes(channel) && !staff && !integration) throw new HttpError(403, `${channel} sales require staff or POS credentials`);

  const priced = priceCart(db, cart, { staff: staff || integration });
  const { total_cents: total } = priced.totals;

  const payment = cart.payment || {};
  let method = payment.method || (total === 0 ? 'free' : 'card');
  if (total === 0) method = 'free';
  if (method === 'free' && total !== 0) throw badRequest('Payment required');
  if (method === 'cash' && !staff) throw new HttpError(403, 'Cash payments are box office only');
  if (method === 'external' && !integration) throw new HttpError(403, 'External payments require a POS integration key');
  if (![...STAFF_METHODS, 'external'].includes(method)) throw badRequest('Invalid payment method');

  let charge = null;
  if (method === 'card') charge = await gateway.charge({ amountCents: total, token: payment.token, description: `Order for ${email}` });
  else if (method === 'external') charge = { provider: 'external_pos', ref: String(payment.reference || ''), brand: null, last4: null };
  else if (method === 'cash') charge = { provider: 'cash', ref: null, brand: null, last4: null };

  let result;
  try {
    result = transaction(db, () => {
      // Re-price inside the transaction: inventory may have moved during the charge.
      const final = priceCart(db, cart, { staff: staff || integration });
      if (final.totals.total_cents !== total) throw conflict('Cart total changed during checkout; please review and try again');
      return writeOrder(db, final, { user, name, email, channel, method, charge });
    });
  } catch (err) {
    if (charge && method === 'card') await gateway.refund({ ref: charge.ref, amountCents: total }).catch(() => {});
    throw err;
  }
  // Anonymous walk-up POS sales have no one to email.
  if (!email.endsWith('@pos.local')) sendConfirmation(db, result.order.id, baseUrl);
  return result;
}

function writeOrder(db, priced, { user, name, email, channel, method, charge }) {
  const t = priced.totals;
  const userId = user?.role === 'patron' ? user.id : db.prepare('SELECT id FROM users WHERE email = ?').get(email)?.id ?? null;
  const orderNumber = nextOrderNumber();
  const { lastInsertRowid: orderId } = db.prepare(`INSERT INTO orders (order_number, user_id, email, name, channel, subtotal_cents, discount_cents, fees_cents, donation_cents, tax_cents, total_cents, promo_code_id, payment_method, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(orderNumber, userId, email, name, channel, t.subtotal_cents, t.discount_cents, t.fees_cents, t.donation_cents, t.tax_cents, t.total_cents, priced.promo?.id ?? null, method, user && user.role !== 'patron' ? user.id : null);

  const lineStmt = db.prepare('INSERT INTO order_lines (order_id, kind, description, ref_id, quantity, unit_cents, amount_cents) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const l of priced.lines) lineStmt.run(orderId, l.kind, l.description, l.ref_id ?? null, l.quantity, l.unit, l.unit * l.quantity);

  const ticketStmt = db.prepare(`INSERT INTO tickets (code, order_id, performance_id, seat_id, price_level_id, series_id, price_cents, fee_cents, holder_name, holder_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const tk of priced.tickets) ticketStmt.run(randomCode(12), orderId, tk.performance.id, tk.seat_id, tk.price_level_id, tk.series_id ?? null, tk.price, tk.fee, name, email);
  db.prepare('DELETE FROM seat_holds WHERE cart_token = ?').run(priced.cartToken ?? '');

  const donationStmt = db.prepare('INSERT INTO donations (order_id, fund_id, amount_cents, deductible_cents, donor_name, donor_email, receipt_number) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const d of priced.donations) donationStmt.run(orderId, d.fund.id, d.amount, d.fund.tax_deductible ? d.amount : 0, name, email, `R-${randomCode(10)}`);

  if (priced.promo) db.prepare('UPDATE promo_codes SET uses = uses + 1 WHERE id = ?').run(priced.promo.id);

  if (charge) {
    db.prepare('INSERT INTO payments (order_id, kind, method, provider, provider_ref, card_brand, card_last4, amount_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(orderId, 'charge', method, charge.provider, charge.ref, charge.brand, charge.last4, t.total_cents);
  }

  // Donations credit each fund's own GL account (e.g. "due to" the foundation).
  const donationLines = priced.donations.map((d) => ({ account: d.fund.gl_account, credit: d.amount, memo: `Gift to ${d.fund.entity_name}` }));
  postJournal(db, orderId, [
    { account: cashAccount(method), debit: t.total_cents, memo: `Order ${orderNumber}` },
    { account: ACCOUNTS.discounts, debit: t.discount_cents },
    { account: ACCOUNTS.deferredTickets, credit: t.ticket_cents, memo: 'Recognised at performance date' },
    { account: ACCOUNTS.fees, credit: t.fees_cents },
    { account: ACCOUNTS.concessions, credit: t.concession_cents },
    { account: ACCOUNTS.salesTax, credit: t.tax_cents },
    ...donationLines,
  ]);
  return { order: getOrder(db, orderId) };
}

export function getOrder(db, idOrNumber) {
  const order = typeof idOrNumber === 'number' || /^\d+$/.test(String(idOrNumber))
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(idOrNumber))
    : db.prepare('SELECT * FROM orders WHERE order_number = ?').get(idOrNumber);
  if (!order) throw notFound('Order');
  order.lines = db.prepare('SELECT kind, description, quantity, unit_cents, amount_cents FROM order_lines WHERE order_id = ? ORDER BY id').all(order.id);
  order.tickets = db.prepare(`${TICKET_SELECT} WHERE t.order_id = ? ORDER BY p.starts_at, t.id`).all(order.id);
  order.donations = db.prepare(`SELECT d.*, f.name AS fund_name, f.entity_name, f.ein FROM donations d JOIN funds f ON f.id = d.fund_id WHERE d.order_id = ?`).all(order.id);
  order.payments = db.prepare('SELECT kind, method, provider, provider_ref, card_brand, card_last4, amount_cents, created_at FROM payments WHERE order_id = ?').all(order.id);
  return order;
}

export const TICKET_SELECT = `
  SELECT t.id, t.code, t.order_id, t.performance_id, t.status, t.holder_name, t.holder_email, t.price_cents, t.fee_cents, t.scanned_at, t.series_id,
         p.starts_at, p.seating_mode, e.id AS event_id, e.title AS event_title, e.image_url, st.name AS stage_name, v.name AS venue_name, v.address AS venue_address,
         sc.name AS section, se.row_label, se.seat_number, pl.name AS price_level, sr.name AS series_name
  FROM tickets t
  JOIN performances p ON p.id = t.performance_id
  JOIN events e ON e.id = p.event_id
  JOIN stages st ON st.id = p.stage_id
  JOIN venues v ON v.id = st.venue_id
  LEFT JOIN seats se ON se.id = t.seat_id
  LEFT JOIN sections sc ON sc.id = se.section_id
  LEFT JOIN price_levels pl ON pl.id = t.price_level_id
  LEFT JOIN series sr ON sr.id = t.series_id`;

function sendConfirmation(db, orderId, baseUrl) {
  const order = getOrder(db, orderId);
  const ticketLines = order.tickets.map((t) => `  • ${t.event_title} — ${t.starts_at} UTC — ${t.section ? `${t.section} Row ${t.row_label} Seat ${t.seat_number}` : 'General Admission'}\n    ${baseUrl}/ticket.html?code=${t.code}`);
  queueEmail(db, {
    to: order.email,
    subject: `Your order ${order.order_number}`,
    kind: 'order_confirmation',
    body: [`Hi ${order.name},`, '', `Thank you for your order ${order.order_number}. Total charged: ${formatMoney(order.total_cents)}.`, '',
      ...(ticketLines.length ? ['Your mobile tickets:', ...ticketLines, ''] : []),
      ...order.lines.map((l) => `${l.description} x${l.quantity}: ${formatMoney(l.amount_cents)}`)].join('\n'),
  });
  // One acknowledgment per receiving legal entity, as each issues its own receipt.
  const byEntity = new Map();
  for (const d of order.donations) {
    const key = `${d.entity_name}|${d.ein || ''}`;
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key).push(d);
  }
  for (const gifts of byEntity.values()) {
    const g0 = gifts[0];
    const deductible = gifts.reduce((s, d) => s + d.deductible_cents, 0);
    queueEmail(db, {
      to: order.email,
      subject: `Donation receipt from ${g0.entity_name}`,
      kind: 'donation_receipt',
      body: [`${g0.entity_name}${g0.ein ? ` (EIN ${g0.ein})` : ''}`, `Donor: ${order.name}`, `Date: ${order.created_at}`, '',
        ...gifts.map((d) => `Receipt ${d.receipt_number}: ${d.fund_name} — ${formatMoney(d.amount_cents)}`), '',
        deductible ? `Tax-deductible amount: ${formatMoney(deductible)}. No goods or services were provided in exchange for this contribution.`
          : 'This contribution is not tax-deductible.'].join('\n'),
    });
  }
}

/** Full refund: gateway refund, void tickets, release seats, reverse journal. */
export async function refundOrder(db, gateway, orderId, user, reason = '') {
  const order = getOrder(db, orderId);
  if (order.status === 'refunded') throw conflict('Order already refunded');
  if (order.tickets.some((t) => t.status === 'scanned')) throw conflict('Order has tickets that were already scanned');
  const charge = order.payments.find((p) => p.kind === 'charge');
  let refund = null;
  if (charge && charge.method === 'card' && order.total_cents > 0) refund = await gateway.refund({ ref: charge.provider_ref, amountCents: order.total_cents });
  transaction(db, () => {
    db.prepare("UPDATE tickets SET status = 'void' WHERE order_id = ?").run(order.id);
    db.prepare("UPDATE donations SET status = 'refunded' WHERE order_id = ?").run(order.id);
    db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(order.id);
    db.prepare("UPDATE ticket_transfers SET status = 'cancelled' WHERE status = 'pending' AND ticket_id IN (SELECT id FROM tickets WHERE order_id = ?)").run(order.id);
    if (charge) {
      db.prepare('INSERT INTO payments (order_id, kind, method, provider, provider_ref, amount_cents) VALUES (?, ?, ?, ?, ?, ?)')
        .run(order.id, 'refund', charge.method, charge.provider, refund?.ref ?? null, -order.total_cents);
    }
    reverseOrder(db, order.id, `Refund ${order.order_number}${reason ? `: ${reason}` : ''}`);
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)').run(user?.id ?? null, 'order.refund', 'order', order.id, reason);
  });
  queueEmail(db, { to: order.email, subject: `Refund for order ${order.order_number}`, kind: 'refund', body: `Your order ${order.order_number} has been refunded (${formatMoney(order.total_cents)}). All tickets on the order are now void.` });
  return getOrder(db, order.id);
}

