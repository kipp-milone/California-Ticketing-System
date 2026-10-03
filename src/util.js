import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const conflict = (msg, details) => new HttpError(409, msg, details);

// Unambiguous alphabet (no 0/O, 1/I/L) so codes can be read aloud or typed.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function randomCode(length = 12) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Normalise ISO-ish timestamps to SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC).
export function toDbTime(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`Invalid date: ${value}`);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body?.[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw badRequest(`Missing required field(s): ${missing.join(', ')}`);
}

export function toInt(value, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be an integer${Number.isFinite(min) ? ` >= ${min}` : ''}`);
  return n;
}

export function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  // Prefix cells that spreadsheet apps would evaluate as formulas.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvEscape).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvEscape(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

// Express 4 does not forward rejected promises to the error handler; wrap
// every handler so async routes behave like sync ones.
export function asyncRouter(express) {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => original(path, ...handlers.map((h) => (typeof h === 'function' && h.length < 4
      ? (req, res, next) => { try { const out = h(req, res, next); if (out && typeof out.catch === 'function') out.catch(next); } catch (err) { next(err); } }
      : h)));
  }
  return router;
}
