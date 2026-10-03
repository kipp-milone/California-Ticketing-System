import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';
import { openDatabase, transaction } from '../src/db.js';

const day = 24 * 60 * 60 * 1000;
const at = (daysFromNow, hourUtc) => {
  const d = new Date(Date.now() + daysFromNow * day);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString().replace('T', ' ').slice(0, 19);
};

export const DEMO_USERS = [
  { email: 'admin@example.org', name: 'Avery Admin', role: 'admin', password: 'admin-password-1' },
  { email: 'boxoffice@example.org', name: 'Blake Box Office', role: 'boxoffice', password: 'boxoffice-password-1' },
  { email: 'scanner@example.org', name: 'Sam Scanner', role: 'scanner', password: 'scanner-password-1' },
  { email: 'finance@example.org', name: 'Frankie Finance', role: 'finance', password: 'finance-password-1' },
  { email: 'marketing@example.org', name: 'Morgan Marketing', role: 'marketing', password: 'marketing-password-1' },
  { email: 'patron@example.org', name: 'Pat Patron', role: 'patron', password: 'patron-password-1', marketing_opt_in: 1, city: 'Sacramento' },
];

export function seed(db) {
  transaction(db, () => {
    const user = db.prepare('INSERT INTO users (email, name, role, password_hash, marketing_opt_in, city) VALUES (?, ?, ?, ?, ?, ?)');
    for (const u of DEMO_USERS) user.run(u.email, u.name, u.role, hashPassword(u.password), u.marketing_opt_in ?? 0, u.city ?? null);
    const patrons = [['jordan@example.com', 'Jordan Lee', 1, 'Fresno'], ['casey@example.com', 'Casey Nguyen', 1, 'Sacramento'], ['riley@example.com', 'Riley Garcia', 0, 'Davis']];
    for (const [email, name, opt, city] of patrons) user.run(email, name, 'patron', null, opt, city);

    // ---- Venues & stages
    const venue = db.prepare('INSERT INTO venues (name, address, description) VALUES (?, ?, ?)');
    const stage = db.prepare('INSERT INTO stages (venue_id, name, seating_type, ga_capacity) VALUES (?, ?, ?, ?)');
    const section = db.prepare('INSERT INTO sections (stage_id, name, sort_order) VALUES (?, ?, ?)');
    const seat = db.prepare('INSERT INTO seats (section_id, row_label, seat_number, zone, accessible) VALUES (?, ?, ?, ?, ?)');

    const center = venue.run('Civic Arts Center', '100 Capitol Mall, Sacramento, CA', 'Multi-stage performing arts center').lastInsertRowid;
    const amph = venue.run('Riverside Amphitheater', '1 River Walk, Sacramento, CA', 'Outdoor amphitheater with lawn seating').lastInsertRowid;
    const mainHall = stage.run(center, 'Main Hall', 'assigned', 0).lastInsertRowid;
    const studio = stage.run(center, 'Studio Theater', 'general', 120).lastInsertRowid;
    const lawn = stage.run(amph, 'Lawn Stage', 'general', 800).lastInsertRowid;

    const orch = section.run(mainHall, 'Orchestra', 1).lastInsertRowid;
    for (const row of 'ABCDEFGH') for (let n = 1; n <= 14; n++) seat.run(orch, row, n, 'ABC'.includes(row) ? 'Premium' : 'Standard', row === 'H' && n <= 4 ? 1 : 0);
    const mezz = section.run(mainHall, 'Mezzanine', 2).lastInsertRowid;
    for (const row of 'JKL') for (let n = 1; n <= 12; n++) seat.run(mezz, row, n, 'Mezzanine', 0);

    // ---- Donation funds across multiple legal entities
    const fund = db.prepare('INSERT INTO funds (name, entity_name, ein, gl_account, tax_deductible, description) VALUES (?, ?, ?, ?, ?, ?)');
    fund.run('Annual Fund', 'Civic Arts Foundation', '95-1234567', '2410 Due to Civic Arts Foundation', 1, 'Supports programming across all stages');
    fund.run('Education & Outreach', 'Civic Arts Foundation', '95-1234567', '2411 Due to Civic Arts Foundation - Education', 1, 'Student matinees and school residencies');
    fund.run('Valley Symphony Association', 'Valley Symphony Association', '95-7654321', '2420 Due to Valley Symphony Association', 1, 'Our resident orchestra');
    fund.run('Building Improvement Fund', 'City Performing Arts Agency', null, '4510 Contributions - Capital', 1, 'Capital improvements to agency facilities');

    // ---- Events, performances, price levels
    const event = db.prepare("INSERT INTO events (title, description, category, image_url, status) VALUES (?, ?, ?, ?, 'published')");
    const perf = db.prepare('INSERT INTO performances (event_id, stage_id, starts_at, seating_mode, capacity, on_sale_at, max_per_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const level = db.prepare('INSERT INTO price_levels (performance_id, name, zone, price_cents, fee_cents, public) VALUES (?, ?, ?, ?, ?, ?)');
    const onSale = at(-7, 17);
    const hallLevels = (p, scale = 1) => {
      level.run(p, 'Premium', 'Premium', Math.round(8500 * scale), 500, 1);
      level.run(p, 'Standard', 'Standard', Math.round(5500 * scale), 400, 1);
      level.run(p, 'Mezzanine', 'Mezzanine', Math.round(3500 * scale), 300, 1);
      level.run(p, 'Student / Youth', null, 2000, 200, 1);
      level.run(p, 'Complimentary', null, 0, 0, 0);
    };

    const symphony = event.run('Valley Symphony: Season Opener', 'Beethoven 7 and a world premiere by a California composer.', 'Classical', null).lastInsertRowid;
    const s1 = perf.run(symphony, mainHall, at(14, 3), 'assigned', 0, onSale, 10).lastInsertRowid;
    const s2 = perf.run(symphony, mainHall, at(15, 3), 'assigned', 0, onSale, 10).lastInsertRowid;
    hallLevels(s1); hallLevels(s2);

    const nutcracker = event.run('The Nutcracker', 'The holiday classic with the Capital Ballet and live orchestra.', 'Dance', null).lastInsertRowid;
    const n1 = perf.run(nutcracker, mainHall, at(30, 3), 'assigned', 0, onSale, 8).lastInsertRowid;
    const n2 = perf.run(nutcracker, mainHall, at(31, 21), 'assigned', 0, onSale, 8).lastInsertRowid;
    const n3 = perf.run(nutcracker, mainHall, at(32, 3), 'assigned', 0, onSale, 8).lastInsertRowid;
    for (const p of [n1, n2, n3]) hallLevels(p, 1.2);

    const symphony2 = event.run('Valley Symphony: Winter Pops', 'Film scores and holiday favorites.', 'Classical', null).lastInsertRowid;
    const w1 = perf.run(symphony2, mainHall, at(45, 3), 'assigned', 0, onSale, 10).lastInsertRowid;
    hallLevels(w1);

    const jazz = event.run('Jazz in the Studio', 'An intimate evening of small-group jazz. General admission, cabaret seating.', 'Jazz', null).lastInsertRowid;
    const j1 = perf.run(jazz, studio, at(10, 3), 'general', 120, onSale, 6).lastInsertRowid;
    const j2 = perf.run(jazz, studio, at(24, 3), 'general', 100, onSale, 6).lastInsertRowid;
    // A show later today so the door scanner has something to admit in demos.
    const tonight = new Date(Date.now() + 4 * 60 * 60 * 1000);
    tonight.setUTCMinutes(0, 0, 0);
    const j0 = perf.run(jazz, studio, tonight.toISOString().replace('T', ' ').slice(0, 19), 'general', 120, onSale, 6).lastInsertRowid;
    for (const p of [j0, j1, j2]) { level.run(p, 'General Admission', null, 3000, 300, 1); level.run(p, 'Student', null, 1500, 150, 1); }

    const community = event.run('Community Arts Day', 'Free outdoor performances by local schools and community groups. Tickets are free but required.', 'Family', null).lastInsertRowid;
    const c1 = perf.run(community, lawn, at(20, 18), 'general', 800, onSale, 8).lastInsertRowid;
    level.run(c1, 'Free Admission', null, 0, 0, 1);

    const shakes = event.run('Shakespeare Under the Stars: Twelfth Night', 'Bring a blanket for lawn seating.', 'Theater', null).lastInsertRowid;
    const sh1 = perf.run(shakes, lawn, at(27, 2), 'general', 600, onSale, 10).lastInsertRowid;
    level.run(sh1, 'Lawn', null, 2500, 250, 1);
    level.run(sh1, 'Child (under 12)', null, 0, 0, 1);

    const upcoming = event.run('Spring Musical: Into the Woods', 'On sale soon.', 'Theater', null).lastInsertRowid;
    const u1 = db.prepare('INSERT INTO performances (event_id, stage_id, starts_at, seating_mode, capacity, on_sale_at, max_per_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(upcoming, mainHall, at(120, 3), 'assigned', 0, at(30, 17), 8).lastInsertRowid;
    hallLevels(u1);

    // ---- Series & subscriptions
    const series = db.prepare('INSERT INTO series (name, description, kind, price_cents, fee_cents, on_sale_at, max_per_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const sp = db.prepare('INSERT INTO series_performances (series_id, performance_id) VALUES (?, ?)');
    const sub = series.run('Symphony Season Subscription', 'Three concerts, same great seats, ~20% off single tickets. Best available seats are assigned automatically.', 'subscription', 15000, 600, onSale, 4).lastInsertRowid;
    for (const p of [s1, n1, w1]) sp.run(sub, p);
    const jazzSub = series.run('Jazz Two-Pack', 'Both Jazz in the Studio nights.', 'subscription', 5000, 300, onSale, 4).lastInsertRowid;
    for (const p of [j1, j2]) sp.run(jazzSub, p);
    const outdoor = series.run('Summer Outdoor Series', 'Everything on the Riverside lawn.', 'series', 0, 0, onSale, 10).lastInsertRowid;
    for (const p of [c1, sh1]) sp.run(outdoor, p);

    db.prepare("INSERT INTO promo_codes (code, description, percent_off, max_uses) VALUES ('WELCOME10', '10% off single tickets', 10, 500)").run();
    db.prepare('INSERT INTO promo_codes (code, description, amount_off_cents, event_id) VALUES (?, ?, ?, ?)').run('NUTTY5', '$5 off The Nutcracker', 500, nutcracker);

    // ---- Concessions
    const item = db.prepare('INSERT INTO pos_items (venue_id, name, category, price_cents, taxable) VALUES (?, ?, ?, ?, ?)');
    item.run(null, 'Bottled Water', 'Beverages', 300, 0);
    item.run(null, 'Soda', 'Beverages', 400, 1);
    item.run(center, 'Glass of Wine', 'Bar', 1200, 1);
    item.run(center, 'Craft Beer', 'Bar', 1000, 1);
    item.run(null, 'Popcorn', 'Snacks', 500, 0);
    item.run(null, 'Candy', 'Snacks', 400, 1);
    item.run(center, 'Program Book', 'Merchandise', 1000, 1);
    item.run(amph, 'Lawn Chair Rental', 'Rentals', 800, 1);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDatabase();
  if (db.prepare('SELECT 1 FROM venues LIMIT 1').get()) {
    console.error('Database already contains data; delete the data/ directory to reseed.');
    process.exit(1);
  }
  seed(db);
  console.log('Seeded demo data. Staff logins:');
  for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(10)} ${u.email} / ${u.password}`);
}
