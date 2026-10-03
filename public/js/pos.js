import { api, h, money, session, TEST_CARDS, $, showError } from './common.js';

const app = $('#app');
let items = [];
let venues = [];
const basket = new Map(); // item id -> qty

async function init() {
  if (!session.user || !['admin', 'boxoffice'].includes(session.user.role)) {
    app.innerHTML = '<h1>Concessions POS</h1><p>Box office or admin sign-in required. Third-party POS terminals can integrate with an API key instead (see README).</p><a class="btn primary" href="/account.html?next=/pos.html">Sign in</a>';
    return;
  }
  venues = await api('/venues');
  app.innerHTML = `<div class="two-col"><div>
      <div class="inline"><h1 style="margin:0">Concessions POS</h1>
      <select id="venue" style="width:auto">${venues.map((v) => `<option value="${v.id}">${h(v.name)}</option>`).join('')}</select></div>
      <div id="items" class="pos-grid" style="margin-top:16px"></div></div>
    <aside class="card"><h2>Sale</h2><div id="basket"></div>
      <label for="pay">Payment</label><select id="pay"><option value="cash">Cash</option>${TEST_CARDS.map(([t, l]) => `<option value="${t}">Card: ${h(l)}</option>`).join('')}</select>
      <div id="msg"></div><button id="charge" class="primary" style="width:100%;justify-content:center;margin-top:12px">Charge</button>
      <a class="small" href="/admin/">Admin</a></aside></div>`;
  $('#venue').onchange = loadItems;
  $('#charge').onclick = charge;
  await loadItems();
}

async function loadItems() {
  items = await api(`/pos/items?venue_id=${$('#venue').value}`);
  $('#items').innerHTML = items.map((i) => `<button data-id="${i.id}"><strong>${h(i.name)}</strong><span>${money(i.price_cents)}</span><span class="small muted">${h(i.category)}</span></button>`).join('');
  $('#items').onclick = (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    basket.set(Number(b.dataset.id), (basket.get(Number(b.dataset.id)) || 0) + 1);
    renderBasket();
  };
  renderBasket();
}

async function renderBasket() {
  const el = $('#basket');
  if (!basket.size) { el.innerHTML = '<p class="muted">Tap items to add.</p>'; $('#charge').textContent = 'Charge'; return; }
  const concessions = [...basket].map(([pos_item_id, quantity]) => ({ pos_item_id, quantity }));
  const q = await api('/cart/quote', { method: 'POST', body: { concessions } });
  el.innerHTML = `<table><tbody>${[...basket].map(([id, qty]) => {
    const it = items.find((x) => x.id === id);
    return `<tr><td>${h(it?.name)} × ${qty}</td><td class="num">${money((it?.price_cents || 0) * qty)}</td><td><button class="link" data-dec="${id}" aria-label="Remove one">−</button></td></tr>`;
  }).join('')}<tr><td>Tax</td><td class="num">${money(q.totals.tax_cents)}</td><td></td></tr><tr><th>Total</th><th class="num">${money(q.totals.total_cents)}</th><td></td></tr></tbody></table>`;
  $('#charge').textContent = `Charge ${money(q.totals.total_cents)}`;
  el.onclick = (e) => {
    const b = e.target.closest('[data-dec]');
    if (!b) return;
    const id = Number(b.dataset.dec);
    const n = basket.get(id) - 1;
    if (n <= 0) basket.delete(id); else basket.set(id, n);
    renderBasket();
  };
}

async function charge() {
  if (!basket.size) return;
  const pay = $('#pay').value;
  try {
    const order = await api('/pos/sales', { method: 'POST', body: {
      concessions: [...basket].map(([pos_item_id, quantity]) => ({ pos_item_id, quantity })),
      payment: pay === 'cash' ? { method: 'cash' } : { method: 'card', token: pay },
    } });
    basket.clear();
    await renderBasket();
    $('#msg').innerHTML = `<div class="alert ok">Sale ${h(order.order_number)} complete — ${money(order.total_cents)}</div>`;
  } catch (e) { showError('#msg', e); }
}

init().catch((e) => showError(app, e));
