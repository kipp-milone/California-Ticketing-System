import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  city TEXT,
  postal_code TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'patron' CHECK (role IN ('patron','admin','boxoffice','scanner','finance','marketing')),
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  seating_type TEXT NOT NULL CHECK (seating_type IN ('assigned','general')),
  ga_capacity INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  stage_id INTEGER NOT NULL REFERENCES stages(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  row_label TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  zone TEXT NOT NULL DEFAULT 'A',
  accessible INTEGER NOT NULL DEFAULT 0,
  UNIQUE (section_id, row_label, seat_number)
);

-- Legal entities that can receive tax-deductible donations (e.g. the agency's
-- foundation, a resident company, an education fund).
CREATE TABLE IF NOT EXISTS funds (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  ein TEXT,
  gl_account TEXT NOT NULL,
  tax_deductible INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A performance is one dated occurrence of an event on a stage. All sales
-- parameters are per performance so each can be configured independently.
CREATE TABLE IF NOT EXISTS performances (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  stage_id INTEGER NOT NULL REFERENCES stages(id),
  starts_at TEXT NOT NULL,
  seating_mode TEXT NOT NULL CHECK (seating_mode IN ('assigned','general')),
  capacity INTEGER NOT NULL DEFAULT 0,
  on_sale_at TEXT,
  off_sale_at TEXT,
  max_per_order INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled'))
);

-- Price levels (Adult, Student, Comp...). For assigned seating, zone restricts
-- the level to seats in that zone; NULL applies to any seat / GA.
CREATE TABLE IF NOT EXISTS price_levels (
  id INTEGER PRIMARY KEY,
  performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  zone TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  public INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('series','subscription')),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  fee_cents INTEGER NOT NULL DEFAULT 0,
  on_sale_at TEXT,
  off_sale_at TEXT,
  max_per_order INTEGER NOT NULL DEFAULT 8,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','cancelled'))
);

CREATE TABLE IF NOT EXISTS series_performances (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  performance_id INTEGER NOT NULL REFERENCES performances(id),
  PRIMARY KEY (series_id, performance_id)
);

CREATE TABLE IF NOT EXISTS seat_holds (
  id INTEGER PRIMARY KEY,
  performance_id INTEGER NOT NULL REFERENCES performances(id),
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  cart_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (performance_id, seat_id)
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  percent_off INTEGER NOT NULL DEFAULT 0 CHECK (percent_off BETWEEN 0 AND 100),
  amount_off_cents INTEGER NOT NULL DEFAULT 0,
  event_id INTEGER REFERENCES events(id),
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('web','mobile','boxoffice','pos','api')),
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  fees_cents INTEGER NOT NULL DEFAULT 0,
  donation_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  promo_code_id INTEGER REFERENCES promo_codes(id),
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('ticket','subscription','donation','concession','fee','discount','tax')),
  description TEXT NOT NULL,
  ref_id INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  performance_id INTEGER NOT NULL REFERENCES performances(id),
  seat_id INTEGER REFERENCES seats(id),
  price_level_id INTEGER REFERENCES price_levels(id),
  series_id INTEGER REFERENCES series(id),
  price_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  holder_name TEXT NOT NULL,
  holder_email TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','scanned','void')),
  scanned_at TEXT,
  scanned_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ticket_seat ON tickets(performance_id, seat_id) WHERE seat_id IS NOT NULL AND status != 'void';
CREATE INDEX IF NOT EXISTS ix_ticket_holder ON tickets(holder_email);

CREATE TABLE IF NOT EXISTS ticket_transfers (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER REFERENCES tickets(id),
  code TEXT NOT NULL,
  performance_id INTEGER,
  result TEXT NOT NULL,
  scanned_by INTEGER REFERENCES users(id),
  device TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  fund_id INTEGER NOT NULL REFERENCES funds(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  deductible_cents INTEGER NOT NULL,
  donor_name TEXT NOT NULL,
  donor_email TEXT NOT NULL,
  receipt_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','refunded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('charge','refund')),
  method TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Double-entry journal. Every order and refund posts balanced lines that the
-- finance team exports to the agency's general ledger.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY,
  journal_id TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  account TEXT NOT NULL,
  debit_cents INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_ledger_journal ON ledger_entries(journal_id);

CREATE TABLE IF NOT EXISTS pos_items (
  id INTEGER PRIMARY KEY,
  venue_id INTEGER REFERENCES venues(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Concessions',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  taxable INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','social')),
  subject TEXT,
  body TEXT NOT NULL,
  segment_json TEXT NOT NULL DEFAULT '[]',
  event_id INTEGER REFERENCES events(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  recipients INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  campaign_id INTEGER REFERENCES campaigns(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_exports (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  dataset TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS support_requests (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDatabase(file = process.env.DATABASE_FILE || 'data/ticketing.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// node:sqlite is synchronous, so a BEGIN IMMEDIATE ... COMMIT block is atomic
// with respect to every other request handled by this process.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
