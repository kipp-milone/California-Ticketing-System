import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seed, DEMO_USERS } from '../scripts/seed.js';

let server;
let base;
let db;
const tokens = {};

async function api(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

const cartToken = () => `cart-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const perfByTitle = (title) => db.prepare('SELECT p.* FROM performances p JOIN events e ON e.id = p.event_id WHERE e.title = ? ORDER BY p.starts_at').all(title);
const level = (perfId, name) => db.prepare('SELECT * FROM price_levels WHERE performance_id = ? AND name = ?').get(perfId, name);
const freeSeat = (perfId, zone) => db.prepare(`SELECT st.id FROM seats st JOIN sections sc ON sc.id = st.section_id JOIN performances p ON p.stage_id = sc.stage_id
  WHERE p.id = ? AND st.zone = ? AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.performance_id = p.id AND t.seat_id = st.id AND t.status != 'void')
  AND NOT EXISTS (SELECT 1 FROM seat_holds h WHERE h.performance_id = p.id AND h.seat_id = st.id) ORDER BY st.id LIMIT 1`).get(perfId, zone).id;

before(async () => {
  db = openDatabase(':memory:');
  seed(db);
  const app = createApp({ db, secret: 'test-secret' });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of DEMO_USERS) {
    const { data } = await api('POST', '/auth/login', { body: { email: u.email, password: u.password } });
    tokens[u.role] = data.token;
  }
});

after(() => server.close());

test('catalog lists published upcoming events with performances and prices', async () => {
  const { status, data } = await api('GET', '/events');
  assert.equal(status, 200);
  assert.ok(data.length >= 5);
  const jazz = data.find((e) => e.title === 'Jazz in the Studio');
  assert.equal(jazz.performances.length, 3);
  assert.equal(jazz.performances[0].seating_mode, 'general');
  assert.equal(jazz.performances[0].sales_status, 'on_sale');
  const musical = data.find((e) => e.title.startsWith('Spring Musical'));
  assert.equal(musical.performances[0].sales_status, 'not_yet_on_sale');
});

test('assigned seating: hold, checkout with card, mobile ticket, no double sale', async () => {
  const [perf] = perfByTitle('Valley Symphony: Season Opener');
  const seatId = freeSeat(perf.id, 'Premium');
  const cart = cartToken();
  const hold = await api('POST', `/performances/${perf.id}/holds`, { body: { seat_ids: [seatId], cart_token: cart } });
  assert.equal(hold.status, 200);

  // Another customer can't hold or buy the same seat.
  const other = await api('POST', `/performances/${perf.id}/holds`, { body: { seat_ids: [seatId], cart_token: cartToken() } });
  assert.equal(other.status, 409);

  const map = await api('GET', `/performances/${perf.id}/seats?cart_token=${cart}`);
  const status = map.data.sections.flatMap((s) => s.rows.flatMap((r) => r.seats)).find((s) => s.id === seatId).status;
  assert.equal(status, 'mine');

  // Wrong zone price level is rejected.
  const wrong = await api('POST', '/cart/quote', { body: { cart_token: cart, items: [{ type: 'ticket', performance_id: perf.id, price_level_id: level(perf.id, 'Mezzanine').id, seat_id: seatId }] } });
  assert.equal(wrong.status, 400);

  const premium = level(perf.id, 'Premium');
  const order = await api('POST', '/checkout', { body: {
    cart_token: cart, customer: { name: 'Ada Lovelace', email: 'ada@example.com' },
    items: [{ type: 'ticket', performance_id: perf.id, price_level_id: premium.id, seat_id: seatId }],
    payment: { method: 'card', token: 'tok_visa' },
  } });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.equal(order.data.total_cents, premium.price_cents + premium.fee_cents);
  assert.equal(order.data.tickets.length, 1);
  assert.equal(order.data.payments[0].card_last4, '4242');

  const code = order.data.tickets[0].code;
  const ticket = await api('GET', `/tickets/${code}`);
  assert.equal(ticket.data.section, 'Orchestra');
  const qr = await fetch(`${base}/api/tickets/${code}/qr.svg`);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await qr.text(), /<svg/);

  const again = await api('POST', '/checkout', { body: {
    cart_token: cartToken(), customer: { name: 'B', email: 'b@example.com' },
    items: [{ type: 'ticket', performance_id: perf.id, price_level_id: premium.id, seat_id: seatId }], payment: { method: 'card', token: 'tok_visa' },
  } });
  assert.equal(again.status, 409);
});

test('declined card creates no order', async () => {
  const [perf] = perfByTitle('Jazz in the Studio');
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const res = await api('POST', '/checkout', { body: {
    customer: { name: 'D', email: 'd@example.com' }, items: [{ type: 'ticket', performance_id: perf.id, price_level_id: level(perf.id, 'General Admission').id, quantity: 2 }],
    payment: { method: 'card', token: 'tok_declined' },
  } });
  assert.equal(res.status, 402);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before);
});

test('general admission enforces capacity and per-order limits', async () => {
  const [perf] = perfByTitle('Jazz in the Studio');
  const ga = level(perf.id, 'General Admission');
  const tooMany = await api('POST', '/cart/quote', { body: { items: [{ type: 'ticket', performance_id: perf.id, price_level_id: ga.id, quantity: perf.max_per_order + 1 }] } });
  assert.equal(tooMany.status, 400);

  db.prepare('UPDATE performances SET capacity = ? WHERE id = ?').run(db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE performance_id = ? AND status != 'void'").get(perf.id).n + 2, perf.id);
  const over = await api('POST', '/cart/quote', { body: { items: [{ type: 'ticket', performance_id: perf.id, price_level_id: ga.id, quantity: 3 }] } });
  assert.equal(over.status, 409);
  const ok = await api('POST', '/checkout', { body: { customer: { name: 'G', email: 'g@example.com' }, items: [{ type: 'ticket', performance_id: perf.id, price_level_id: ga.id, quantity: 2 }], payment: { token: 'tok_mastercard' } } });
  assert.equal(ok.status, 201);
  const soldOut = await api('GET', `/performances/${perf.id}`);
  assert.equal(soldOut.data.available, 0);
  db.prepare('UPDATE performances SET capacity = 120 WHERE id = ?').run(perf.id);
});

test('$0 tickets check out without payment', async () => {
  const [perf] = perfByTitle('Community Arts Day');
  const res = await api('POST', '/checkout', { body: { customer: { name: 'Free Fan', email: 'free@example.com' }, items: [{ type: 'ticket', performance_id: perf.id, price_level_id: level(perf.id, 'Free Admission').id, quantity: 4 }] } });
  assert.equal(res.status, 201);
  assert.equal(res.data.total_cents, 0);
  assert.equal(res.data.payment_method, 'free');
  assert.equal(res.data.tickets.length, 4);
  assert.equal(res.data.payments.length, 0);
});

test('donations to multiple entities in one transaction with per-entity receipts and ledger', async () => {
  const [perf] = perfByTitle('Jazz in the Studio');
  const funds = db.prepare('SELECT * FROM funds ORDER BY id').all();
  const res = await api('POST', '/checkout', { body: {
    customer: { name: 'Generous Donor', email: 'donor@example.com' },
    items: [{ type: 'ticket', performance_id: perf.id, price_level_id: level(perf.id, 'Student').id, quantity: 1 }],
    donations: [{ fund_id: funds[0].id, amount_cents: 10000 }, { fund_id: funds[1].id, amount_cents: 2500 }, { fund_id: funds[2].id, amount_cents: 5000 }],
    payment: { token: 'tok_amex' },
  } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.donation_cents, 17500);
  assert.equal(res.data.donations.length, 3);
  assert.equal(new Set(res.data.donations.map((d) => d.receipt_number)).size, 3);

  // Two legal entities -> two receipts.
  const receipts = db.prepare("SELECT * FROM outbox WHERE to_email = 'donor@example.com' AND kind = 'donation_receipt'").all();
  assert.equal(receipts.length, 2);
  assert.ok(receipts.some((r) => r.body.includes('95-7654321')));

  const ledger = db.prepare('SELECT account, SUM(debit_cents) d, SUM(credit_cents) c FROM ledger_entries WHERE order_id = ? GROUP BY account').all(res.data.id);
  const byAcct = Object.fromEntries(ledger.map((l) => [l.account, l]));
  assert.equal(byAcct['2410 Due to Civic Arts Foundation'].c, 10000);
  assert.equal(byAcct['2420 Due to Valley Symphony Association'].c, 5000);
  assert.equal(byAcct['1010 Card Clearing'].d, res.data.total_cents);
});

test('subscription allocates best-available seats across all performances', async () => {
  const sub = db.prepare("SELECT * FROM series WHERE name = 'Symphony Season Subscription'").get();
  const res = await api('POST', '/checkout', { body: {
    cart_token: cartToken(), customer: { name: 'Sub Scriber', email: 'sub@example.com' },
    items: [{ type: 'subscription', series_id: sub.id, quantity: 2, zone: 'Standard' }], payment: { token: 'tok_visa' },
  } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.tickets.length, 6);
  assert.equal(res.data.subtotal_cents, 2 * sub.price_cents);
  assert.equal(res.data.tickets.reduce((s, t) => s + t.price_cents, 0), 2 * sub.price_cents);
  // Pairs sit together in each performance.
  const byPerf = Map.groupBy(res.data.tickets, (t) => t.performance_id);
  for (const pair of byPerf.values()) {
    assert.equal(pair[0].row_label, pair[1].row_label);
    assert.equal(Math.abs(pair[0].seat_number - pair[1].seat_number), 1);
  }
});

test('promo codes discount eligible tickets and balance the ledger', async () => {
  const [perf] = perfByTitle('Shakespeare Under the Stars: Twelfth Night');
  const lawn = level(perf.id, 'Lawn');
  const res = await api('POST', '/checkout', { body: { customer: { name: 'P', email: 'promo@example.com' }, promo_code: 'welcome10', items: [{ type: 'ticket', performance_id: perf.id, price_level_id: lawn.id, quantity: 2 }], payment: { token: 'tok_visa' } } });
  assert.equal(res.status, 201);
  assert.equal(res.data.discount_cents, Math.round(lawn.price_cents * 2 * 0.1));
  const bad = await api('POST', '/cart/quote', { body: { promo_code: 'NUTTY5', items: [{ type: 'ticket', performance_id: perf.id, price_level_id: lawn.id, quantity: 1 }] } });
  assert.equal(bad.status, 400);
});

test('ticket transfer re-issues the code; scanning admits once', async () => {
  const [perf] = perfByTitle('Jazz in the Studio');
  const order = await api('POST', '/checkout', { body: { customer: { name: 'Sender', email: 'sender@example.com' }, items: [{ type: 'ticket', performance_id: perf.id, price_level_id: level(perf.id, 'General Admission').id, quantity: 1 }], payment: { token: 'tok_visa' } } });
  const oldCode = order.data.tickets[0].code;
  const start = await api('POST', `/tickets/${oldCode}/transfer`, { body: { to_email: 'friend@example.com', to_name: 'Friend' } });
  assert.equal(start.status, 201);
  const dup = await api('POST', `/tickets/${oldCode}/transfer`, { body: { to_email: 'x@example.com', to_name: 'X' } });
  assert.equal(dup.status, 409);
  const accepted = await api('POST', `/transfers/${start.data.token}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.holder_email, 'friend@example.com');
  assert.notEqual(accepted.data.code, oldCode);

  // Patron cannot scan.
  const denied = await api('POST', '/scan', { token: tokens.patron, body: { code: accepted.data.code } });
  assert.equal(denied.status, 403);
  const window = await api('GET', '/scan/performances', { token: tokens.scanner });
  assert.ok(window.data.some((p) => p.id === perf.id), 'tonight\'s show is in the scanning window');

  const oldScan = await api('POST', '/scan', { token: tokens.scanner, body: { code: oldCode, performance_id: perf.id } });
  assert.equal(oldScan.data.result, 'not_found');
  const wrongPerf = await api('POST', '/scan', { token: tokens.scanner, body: { code: accepted.data.code, performance_id: perfByTitle('Jazz in the Studio')[1].id } });
  assert.equal(wrongPerf.data.result, 'wrong_performance');
  const ok = await api('POST', '/scan', { token: tokens.scanner, body: { code: accepted.data.code.toLowerCase(), performance_id: perf.id } });
  assert.equal(ok.data.result, 'admitted');
  const twice = await api('POST', '/scan', { token: tokens.scanner, body: { code: accepted.data.code, performance_id: perf.id } });
  assert.equal(twice.data.result, 'already_scanned');
});

test('refund voids tickets, releases seats, and reverses the journal', async () => {
  const [, perf] = perfByTitle('Valley Symphony: Season Opener');
  const seatId = freeSeat(perf.id, 'Standard');
  const cart = cartToken();
  const order = await api('POST', '/checkout', { body: { cart_token: cart, customer: { name: 'R', email: 'refund@example.com' }, items: [{ type: 'ticket', performance_id: perf.id, price_level_id: level(perf.id, 'Standard').id, seat_id: seatId }], donations: [{ fund_id: 1, amount_cents: 1000 }], payment: { token: 'tok_visa' } } });
  assert.equal(order.status, 201);
  const forbidden = await api('POST', `/admin/orders/${order.data.id}/refund`, { token: tokens.marketing, body: {} });
  assert.equal(forbidden.status, 403);
  const refund = await api('POST', `/admin/orders/${order.data.id}/refund`, { token: tokens.finance, body: { reason: 'Customer request' } });
  assert.equal(refund.status, 200);
  assert.equal(refund.data.status, 'refunded');
  assert.ok(refund.data.tickets.every((t) => t.status === 'void'));
  const net = db.prepare('SELECT SUM(debit_cents) - SUM(credit_cents) AS n, account FROM ledger_entries WHERE order_id = ? GROUP BY account').all(order.data.id);
  assert.ok(net.every((r) => r.n === 0));
  // Seat can be sold again.
  const resale = await api('POST', '/cart/quote', { body: { items: [{ type: 'ticket', performance_id: perf.id, price_level_id: level(perf.id, 'Standard').id, seat_id: seatId }] } });
  assert.equal(resale.status, 200);
  const tb = await api('GET', '/admin/reports/trial-balance', { token: tokens.finance });
  assert.equal(tb.data.balanced, true);
});

test('box office can sell restricted comps and take cash; patrons cannot', async () => {
  const [perf] = perfByTitle('The Nutcracker');
  const comp = level(perf.id, 'Complimentary');
  const seatId = freeSeat(perf.id, 'Premium');
  const body = { channel: 'boxoffice', customer: { name: 'VIP', email: 'vip@example.com' }, items: [{ type: 'ticket', performance_id: perf.id, price_level_id: comp.id, seat_id: seatId }] };
  const patron = await api('POST', '/checkout', { token: tokens.patron, body });
  assert.equal(patron.status, 403);
  const staff = await api('POST', '/checkout', { token: tokens.boxoffice, body });
  assert.equal(staff.status, 201);
  const [jazz] = perfByTitle('Jazz in the Studio');
  const cash = await api('POST', '/checkout', { token: tokens.boxoffice, body: { channel: 'boxoffice', customer: { name: 'Walk Up', email: 'walkup@example.com' }, items: [{ type: 'ticket', performance_id: jazz.id, price_level_id: level(jazz.id, 'General Admission').id, quantity: 1 }], payment: { method: 'cash' } } });
  assert.equal(cash.status, 201);
  assert.ok(db.prepare("SELECT 1 FROM ledger_entries WHERE order_id = ? AND account = '1000 Cash on Hand'").get(cash.data.id));
});

test('POS sales via API key with sales tax and external payment', async () => {
  const key = await api('POST', '/admin/api-keys', { token: tokens.admin, body: { name: 'Bar terminal', scopes: ['pos'] } });
  assert.equal(key.status, 201);
  const items = (await api('GET', '/pos/items', { headers: { 'x-api-key': key.data.key } })).data;
  const wine = items.find((i) => i.name === 'Glass of Wine');
  const water = items.find((i) => i.name === 'Bottled Water');
  const sale = await api('POST', '/pos/sales', { headers: { 'x-api-key': key.data.key }, body: { concessions: [{ pos_item_id: wine.id, quantity: 2 }, { pos_item_id: water.id, quantity: 1 }], payment: { method: 'external', reference: 'TERM-0001' } } });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(sale.data.channel, 'pos');
  assert.equal(sale.data.tax_cents, Math.round(2400 * 0.0725));
  assert.equal(sale.data.total_cents, 2700 + Math.round(2400 * 0.0725));
  const noKey = await api('POST', '/pos/sales', { body: { concessions: [{ pos_item_id: wine.id }] } });
  assert.equal(noKey.status, 401);
});

test('selective export with criteria returns CSV and rejects unknown fields', async () => {
  const csv = await api('POST', '/admin/exports/run', { token: tokens.finance, body: { dataset: 'donations', columns: ['receipt_number', 'donor_email', 'entity_name', 'amount_cents'], filters: [{ field: 'entity_name', op: 'eq', value: 'Valley Symphony Association' }], format: 'csv' } });
  assert.equal(csv.status, 200);
  const lines = csv.data.trim().split('\r\n');
  assert.equal(lines[0], 'receipt_number,donor_email,entity_name,amount_cents');
  assert.ok(lines.length >= 2);
  assert.ok(lines.slice(1).every((l) => l.includes('Valley Symphony Association')));

  const evil = await api('POST', '/admin/exports/run', { token: tokens.finance, body: { dataset: 'orders', filters: [{ field: 'email; DROP TABLE orders', op: 'eq', value: 'x' }] } });
  assert.equal(evil.status, 400);
  const forbidden = await api('POST', '/admin/exports/run', { token: tokens.marketing, body: { dataset: 'ledger' } });
  assert.equal(forbidden.status, 403);

  const custs = await api('POST', '/admin/exports/run', { token: tokens.admin, body: { dataset: 'customers', filters: [{ field: 'city', op: 'in', value: 'Sacramento,Fresno' }] } });
  assert.ok(custs.data.rows.every((r) => ['Sacramento', 'Fresno'].includes(r.city)));
});

test('email campaign targets opted-in segment and includes unsubscribe', async () => {
  const symphony = db.prepare("SELECT id FROM events WHERE title = 'Valley Symphony: Season Opener'").get();
  const seg = [{ field: 'city', op: 'eq', value: 'Sacramento' }];
  const preview = await api('POST', '/admin/campaigns/preview-segment', { token: tokens.marketing, body: { segment: seg } });
  assert.equal(preview.data.count, 2); // patron@ and casey@ are opted-in in Sacramento
  const c = await api('POST', '/admin/campaigns', { token: tokens.marketing, body: { name: 'Opener promo', channel: 'email', subject: 'Season opener!', body: 'Hi {{name}}, get tickets: {{event_url}}', segment: seg, event_id: symphony.id } });
  const sent = await api('POST', `/admin/campaigns/${c.data.id}/send`, { token: tokens.marketing });
  assert.equal(sent.data.recipients, 2);
  const mail = db.prepare('SELECT * FROM outbox WHERE campaign_id = ?').all(c.data.id);
  assert.ok(mail.every((m) => m.body.includes('Unsubscribe') && !m.body.includes('{{name}}')));
  const resend = await api('POST', `/admin/campaigns/${c.data.id}/send`, { token: tokens.marketing });
  assert.equal(resend.status, 409);
});

test('patron account sees their tickets; off-sale shows are rejected for public', async () => {
  const [perf] = perfByTitle('Jazz in the Studio');
  await api('POST', '/checkout', { token: tokens.patron, body: { items: [{ type: 'ticket', performance_id: perf.id, price_level_id: level(perf.id, 'Student').id, quantity: 1 }], payment: { token: 'tok_visa' } } });
  const mine = await api('GET', '/me/tickets', { token: tokens.patron });
  assert.ok(mine.data.length >= 1);
  const [musical] = perfByTitle('Spring Musical: Into the Woods');
  const early = await api('POST', '/cart/quote', { body: { items: [{ type: 'ticket', performance_id: musical.id, price_level_id: level(musical.id, 'Standard').id, seat_id: freeSeat(musical.id, 'Standard') }] } });
  assert.equal(early.status, 409);
});

test('admin can build a venue, stage, seating chart and performance', async () => {
  const v = await api('POST', '/admin/venues', { token: tokens.admin, body: { name: 'Test Hall' } });
  const st = await api('POST', `/admin/venues/${v.data.id}/stages`, { token: tokens.admin, body: { name: 'Black Box', seating_type: 'assigned' } });
  const sec = await api('POST', `/admin/stages/${st.data.id}/sections`, { token: tokens.admin, body: { name: 'Floor', rows: ['A', 'B'], seats_per_row: 5, zone: 'Floor' } });
  assert.equal(sec.data.seats, 10);
  const ev = await api('POST', '/admin/events', { token: tokens.boxoffice, body: { title: 'New Show', status: 'published' } });
  const p = await api('POST', '/admin/performances', { token: tokens.boxoffice, body: { event_id: ev.data.id, stage_id: st.data.id, starts_at: new Date(Date.now() + 5 * 864e5).toISOString(), price_levels: [{ name: 'Floor', zone: 'Floor', price_cents: 2000 }] } });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const pub = await api('GET', `/performances/${p.data.id}`);
  assert.equal(pub.data.capacity, 10);
  const scannerTry = await api('POST', '/admin/events', { token: tokens.scanner, body: { title: 'Nope' } });
  assert.equal(scannerTry.status, 403);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const { toCsv } = await import('../src/util.js');
  assert.equal(toCsv([{ a: '=HYPERLINK("x")', b: -5 }]), 'a,b\r\n"\'=HYPERLINK(""x"")",-5\r\n');
});
