import { api, cart, header, h, $, $$, showError } from './common.js';

header('donate');
const app = $('#app');

async function load() {
  const funds = await api('/funds');
  app.innerHTML = `<h1>Support the arts</h1>
    <p class="muted">Give to one or several organizations in a single checkout. Each organization issues its own tax receipt.</p>
    <form id="give" class="card">
      ${funds.map((f) => `<div class="row" style="align-items:center;border-bottom:1px solid var(--border);padding:10px 0">
        <div><strong>${h(f.name)}</strong><div class="small muted">${h(f.entity_name)}${f.ein ? ` · EIN ${h(f.ein)}` : ''} · ${f.tax_deductible ? 'Tax-deductible' : 'Not tax-deductible'}</div><div class="small">${h(f.description || '')}</div></div>
        <div style="flex:0 0 140px"><label for="f-${f.id}">Amount ($)</label><input id="f-${f.id}" data-fund="${f.id}" type="number" min="0" step="1" inputmode="numeric" placeholder="0"></div></div>`).join('')}
      <div id="msg"></div>
      <button class="primary" style="margin-top:14px">Add gifts to cart</button>
    </form>`;
  $('#give').onsubmit = (e) => {
    e.preventDefault();
    const c = cart.load();
    let n = 0;
    for (const input of $$('input[data-fund]')) {
      const cents = Math.round(Number(input.value || 0) * 100);
      if (!cents) continue;
      if (cents < 100) return showError('#msg', 'Minimum gift is $1');
      const f = funds.find((x) => x.id === Number(input.dataset.fund));
      c.donations.push({ fund_id: f.id, amount_cents: cents, label: `${f.name} (${f.entity_name})` });
      n++;
    }
    if (!n) return showError('#msg', 'Enter an amount for at least one fund');
    cart.save(c);
    location.href = '/cart.html';
  };
}

load().catch((e) => showError(app, e));
