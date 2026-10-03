import { api, cart, header, h, money, session, TEST_CARDS, $, showError, fmtDate } from './common.js';

header('cart');
const app = $('#app');
let funds = [];
let quote = null;

export function payload(c, extra = {}) {
  return {
    cart_token: c.token,
    items: c.items.map(({ label, ...i }) => i),
    donations: c.donations.map(({ fund_id, amount_cents }) => ({ fund_id, amount_cents })),
    promo_code: c.promo_code || undefined,
    channel: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'web',
    ...extra,
  };
}

async function render() {
  const c = cart.load();
  if (!funds.length) funds = await api('/funds');
  if (!c.items.length && !c.donations.length) {
    app.innerHTML = '<h1>Your cart</h1><p class="muted">Your cart is empty.</p><a class="btn primary" href="/">Browse events</a> <a class="btn" href="/donate.html">Make a donation</a>';
    return;
  }
  let quoteErr = null;
  try { quote = await api('/cart/quote', { method: 'POST', body: payload(c) }); } catch (e) { quote = null; quoteErr = e; }
  const user = session.user;
  app.innerHTML = `<h1>Your cart</h1>
    <div class="two-col">
      <div>
        <div class="card"><h2>Items</h2>
          <table><tbody>${c.items.map((i, idx) => `<tr><td>${h(i.label)}${i.quantity > 1 ? ` × ${i.quantity}` : ''}</td><td class="num"><button class="link" data-rm-item="${idx}">Remove</button></td></tr>`).join('')}
          ${c.donations.map((d, idx) => `<tr><td>Donation: ${h(d.label)}</td><td class="num">${money(d.amount_cents)} <button class="link" data-rm-don="${idx}">Remove</button></td></tr>`).join('')}</tbody></table>
        </div>
        <div class="card"><h2>Add a tax-deductible gift</h2>
          <p class="small muted">Support one or more organizations in this same transaction. Each organization sends its own receipt.</p>
          <form id="don" class="row">
            <div><label for="fund">Fund</label><select id="fund">${funds.map((f) => `<option value="${f.id}">${h(f.name)}${f.entity_name !== f.name ? ` — ${h(f.entity_name)}` : ''}</option>`).join('')}</select></div>
            <div style="flex:0 0 130px"><label for="amt">Amount ($)</label><input id="amt" type="number" min="1" step="1" value="25" inputmode="numeric"></div>
            <div style="flex:0 0 auto"><button>Add gift</button></div>
          </form>
        </div>
        <div class="card"><h2>Your details</h2>
          <form id="checkout">
            <div class="row"><div><label for="name">Full name</label><input id="name" required autocomplete="name" value="${h(user?.name || '')}"></div>
            <div><label for="email">Email (tickets are sent here)</label><input id="email" type="email" required autocomplete="email" value="${h(user?.email || '')}"></div></div>
            <div id="pay" class="${quote && quote.totals.total_cents === 0 ? 'hidden' : ''}">
              <h3 style="margin-top:16px">Payment</h3>
              <label for="card">Card <span class="muted small">(sandbox processor — use a test card)</span></label>
              <select id="card">${TEST_CARDS.map(([t, l]) => `<option value="${t}">${h(l)}</option>`).join('')}</select>
            </div>
            <div id="msg">${quoteErr ? `<div class="alert error">${h(quoteErr.message)}</div>` : ''}</div>
            <button class="primary" id="place" style="margin-top:14px;width:100%;justify-content:center" ${quote ? '' : 'disabled'}>${quote && quote.totals.total_cents === 0 ? 'Get free tickets' : `Pay ${quote ? money(quote.totals.total_cents) : ''}`}</button>
          </form>
        </div>
      </div>
      <aside class="card">
        <h2>Summary</h2>
        ${quote ? `<table><tbody>
          ${quote.lines.map((l) => `<tr><td class="small">${h(l.description)}${l.quantity > 1 ? ` × ${l.quantity}` : ''}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}
          <tr><th>Total</th><th class="num">${money(quote.totals.total_cents)}</th></tr></tbody></table>` : ''}
        <form id="promo" class="row" style="margin-top:10px"><div><label for="code">Promo code</label><input id="code" value="${h(c.promo_code || '')}"></div><div style="flex:0 0 auto"><button>${c.promo_code ? 'Update' : 'Apply'}</button></div></form>
      </aside>
    </div>`;

  app.onclick = async (e) => {
    const ri = e.target.closest('[data-rm-item]');
    const rd = e.target.closest('[data-rm-don]');
    if (!ri && !rd) return;
    const cc = cart.load();
    if (ri) {
      const [item] = cc.items.splice(Number(ri.dataset.rmItem), 1);
      if (item.seat_id) await api(`/performances/${item.performance_id}/holds`, { method: 'DELETE', body: { seat_ids: [item.seat_id], cart_token: cc.token } }).catch(() => {});
    } else cc.donations.splice(Number(rd.dataset.rmDon), 1);
    cart.save(cc);
    render();
  };
  $('#don').onsubmit = (e) => {
    e.preventDefault();
    const fund = funds.find((f) => f.id === Number($('#fund').value));
    const cents = Math.round(Number($('#amt').value) * 100);
    if (!(cents >= 100)) return showError('#msg', 'Minimum gift is $1');
    const cc = cart.load();
    cc.donations.push({ fund_id: fund.id, amount_cents: cents, label: `${fund.name} (${fund.entity_name})` });
    cart.save(cc);
    render();
  };
  $('#promo').onsubmit = (e) => {
    e.preventDefault();
    const cc = cart.load();
    cc.promo_code = $('#code').value.trim();
    cart.save(cc);
    render();
  };
  $('#checkout').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#place');
    btn.disabled = true;
    btn.textContent = 'Processing…';
    try {
      const order = await api('/checkout', { method: 'POST', body: payload(cart.load(), {
        customer: { name: $('#name').value, email: $('#email').value },
        payment: { method: 'card', token: $('#card').value },
      }) });
      cart.clear();
      confirmation(order);
    } catch (err) {
      showError('#msg', err);
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  };
}

function confirmation(order) {
  app.innerHTML = `<div class="card" style="max-width:720px;margin:0 auto">
    <h1>Thank you, ${h(order.name.split(' ')[0])}!</h1>
    <p>Order <strong>${h(order.order_number)}</strong> is confirmed. A confirmation has been sent to ${h(order.email)}.</p>
    ${order.tickets.length ? `<h2>Your mobile tickets</h2><table><tbody>${order.tickets.map((t) => `<tr><td>${h(t.event_title)}<div class="small muted">${fmtDate(t.starts_at)} · ${t.section ? `${h(t.section)} Row ${h(t.row_label)} Seat ${t.seat_number}` : 'General admission'}</div></td>
      <td class="num"><a class="btn" href="/ticket.html?code=${t.code}">View ticket</a></td></tr>`).join('')}</tbody></table>` : ''}
    ${order.donations.length ? `<h2>Gifts</h2><ul>${order.donations.map((d) => `<li>${money(d.amount_cents)} to ${h(d.fund_name)} (${h(d.entity_name)}) — receipt ${h(d.receipt_number)}</li>`).join('')}</ul>` : ''}
    <p><strong>Total: ${money(order.total_cents)}</strong>${order.payments[0]?.card_last4 ? ` charged to ${h(order.payments[0].card_brand)} •••• ${h(order.payments[0].card_last4)}` : ''}</p>
    <a class="btn primary" href="/tickets.html">Go to My Tickets</a></div>`;
}

render().catch((e) => showError(app, e));
