import crypto from 'node:crypto';
import { HttpError, sha256 } from './util.js';

const TOKEN_TTL_SECONDS = 60 * 60 * 12;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueToken(secret, userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function readToken(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(secret, payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

// Populates req.user (staff/patron session) or req.apiKey (integration key).
export function authenticate(db, secret) {
  const userStmt = db.prepare('SELECT id, email, name, role, phone, marketing_opt_in FROM users WHERE id = ?');
  const keyStmt = db.prepare('SELECT id, name, scopes FROM api_keys WHERE key_hash = ? AND active = 1');
  return (req, _res, next) => {
    const header = req.get('authorization') || '';
    if (header.startsWith('Bearer ')) {
      const data = readToken(secret, header.slice(7));
      if (data) req.user = userStmt.get(data.uid) || null;
    }
    const apiKey = req.get('x-api-key');
    if (apiKey) {
      const key = keyStmt.get(sha256(apiKey));
      if (key) req.apiKey = { ...key, scopes: key.scopes.split(',') };
    }
    next();
  };
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in required'));
  next();
}

// Admins can do everything; other staff roles are limited to their area.
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Sign in required'));
    if (req.user.role !== 'admin' && !roles.includes(req.user.role)) return next(new HttpError(403, 'Insufficient permissions'));
    next();
  };
}

// Allow either a staff session with one of the roles, or an API key with the scope.
export function requireRoleOrScope(scope, ...roles) {
  return (req, _res, next) => {
    if (req.apiKey?.scopes.includes(scope)) return next();
    return requireRole(...roles)(req, _res, next);
  };
}

export const STAFF_ROLES = ['admin', 'boxoffice', 'scanner', 'finance', 'marketing'];
