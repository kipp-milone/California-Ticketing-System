// Shared helpers for every page (no build step; plain ES modules).
export const TZ = 'America/Los_Angeles';

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

export const session = {
  get token() { return store.get('ctms_token', null); },
  get user() { return store.get('ctms_user', null); },
  set(token, user) { store.set('ctms_token', token); store.set('ctms_user', user); },
  clear() { store.del('ctms_token'); store.del('ctms_user'); },
};

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && session.token) session.clear();
  if (raw) {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const money = (cents) => (cents == null ? '' : (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const toDate = (s) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
export const fmtDate = (s, opts = {}) => (s ? toDate(s).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', ...opts }) : '');
export const fmtDay = (s) => fmtDate(s, { hour: undefined, minute: undefined });

export function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const params = new URLSearchParams(location.search);

export function showError(target, err) {
  const el = typeof target === 'string' ? $(target) : target;
  if (el) el.innerHTML = `<div class="alert error" role="alert">${h(err.message || err)}</div>`;
}

export function randomToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Cart (persisted in this browser) ----------------------------------
export const cart = {
  load() {
    const c = store.get('ctms_cart', null);
    if (c && c.token) return c;
    const fresh = { token: randomToken(), items: [], donations: [], promo_code: '' };
    store.set('ctms_cart', fresh);
    return fresh;
  },
  save(c) { store.set('ctms_cart', c); renderCartBadge(); },
  clear() { store.del('ctms_cart'); renderCartBadge(); },
  count() { const c = cart.load(); return c.items.reduce((s, i) => s + (i.quantity || 1), 0) + c.donations.length; },
};

function renderCartBadge() {
  const b = $('#cart-count');
  if (!b) return;
  const n = cart.count();
  b.textContent = n;
  b.classList.toggle('hidden', !n);
}

export function header(active = '') {
  const user = session.user;
  const staff = user && user.role !== 'patron';
  const links = [
    ['/', 'Events', 'events'],
    ['/subscriptions.html', 'Series & Subscriptions', 'subs'],
    ['/donate.html', 'Donate', 'donate'],
    ['/tickets.html', 'My Tickets', 'tickets'],
    ['/support.html', 'Help', 'help'],
    ...(staff ? [['/admin/', 'Admin', 'admin']] : []),
    [user ? '/account.html' : '/account.html', user ? user.name.split(' ')[0] : 'Sign in', 'account'],
  ];
  const el = document.createElement('header');
  el.className = 'site-header';
  el.innerHTML = `<div class="inner">
    <a class="brand" href="/">Civic <span>Arts</span> Tickets</a>
    <nav class="nav" aria-label="Main">
      ${links.map(([href, label, key]) => `<a href="${href}" class="${key === active ? 'active' : ''}">${h(label)}</a>`).join('')}
      <a href="/cart.html" class="${active === 'cart' ? 'active' : ''}">Cart<span id="cart-count" class="cart-badge hidden"></span></a>
    </nav></div>`;
  document.body.prepend(el);
  const f = document.createElement('footer');
  f.className = 'site';
  f.innerHTML = 'Box office & 24/7 ticketing support: <a href="/support.html">Help center</a> · <a href="/api/health">System status</a>';
  document.body.append(f);
  renderCartBadge();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

export const SALES_LABELS = {
  on_sale: ['On sale', 'ok'], not_yet_on_sale: ['Not yet on sale', 'warn'], off_sale: ['Online sales closed', 'warn'],
  past: ['Past', ''], cancelled: ['Cancelled', 'bad'], unpublished: ['Unpublished', 'warn'],
};
export function salesTag(status, available) {
  if (status === 'on_sale' && available === 0) return '<span class="tag bad">Sold out</span>';
  const [label, cls] = SALES_LABELS[status] || [status, ''];
  return `<span class="tag ${cls}">${h(label)}</span>`;
}

/**
 * Render an interactive seat map. onToggle(seat) is called when an
 * available or already-selected seat is clicked.
 */
export function renderSeatMap(container, sections, onToggle) {
  container.innerHTML = `<div class="stage-label">STAGE</div>
    ${sections.map((s) => `<div class="sm-section"><h4>${h(s.name)}</h4>
      ${s.rows.map((r) => `<div class="sm-row"><span class="rl">${h(r.label)}</span>
        ${r.seats.map((seat) => `<button type="button" class="seat ${seat.status} z-${h(seat.zone)} ${seat.accessible ? 'accessible' : ''}"
          data-id="${seat.id}" ${seat.status === 'sold' || seat.status === 'held' ? 'disabled' : ''}
          title="${h(`${s.name} Row ${r.label} Seat ${seat.number} — ${seat.zone}${seat.accessible ? ' (accessible)' : ''}`)}"
          aria-label="${h(`${s.name} row ${r.label} seat ${seat.number}, ${seat.zone}, ${seat.status}`)}">${seat.accessible ? '' : seat.number}</button>`).join('')}
        <span class="rl">${h(r.label)}</span></div>`).join('')}</div>`).join('')}
    <div class="legend"><span><i style="background:var(--seat-available)"></i>Available</span><span><i style="background:var(--seat-mine)"></i>Your selection</span><span><i style="background:var(--seat-sold)"></i>Unavailable</span><span>♿ Accessible</span></div>`;
  const byId = new Map();
  for (const s of sections) for (const r of s.rows) for (const seat of r.seats) byId.set(String(seat.id), { ...seat, section: s.name, row: r.label });
  container.onclick = (e) => {
    const b = e.target.closest('button.seat');
    if (!b || b.disabled) return;
    onToggle(byId.get(b.dataset.id));
  };
}

export const TEST_CARDS = [
  ['tok_visa', 'Visa •••• 4242 (approved)'],
  ['tok_mastercard', 'Mastercard •••• 4444 (approved)'],
  ['tok_amex', 'Amex •••• 0005 (approved)'],
  ['tok_declined', 'Card •••• 0002 (declined)'],
];
