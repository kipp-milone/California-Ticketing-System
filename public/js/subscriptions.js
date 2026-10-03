import { api, cart, header, h, money, fmtDate, $, showError } from './common.js';

header('subs');
const app = $('#app');

async function load() {
  const series = await api('/series');
  const subs = series.filter((s) => s.kind === 'subscription');
  const groups = series.filter((s) => s.kind === 'series');
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  app.innerHTML = `<h1>Series & Subscriptions</h1>
    <h2>Subscription packages</h2>
    <p class="muted">One purchase, every performance in the package. Seats are assigned best-available and kept together.</p>
    <div class="grid">${subs.map((s) => {
      const onSale = (!s.on_sale_at || t >= s.on_sale_at) && (!s.off_sale_at || t < s.off_sale_at);
      return `<article class="card" id="series-${s.id}"><h3>${h(s.name)}</h3><p class="small">${h(s.description || '')}</p>
        <ul class="small">${s.performances.map((p) => `<li>${h(p.event_title)} — ${fmtDate(p.starts_at)}</li>`).join('')}</ul>
        <p><strong>${money(s.price_cents)}</strong> per package${s.fee_cents ? ` <span class="muted small">+ ${money(s.fee_cents)} fee</span>` : ''}</p>
        <form data-sub="${s.id}" class="row"><div><label>Packages</label><select name="qty">${Array.from({ length: s.max_per_order }, (_, i) => `<option>${i + 1}</option>`).join('')}</select></div>
          <div><label>Seating preference</label><select name="zone"><option value="">Best available</option><option>Premium</option><option>Standard</option><option>Mezzanine</option></select></div>
          <div style="flex:0 0 auto"><button class="primary" ${onSale ? '' : 'disabled'}>${onSale ? 'Add to cart' : 'Not on sale'}</button></div></form></article>`;
    }).join('') || '<p class="muted">No packages on sale.</p>'}</div>
    <h2 style="margin-top:28px">Series</h2>
    <div class="grid">${groups.map((s) => `<article class="card" id="series-${s.id}"><h3>${h(s.name)}</h3><p class="small">${h(s.description || '')}</p>
      <ul class="small">${s.performances.map((p) => `<li><a href="/event.html?id=${p.event_id}&performance=${p.id}">${h(p.event_title)}</a> — ${fmtDate(p.starts_at)}</li>`).join('')}</ul></article>`).join('')}</div>`;
  app.onsubmit = (e) => {
    const form = e.target.closest('form[data-sub]');
    if (!form) return;
    e.preventDefault();
    const s = subs.find((x) => x.id === Number(form.dataset.sub));
    const qty = Number(form.qty.value);
    const c = cart.load();
    c.items.push({ type: 'subscription', series_id: s.id, quantity: qty, zone: form.zone.value || undefined, label: `${s.name} subscription${form.zone.value ? ` (${form.zone.value})` : ''}` });
    cart.save(c);
    location.href = '/cart.html';
  };
}

load().catch((e) => showError(app, e));
