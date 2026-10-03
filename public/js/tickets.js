import { api, header, h, fmtDate, session, $, showError, money } from './common.js';

header('tickets');
const app = $('#app');

// Tickets are cached so the wallet still opens without connectivity at the door.
const CACHE_KEY = 'ctms_wallet';

function ticketList(tickets) {
  if (!tickets.length) return '<p class="muted">No upcoming tickets.</p>';
  return `<div class="grid">${tickets.map((t) => `<a class="card event-card" style="text-decoration:none;color:inherit" href="/ticket.html?code=${t.code}">
    <strong>${h(t.event_title)}</strong>
    <span class="small">${fmtDate(t.starts_at)}</span>
    <span class="small muted">${h(t.venue_name)} · ${t.section ? `${h(t.section)} Row ${h(t.row_label)} Seat ${t.seat_number}` : 'General admission'}</span>
    <span>${t.status === 'scanned' ? '<span class="tag">Used</span>' : '<span class="tag ok">Ready</span>'} ${t.series_name ? `<span class="tag">${h(t.series_name)}</span>` : ''}</span></a>`).join('')}</div>`;
}

async function load() {
  let tickets = null;
  if (session.user) {
    try {
      tickets = await api('/me/tickets');
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(tickets)); } catch { /* ignore */ }
    } catch {
      try { tickets = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { tickets = null; }
    }
  }
  app.innerHTML = `<h1>My Tickets</h1>
    ${session.user ? `<p class="muted">Signed in as ${h(session.user.email)}.</p>${ticketList(tickets || [])}` : '<p><a class="btn primary" href="/account.html?next=/tickets.html">Sign in to see your tickets</a></p>'}
    <div class="card" style="margin-top:24px"><h2>Find an order</h2>
      <p class="small muted">Bought as a guest? Look up your order with the order number from your confirmation email.</p>
      <form id="lookup" class="row"><div><label for="on">Order number</label><input id="on" required placeholder="CT-…"></div>
        <div><label for="em">Email</label><input id="em" type="email" required></div><div style="flex:0 0 auto"><button class="primary">Find</button></div></form>
      <div id="result"></div></div>`;
  $('#lookup').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const o = await api('/orders/lookup', { method: 'POST', body: { order_number: $('#on').value.trim(), email: $('#em').value.trim() } });
      $('#result').innerHTML = `<h3>Order ${h(o.order_number)} · ${money(o.total_cents)} · ${h(o.status)}</h3>${ticketList(o.tickets.filter((t) => t.status !== 'void'))}`;
    } catch (err) { showError('#result', err); }
  };
}

load().catch((e) => showError(app, e));
