import { api, cart, header, h, money, fmtDate, salesTag, renderSeatMap, $, $$, params, showError } from './common.js';

header('events');
const app = $('#app');
let event;
let perf;
let selected = new Map(); // seat_id -> { seat, price_level_id }

async function load() {
  event = await api(`/events/${params.get('id')}`);
  document.title = `${event.title} · Civic Arts Tickets`;
  const url = encodeURIComponent(location.href);
  const text = encodeURIComponent(`${event.title} — tickets`);
  app.innerHTML = `
    <p><a href="/">← All events</a></p>
    <div class="two-col">
      <div>
        <h1>${h(event.title)}</h1>
        ${event.category ? `<span class="tag">${h(event.category)}</span>` : ''}
        <p>${h(event.description || '')}</p>
        ${event.series.length ? `<p class="small">Part of: ${event.series.map((s) => `<a href="/subscriptions.html#series-${s.id}">${h(s.name)}</a>`).join(', ')}</p>` : ''}
        <h2>Choose a performance</h2>
        <div class="perf-list" id="perfs">${event.performances.map((p) => `
          <div class="perf" data-id="${p.id}">
            <div><strong>${fmtDate(p.starts_at)}</strong><div class="muted small">${h(p.venue_name)} · ${h(p.stage_name)} · ${p.seating_mode === 'assigned' ? 'Reserved seating' : 'General admission'}</div></div>
            <div class="inline">${salesTag(p.sales_status, p.available)}
              <button class="primary" data-pick="${p.id}" ${p.sales_status !== 'on_sale' || !p.available ? 'disabled' : ''}>Select</button></div>
          </div>`).join('') || '<p class="muted">No scheduled performances.</p>'}</div>
        <div id="picker" style="margin-top:20px"></div>
      </div>
      <aside class="card">
        <h3>Share</h3>
        <div class="inline small">
          <a class="btn" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${url}">Facebook</a>
          <a class="btn" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?url=${url}&text=${text}">X</a>
          <a class="btn" href="mailto:?subject=${text}&body=${url}">Email</a>
        </div>
        <h3 style="margin-top:16px">Good to know</h3>
        <ul class="small muted">
          <li>Tickets are delivered to your phone — no printing needed.</li>
          <li>Transfer tickets to friends from your mobile ticket.</li>
          <li>Accessible seating is marked ♿ on the seat map.</li>
        </ul>
      </aside>
    </div>`;
  $('#perfs').onclick = (e) => { const b = e.target.closest('[data-pick]'); if (b) pick(Number(b.dataset.pick)); };
  const want = Number(params.get('performance'));
  if (want && event.performances.some((p) => p.id === want && p.sales_status === 'on_sale')) pick(want);
}

async function pick(id) {
  perf = event.performances.find((p) => p.id === id);
  $$('.perf').forEach((el) => el.classList.toggle('selected', Number(el.dataset.id) === id));
  selected = new Map();
  const picker = $('#picker');
  if (perf.seating_mode === 'general') return renderGA(picker);
  picker.innerHTML = `<div class="card"><h2>Select your seats</h2><p class="muted small">Seats are held for 10 minutes while you check out. Max ${perf.max_per_order} per order.</p>
    <div id="map" class="seatmap"></div><div id="sel"></div><div id="msg"></div></div>`;
  // Restore seats this browser already holds for this performance.
  const c = cart.load();
  const sections = await refreshMap();
  for (const sec of sections) for (const row of sec.rows) for (const seat of row.seats) {
    if (seat.status !== 'mine' || c.items.some((i) => i.seat_id === seat.id && i.performance_id === perf.id)) continue;
    selected.set(seat.id, { seat: { ...seat, label: `${sec.name} Row ${row.label} Seat ${seat.number}` }, price_level_id: levelsForZone(seat.zone)[0]?.id, zone: seat.zone });
  }
  renderSelection();
}

async function refreshMap() {
  const { sections } = await api(`/performances/${perf.id}/seats?cart_token=${cart.load().token}`);
  renderSeatMap($('#map'), sections, toggleSeat);
  return sections;
}

function levelsForZone(zone) {
  return perf.price_levels.filter((l) => !l.zone || l.zone === zone);
}

async function toggleSeat(seat) {
  const token = cart.load().token;
  try {
    if (seat.status === 'mine') {
      await api(`/performances/${perf.id}/holds`, { method: 'DELETE', body: { seat_ids: [seat.id], cart_token: token } });
      selected.delete(seat.id);
      const c = cart.load();
      c.items = c.items.filter((i) => !(i.seat_id === seat.id && i.performance_id === perf.id));
      cart.save(c);
    } else {
      await api(`/performances/${perf.id}/holds`, { method: 'POST', body: { seat_ids: [seat.id], cart_token: token } });
      const lv = levelsForZone(seat.zone);
      selected.set(seat.id, { seat: { ...seat, label: `${seat.section} Row ${seat.row} Seat ${seat.number}` }, price_level_id: lv[0]?.id, zone: seat.zone });
    }
    $('#msg').innerHTML = '';
  } catch (e) { showError('#msg', e); }
  await refreshMap();
  renderSelection();
}

function renderSelection() {
  const el = $('#sel');
  if (!selected.size) { el.innerHTML = '<p class="muted">Tap available seats to select them.</p>'; return; }
  el.innerHTML = `<table><thead><tr><th>Seat</th><th>Ticket type</th></tr></thead><tbody>
    ${[...selected.values()].map(({ seat, price_level_id, zone }) => {
      const levels = levelsForZone(zone || seat.zone);
      return `<tr><td>${h(seat.label)}</td><td><select data-seat="${seat.id}">${levels.map((l) => `<option value="${l.id}" ${l.id === price_level_id ? 'selected' : ''}>${h(l.name)} — ${money(l.price_cents)}${l.fee_cents ? ` + ${money(l.fee_cents)} fee` : ''}</option>`).join('')}</select></td></tr>`;
    }).join('')}</tbody></table>
    <button class="primary" id="add" style="margin-top:12px">Add ${selected.size} seat${selected.size > 1 ? 's' : ''} to cart</button>`;
  $$('select[data-seat]', el).forEach((s) => { s.onchange = () => { selected.get(Number(s.dataset.seat)).price_level_id = Number(s.value); }; });
  $('#add').onclick = () => {
    const c = cart.load();
    for (const { seat, price_level_id } of selected.values()) {
      const lvl = perf.price_levels.find((l) => l.id === Number(price_level_id)) || levelsForZone(seat.zone)[0];
      c.items.push({ type: 'ticket', performance_id: perf.id, price_level_id: lvl.id, seat_id: seat.id, label: `${event.title} · ${fmtDate(perf.starts_at)} · ${seat.label} · ${lvl.name}` });
    }
    cart.save(c);
    location.href = '/cart.html';
  };
}

function renderGA(picker) {
  picker.innerHTML = `<div class="card"><h2>Tickets</h2><p class="muted small">General admission · ${perf.available} remaining · max ${perf.max_per_order} per order</p>
    <form id="ga">${perf.price_levels.map((l) => `<div class="row" style="align-items:center"><div><strong>${h(l.name)}</strong><div class="muted small">${l.price_cents ? money(l.price_cents) : 'Free'}${l.fee_cents ? ` + ${money(l.fee_cents)} fee` : ''}</div></div>
      <div style="flex:0 0 110px"><label class="hidden" for="q-${l.id}">Quantity</label><select id="q-${l.id}" data-level="${l.id}">${Array.from({ length: Math.min(perf.max_per_order, perf.available) + 1 }, (_, i) => `<option>${i}</option>`).join('')}</select></div></div>`).join('')}
    <div id="msg"></div><button class="primary" style="margin-top:12px">Add to cart</button></form></div>`;
  $('#ga').onsubmit = (e) => {
    e.preventDefault();
    const c = cart.load();
    let added = 0;
    for (const s of $$('select[data-level]')) {
      const qty = Number(s.value);
      if (!qty) continue;
      const lvl = perf.price_levels.find((l) => l.id === Number(s.dataset.level));
      c.items.push({ type: 'ticket', performance_id: perf.id, price_level_id: lvl.id, quantity: qty, label: `${event.title} · ${fmtDate(perf.starts_at)} · ${lvl.name} (GA)` });
      added += qty;
    }
    if (!added) return showError('#msg', 'Choose at least one ticket');
    cart.save(c);
    location.href = '/cart.html';
  };
}

load().catch((e) => showError(app, e));
