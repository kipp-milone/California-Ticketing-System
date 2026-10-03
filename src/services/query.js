import { badRequest } from '../util.js';

/**
 * Whitelisted datasets for selective export and marketing segmentation.
 * Filters are [{ field, op, value }] and only reference declared fields, so
 * user input never reaches SQL except as bound parameters.
 */
export const DATASETS = {
  customers: {
    label: 'Customers',
    from: `(SELECT u.id, u.email, u.name, u.phone, u.city, u.postal_code, u.marketing_opt_in, u.created_at,
              COALESCE((SELECT SUM(total_cents) FROM orders o WHERE o.email = u.email AND o.status = 'paid'), 0) AS lifetime_spend_cents,
              (SELECT COUNT(*) FROM orders o WHERE o.email = u.email AND o.status = 'paid') AS order_count,
              COALESCE((SELECT SUM(amount_cents) FROM donations d WHERE d.donor_email = u.email AND d.status = 'received'), 0) AS donation_total_cents,
              (SELECT MAX(created_at) FROM orders o WHERE o.email = u.email) AS last_order_at
            FROM users u WHERE u.role = 'patron') x`,
    fields: {
      id: 'number', email: 'text', name: 'text', phone: 'text', city: 'text', postal_code: 'text', marketing_opt_in: 'boolean', created_at: 'date',
      lifetime_spend_cents: 'number', order_count: 'number', donation_total_cents: 'number', last_order_at: 'date',
    },
    // Relational criteria that aren't simple columns.
    special: {
      attended_event_id: { type: 'number', sql: "EXISTS (SELECT 1 FROM tickets t JOIN performances p ON p.id = t.performance_id WHERE t.holder_email = x.email AND t.status != 'void' AND p.event_id = ?)" },
      donated_to_fund_id: { type: 'number', sql: "EXISTS (SELECT 1 FROM donations d WHERE d.donor_email = x.email AND d.status = 'received' AND d.fund_id = ?)" },
      subscribed_series_id: { type: 'number', sql: "EXISTS (SELECT 1 FROM tickets t WHERE t.holder_email = x.email AND t.status != 'void' AND t.series_id = ?)" },
      event_category: { type: 'text', sql: "EXISTS (SELECT 1 FROM tickets t JOIN performances p ON p.id = t.performance_id JOIN events e ON e.id = p.event_id WHERE t.holder_email = x.email AND t.status != 'void' AND e.category = ?)" },
    },
    order: 'x.id',
  },
  orders: {
    label: 'Orders',
    from: 'orders x',
    fields: {
      id: 'number', order_number: 'text', email: 'text', name: 'text', channel: 'text', status: 'text', payment_method: 'text',
      subtotal_cents: 'number', discount_cents: 'number', fees_cents: 'number', donation_cents: 'number', tax_cents: 'number', total_cents: 'number', created_at: 'date',
    },
    order: 'x.id',
  },
  tickets: {
    label: 'Tickets',
    from: `(SELECT t.id, t.code, t.status, t.holder_name, t.holder_email, t.price_cents, t.fee_cents, t.scanned_at, t.created_at,
              o.order_number, o.channel, p.id AS performance_id, p.starts_at, e.id AS event_id, e.title AS event_title, e.category,
              v.name AS venue, st.name AS stage, sc.name AS section, se.row_label, se.seat_number, pl.name AS price_level, sr.name AS series
            FROM tickets t JOIN orders o ON o.id = t.order_id JOIN performances p ON p.id = t.performance_id JOIN events e ON e.id = p.event_id
            JOIN stages st ON st.id = p.stage_id JOIN venues v ON v.id = st.venue_id LEFT JOIN seats se ON se.id = t.seat_id
            LEFT JOIN sections sc ON sc.id = se.section_id LEFT JOIN price_levels pl ON pl.id = t.price_level_id LEFT JOIN series sr ON sr.id = t.series_id) x`,
    fields: {
      id: 'number', code: 'text', status: 'text', holder_name: 'text', holder_email: 'text', price_cents: 'number', fee_cents: 'number', scanned_at: 'date', created_at: 'date',
      order_number: 'text', channel: 'text', performance_id: 'number', starts_at: 'date', event_id: 'number', event_title: 'text', category: 'text',
      venue: 'text', stage: 'text', section: 'text', row_label: 'text', seat_number: 'number', price_level: 'text', series: 'text',
    },
    order: 'x.id',
  },
  donations: {
    label: 'Donations',
    from: `(SELECT d.id, d.receipt_number, d.donor_name, d.donor_email, d.amount_cents, d.deductible_cents, d.status, d.created_at,
              f.id AS fund_id, f.name AS fund, f.entity_name, f.ein, f.gl_account, o.order_number
            FROM donations d JOIN funds f ON f.id = d.fund_id JOIN orders o ON o.id = d.order_id) x`,
    fields: {
      id: 'number', receipt_number: 'text', donor_name: 'text', donor_email: 'text', amount_cents: 'number', deductible_cents: 'number', status: 'text', created_at: 'date',
      fund_id: 'number', fund: 'text', entity_name: 'text', ein: 'text', gl_account: 'text', order_number: 'text',
    },
    order: 'x.id',
  },
  ledger: {
    label: 'General ledger journal',
    from: '(SELECT l.id, l.journal_id, l.account, l.debit_cents, l.credit_cents, l.memo, l.created_at, o.order_number FROM ledger_entries l LEFT JOIN orders o ON o.id = l.order_id) x',
    fields: { id: 'number', journal_id: 'text', account: 'text', debit_cents: 'number', credit_cents: 'number', memo: 'text', created_at: 'date', order_number: 'text' },
    order: 'x.id',
  },
  scans: {
    label: 'Door scans',
    from: '(SELECT s.id, s.code, s.result, s.performance_id, s.device, s.created_at, u.name AS scanned_by FROM scans s LEFT JOIN users u ON u.id = s.scanned_by) x',
    fields: { id: 'number', code: 'text', result: 'text', performance_id: 'number', device: 'text', created_at: 'date', scanned_by: 'text' },
    order: 'x.id',
  },
};

const OPS = {
  eq: (c) => `${c} = ?`,
  neq: (c) => `${c} != ?`,
  gt: (c) => `${c} > ?`,
  gte: (c) => `${c} >= ?`,
  lt: (c) => `${c} < ?`,
  lte: (c) => `${c} <= ?`,
  contains: (c) => `${c} LIKE ? ESCAPE '\\'`,
  starts_with: (c) => `${c} LIKE ? ESCAPE '\\'`,
  in: null,
  is_empty: (c) => `(${c} IS NULL OR ${c} = '')`,
  not_empty: (c) => `(${c} IS NOT NULL AND ${c} != '')`,
};

function coerce(type, value) {
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw badRequest(`Expected a number, got "${value}"`);
    return n;
  }
  if (type === 'boolean') return value === true || value === 'true' || value === 1 || value === '1' ? 1 : 0;
  return String(value);
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function buildQuery(datasetName, { filters = [], columns, limit } = {}) {
  const ds = DATASETS[datasetName];
  if (!ds) throw badRequest(`Unknown dataset "${datasetName}"`);
  const cols = columns?.length ? columns : Object.keys(ds.fields);
  for (const c of cols) if (!ds.fields[c]) throw badRequest(`Unknown column "${c}" for ${datasetName}`);
  const where = [];
  const params = [];
  for (const f of filters) {
    const special = ds.special?.[f.field];
    if (special) {
      where.push(f.op === 'neq' ? `NOT ${special.sql}` : special.sql);
      params.push(coerce(special.type, f.value));
      continue;
    }
    const type = ds.fields[f.field];
    if (!type) throw badRequest(`Unknown filter field "${f.field}"`);
    if (!(f.op in OPS)) throw badRequest(`Unknown operator "${f.op}"`);
    const col = `x.${f.field}`;
    if (f.op === 'in') {
      const values = (Array.isArray(f.value) ? f.value : String(f.value).split(',')).map((v) => coerce(type, typeof v === 'string' ? v.trim() : v));
      if (!values.length) throw badRequest('"in" requires at least one value');
      where.push(`${col} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    } else if (f.op === 'is_empty' || f.op === 'not_empty') {
      where.push(OPS[f.op](col));
    } else {
      where.push(OPS[f.op](col));
      let v = coerce(type, f.value);
      if (f.op === 'contains') v = `%${escapeLike(String(v))}%`;
      if (f.op === 'starts_with') v = `${escapeLike(String(v))}%`;
      params.push(v);
    }
  }
  const sql = `SELECT ${cols.map((c) => `x.${c}`).join(', ')} FROM ${ds.from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${ds.order}${limit ? ` LIMIT ${Math.min(Number(limit) || 0, 100000)}` : ''}`;
  return { sql, params, columns: cols };
}

export function runQuery(db, datasetName, definition) {
  const { sql, params, columns } = buildQuery(datasetName, definition);
  return { columns, rows: db.prepare(sql).all(...params) };
}

export function describeDatasets() {
  return Object.fromEntries(Object.entries(DATASETS).map(([k, v]) => [k, {
    label: v.label,
    fields: { ...v.fields, ...Object.fromEntries(Object.entries(v.special || {}).map(([sk, sv]) => [sk, `${sv.type} (criteria only)`])) },
  }]));
}

export const OPERATORS = Object.keys(OPS);
