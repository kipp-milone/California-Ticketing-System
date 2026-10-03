import { api, header, h, money, fmtDate, session, renderSeatMap, randomToken, TEST_CARDS, $, $$, showError } from './common.js';

header('admin');
const app = $('#app');
const role = session.user?.role;

const TABS = [
  ['dashboard', 'Dashboard', null],
  ['events', 'Events & performances', ['boxoffice']],
  ['boxoffice', 'Box office sale', ['boxoffice']],
  ['orders', 'Orders & refunds', ['boxoffice', 'finance']],
  ['venues', 'Venues & seating', []],
  ['series', 'Series & subscriptions', ['boxoffice']],
  ['funds', 'Donation funds', ['finance']],
  ['reports', 'Financial reports', ['finance']],
  ['exports', 'Data exports', null],
  ['marketing', 'Marketing', ['marketing']],
  ['outbox', 'Email outbox', null],
  ['pos', 'POS items', ['boxoffice']],
  ['integrations', 'Integrations', []],
  ['staff', 'Staff', []],
  ['support', 'Support queue', null],
  ['audit', 'Audit log', []],
];
const allowed = (roles) => role === 'admin' || roles === null || roles.includes(role);

// ---- small helpers -------------------------------------------------------
const form = (el) => Object.fromEntries(new FormData(el).entries());
const dollarsToCents = (v) => Math.round(Number(v || 0) * 100);
const table = (cols, rows, empty = 'Nothing here yet.') => (rows.length ? `<div class="table-wrap"><table><thead><tr>${cols.map(([, label, cls]) => `<th class="${cls || ''}">${label}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${cols.map(([key, , cls, fmt]) => `<td class="${cls || ''}">${fmt ? fmt(r[key], r) : h(r[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<p class="muted">${empty}</p>`);
const m = (v) => money(v);
const flash = (sel, text) => { $(sel).innerHTML = `<div class="alert ok">${h(text)}</div>`; };

async function download(path, body, filename) {
  const res = await api(path, { method: body ? 'POST' : 'GET', body, raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- shell ---------------------------------------------------------------
function shell() {
  if (!session.user || role === 'patron') {
    app.innerHTML = '<h1>Admin console</h1><p>Staff sign-in required.</p><a class="btn primary" href="/account.html?next=/admin/">Sign in</a>';
    return;
  }
  const tabs = TABS.filter(([, , r]) => allowed(r));
  app.innerHTML = `<div class="admin-layout"><nav class="admin-nav" aria-label="Admin">${tabs.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}
    <hr style="width:100%;border:0;border-top:1px solid var(--border)"><a class="btn" href="/scan.html">Door scanner</a><a class="btn" href="/pos.html">Concessions POS</a></nav>
    <section id="view"></section></div>`;
  $('.admin-nav').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); };
  window.onhashchange = () => go(location.hash.slice(1), false);
  go(location.hash.slice(1) || 'dashboard', false);
}

async function go(tab, push = true) {
  if (!VIEWS[tab]) tab = 'dashboard';
  if (push) location.hash = tab;
  $$('.admin-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const view = $('#view');
  view.innerHTML = '<p class="muted">Loading…</p>';
  try { await VIEWS[tab](view); } catch (e) { showError(view, e); }
}

// ---- views ---------------------------------------------------------------
const VIEWS = {
  async dashboard(v) {
    const d = await api('/admin/dashboard');
    v.innerHTML = `<h1>Dashboard</h1>
      <div class="stats">
        <div class="stat"><div class="v">${m(d.today.revenue_cents)}</div><div class="l">Sales today (${d.today.orders} orders)</div></div>
        <div class="stat"><div class="v">${m(d.totals.revenue_cents)}</div><div class="l">All-time sales</div></div>
        <div class="stat"><div class="v">${d.tickets_sold.toLocaleString()}</div><div class="l">Tickets issued</div></div>
        <div class="stat"><div class="v">${m(d.totals.donation_cents)}</div><div class="l">Donations</div></div>
        <div class="stat"><div class="v">${d.open_support}</div><div class="l">Open support requests</div></div>
      </div>
      <div class="card"><h2>Upcoming performances</h2>${table([
        ['event_title', 'Event'], ['starts_at', 'Date', '', fmtDate], ['stage_name', 'Stage', '', (s, r) => `${h(r.venue_name)} · ${h(s)}`],
        ['sold', 'Sold / capacity', 'num', (s, r) => `${s} / ${r.capacity}<div class="bar"><span style="width:${r.capacity ? Math.round((100 * s) / r.capacity) : 0}%"></span></div>`],
        ['scanned', 'Scanned', 'num'], ['gross_cents', 'Gross', 'num', m], ['sales_status', 'Status', '', (s) => h(s.replaceAll('_', ' '))],
      ], d.upcoming)}</div>`;
  },

  async events(v) {
    const [events, venues] = await Promise.all([api('/admin/events'), api('/admin/venues')]);
    const stages = venues.flatMap((vn) => vn.stages.map((s) => ({ ...s, venue: vn.name })));
    v.innerHTML = `<h1>Events & performances</h1>
      <details class="card"><summary><strong>New event</strong></summary>
        <form id="ev"><div class="row"><div><label>Title</label><input name="title" required></div><div><label>Category</label><input name="category" placeholder="Classical, Dance, Theater…"></div>
          <div><label>Status</label><select name="status"><option value="draft">Draft</option><option value="published">Published</option></select></div></div>
          <label>Description</label><textarea name="description"></textarea><label>Image URL</label><input name="image_url" type="url">
          <button class="primary" style="margin-top:10px">Create event</button></form></details>
      <details class="card" id="perf-card"><summary><strong>New performance</strong></summary>
        <form id="pf"><div class="row">
          <div><label>Event</label><select name="event_id">${events.map((e) => `<option value="${e.id}">${h(e.title)}</option>`).join('')}</select></div>
          <div><label>Stage</label><select name="stage_id">${stages.map((s) => `<option value="${s.id}" data-type="${s.seating_type}" data-cap="${s.ga_capacity}">${h(s.venue)} · ${h(s.name)} (${s.seating_type})</option>`).join('')}</select></div>
          <div><label>Seating</label><select name="seating_mode"><option value="">Stage default</option><option value="assigned">Assigned</option><option value="general">General admission</option></select></div></div>
          <div class="row"><div><label>Starts (local)</label><input name="starts_at" type="datetime-local" required></div>
          <div><label>On sale</label><input name="on_sale_at" type="datetime-local"></div><div><label>Online sales end</label><input name="off_sale_at" type="datetime-local"></div></div>
          <div class="row"><div><label>GA capacity</label><input name="capacity" type="number" min="1" placeholder="Stage default"></div><div><label>Max per order</label><input name="max_per_order" type="number" min="1" value="10"></div></div>
          <h3 style="margin-top:12px">Price levels</h3><p class="small muted">Zone limits a level to seats in that zone (blank = any seat / GA). Use $0 for free tickets. Uncheck "public" for comps / box-office-only.</p>
          <div id="levels"></div><button type="button" id="addlvl">+ Price level</button>
          <div><button class="primary" style="margin-top:12px">Create performance</button></div></form></details>
      <div id="msg"></div>
      ${events.map((e) => `<div class="card"><div class="inline" style="justify-content:space-between"><h2 style="margin:0">${h(e.title)} <span class="tag ${e.status === 'published' ? 'ok' : e.status === 'cancelled' ? 'bad' : 'warn'}">${e.status}</span></h2>
        <select data-event-status="${e.id}" style="width:auto">${['draft', 'published', 'cancelled'].map((s) => `<option ${s === e.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        ${table([
          ['starts_at', 'Date', '', fmtDate], ['stage_name', 'Stage', '', (s, r) => `${h(r.venue_name)} · ${h(s)} · ${r.seating_mode}`],
          ['sold', 'Sold', 'num', (s, r) => `${s} / ${r.capacity}`], ['sales_status', 'Sales', '', (s) => h(s.replaceAll('_', ' '))],
          ['price_levels', 'Prices', 'small', (pl) => pl.map((l) => `${h(l.name)}${l.zone ? ` [${h(l.zone)}]` : ''} ${m(l.price_cents)}${l.public ? '' : ' (private)'}`).join('<br>')],
          ['id', '', '', (id, r) => `<button class="link" data-manifest="${id}">Manifest CSV</button><br>${r.status === 'cancelled' ? 'Cancelled' : `<button class="link" data-cancel-perf="${id}">Cancel</button>`}`],
        ], e.performances, 'No performances yet.')}</div>`).join('')}`;

    const levelRow = (l = {}) => `<div class="row lvl"><div><label>Name</label><input data-k="name" value="${h(l.name || '')}" required></div><div><label>Zone</label><input data-k="zone" value="${h(l.zone || '')}"></div>
      <div><label>Price $</label><input data-k="price" type="number" min="0" step="0.01" value="${l.price ?? ''}" required></div><div><label>Fee $</label><input data-k="fee" type="number" min="0" step="0.01" value="${l.fee ?? 0}"></div>
      <div style="flex:0 0 auto"><label><input type="checkbox" data-k="public" ${l.public === false ? '' : 'checked'}> public</label></div></div>`;
    $('#levels').innerHTML = levelRow({ name: 'Adult', price: 40, fee: 3 }) + levelRow({ name: 'Student', price: 15, fee: 1 });
    $('#addlvl').onclick = () => $('#levels').insertAdjacentHTML('beforeend', levelRow());
    $('#ev').onsubmit = async (e) => { e.preventDefault(); await api('/admin/events', { method: 'POST', body: form(e.target) }); go('events', false); };
    $('#pf').onsubmit = async (e) => {
      e.preventDefault();
      const f = form(e.target);
      const local = (x) => (x ? new Date(x).toISOString() : null);
      const body = { event_id: Number(f.event_id), stage_id: Number(f.stage_id), seating_mode: f.seating_mode || undefined, starts_at: local(f.starts_at), on_sale_at: local(f.on_sale_at), off_sale_at: local(f.off_sale_at),
        capacity: f.capacity ? Number(f.capacity) : undefined, max_per_order: Number(f.max_per_order || 10),
        price_levels: $$('.lvl').map((row) => { const g = (k) => $(`[data-k=${k}]`, row); return { name: g('name').value, zone: g('zone').value || null, price_cents: dollarsToCents(g('price').value), fee_cents: dollarsToCents(g('fee').value), public: g('public').checked }; }) };
      try { await api('/admin/performances', { method: 'POST', body }); go('events', false); } catch (err) { showError('#msg', err); }
    };
    v.onchange = async (e) => {
      const s = e.target.closest('[data-event-status]');
      if (s) { await api(`/admin/events/${s.dataset.eventStatus}`, { method: 'PATCH', body: { status: s.value } }); go('events', false); }
    };
    v.onclick = async (e) => {
      const mf = e.target.closest('[data-manifest]');
      if (mf) return download(`/admin/performances/${mf.dataset.manifest}/manifest?format=csv`, null, `manifest-${mf.dataset.manifest}.csv`);
      const c = e.target.closest('[data-cancel-perf]');
      if (c && confirm('Cancel this performance? Existing orders must be refunded from Orders.')) { await api(`/admin/performances/${c.dataset.cancelPerf}`, { method: 'PATCH', body: { status: 'cancelled' } }); go('events', false); }
    };
  },

  async boxoffice(v) {
    const events = await api('/admin/events');
    const perfs = events.filter((e) => e.status === 'published').flatMap((e) => e.performances.filter((p) => p.status === 'scheduled').map((p) => ({ ...p, event_title: e.title })));
    const cartToken = randomToken();
    const items = [];
    v.innerHTML = `<h1>Box office sale</h1>
      <div class="card"><label>Performance</label><select id="bp">${perfs.map((p) => `<option value="${p.id}">${h(p.event_title)} — ${fmtDate(p.starts_at)} (${h(p.stage_name)}, ${p.available} avail)</option>`).join('')}</select>
        <div id="picker" style="margin-top:12px"></div></div>
      <div class="card"><h2>Sale</h2><div id="lines"></div>
        <form id="sell"><div class="row"><div><label>Customer name</label><input name="name" required></div><div><label>Email</label><input name="email" type="email" required></div></div>
        <div class="row"><div><label>Payment</label><select name="pay"><option value="cash">Cash</option>${TEST_CARDS.map(([t, l]) => `<option value="${t}">Card: ${h(l)}</option>`).join('')}</select></div>
        <div><label>Donation (optional)</label><input name="don" type="number" min="0" step="1" placeholder="$"></div></div>
        <div id="msg"></div><button class="primary" style="margin-top:10px">Complete sale</button></form></div>`;
    const funds = await api('/funds');
    const renderLines = async () => {
      if (!items.length) { $('#lines').innerHTML = '<p class="muted">Add tickets above.</p>'; return; }
      try {
        const q = await api('/cart/quote', { method: 'POST', body: { cart_token: cartToken, items: items.map(({ label, ...i }) => i) } });
        $('#lines').innerHTML = `${table([['description', 'Item'], ['quantity', 'Qty', 'num'], ['amount', 'Amount', 'num', m]], q.lines)}<p><strong>Total ${m(q.totals.total_cents)}</strong> <button class="link" id="clr">Clear</button></p>`;
        $('#clr').onclick = async () => { items.length = 0; renderLines(); pick(); };
      } catch (e) { showError('#lines', e); }
    };
    const pick = async () => {
      const p = perfs.find((x) => x.id === Number($('#bp').value));
      if (!p) return;
      if (p.seating_mode === 'general') {
        $('#picker').innerHTML = `<form id="ga" class="row">${p.price_levels.map((l) => `<div><label>${h(l.name)} ${m(l.price_cents)}${l.public ? '' : ' (private)'}</label><input type="number" min="0" value="0" data-level="${l.id}"></div>`).join('')}<div style="flex:0 0 auto"><button>Add</button></div></form>`;
        $('#ga').onsubmit = (e) => {
          e.preventDefault();
          $$('[data-level]', e.target).forEach((i) => { if (Number(i.value) > 0) items.push({ type: 'ticket', performance_id: p.id, price_level_id: Number(i.dataset.level), quantity: Number(i.value) }); });
          renderLines();
        };
      } else {
        $('#picker').innerHTML = `<div class="row"><div><label>Price level for next seat</label><select id="lvl">${p.price_levels.map((l) => `<option value="${l.id}" data-zone="${h(l.zone || '')}">${h(l.name)}${l.zone ? ` [${h(l.zone)}]` : ''} ${m(l.price_cents)}${l.public ? '' : ' (private)'}</option>`).join('')}</select></div></div><div id="map" class="seatmap"></div>`;
        const refresh = async () => {
          const { sections } = await api(`/performances/${p.id}/seats?cart_token=${cartToken}`).catch(async () => ({ sections: [] }));
          renderSeatMap($('#map'), sections, async (seat) => {
            try {
              if (seat.status === 'mine') {
                await api(`/performances/${p.id}/holds`, { method: 'DELETE', body: { seat_ids: [seat.id], cart_token: cartToken } });
                const i = items.findIndex((x) => x.seat_id === seat.id);
                if (i >= 0) items.splice(i, 1);
              } else {
                const opt = $('#lvl').selectedOptions[0];
                const zone = opt.dataset.zone;
                const lvl = zone && zone !== seat.zone ? p.price_levels.find((l) => !l.zone || l.zone === seat.zone) : p.price_levels.find((l) => l.id === Number(opt.value));
                await api(`/performances/${p.id}/holds`, { method: 'POST', body: { seat_ids: [seat.id], cart_token: cartToken } });
                items.push({ type: 'ticket', performance_id: p.id, price_level_id: lvl.id, seat_id: seat.id });
              }
            } catch (e) { showError('#msg', e); }
            refresh(); renderLines();
          });
        };
        refresh();
      }
    };
    $('#bp').onchange = pick;
    pick(); renderLines();
    $('#sell').onsubmit = async (e) => {
      e.preventDefault();
      const f = form(e.target);
      const donation = dollarsToCents(f.don);
      try {
        const order = await api('/checkout', { method: 'POST', body: {
          cart_token: cartToken, channel: 'boxoffice', customer: { name: f.name, email: f.email }, items: items.map(({ label, ...i }) => i),
          donations: donation ? [{ fund_id: funds[0].id, amount_cents: donation }] : [],
          payment: f.pay === 'cash' ? { method: 'cash' } : { method: 'card', token: f.pay },
        } });
        items.length = 0;
        v.querySelector('#sell').reset();
        renderLines(); pick();
        flash('#msg', `Order ${order.order_number} complete — ${money(order.total_cents)}. Tickets emailed to ${order.email}.`);
      } catch (err) { showError('#msg', err); }
    };
  },

  async orders(v) {
    v.innerHTML = `<h1>Orders & refunds</h1><form id="q" class="row card"><div><label>Search</label><input name="q" placeholder="Order #, email or name"></div>
      <div><label>Channel</label><select name="channel"><option value="">All</option>${['web', 'mobile', 'boxoffice', 'pos', 'api'].map((c) => `<option>${c}</option>`).join('')}</select></div><div style="flex:0 0 auto"><button>Search</button></div></form>
      <div id="list"></div><div id="detail"></div>`;
    const load = async () => {
      const f = form($('#q'));
      const rows = await api(`/admin/orders?${new URLSearchParams(Object.entries(f).filter(([, x]) => x))}`);
      $('#list').innerHTML = `<div class="card">${table([
        ['order_number', 'Order', '', (n, r) => `<button class="link" data-order="${r.id}">${h(n)}</button>`], ['created_at', 'Date', '', fmtDate], ['name', 'Customer', '', (n, r) => `${h(n)}<div class="small muted">${h(r.email)}</div>`],
        ['channel', 'Channel'], ['payment_method', 'Payment'], ['total_cents', 'Total', 'num', m], ['status', 'Status', '', (s) => `<span class="tag ${s === 'paid' ? 'ok' : 'bad'}">${s}</span>`],
      ], rows)}</div>`;
    };
    $('#q').onsubmit = (e) => { e.preventDefault(); load(); };
    v.onclick = async (e) => {
      const o = e.target.closest('[data-order]');
      if (o) {
        const d = await api(`/admin/orders/${o.dataset.order}`);
        $('#detail').innerHTML = `<div class="card"><h2>Order ${h(d.order_number)} <span class="tag">${d.status}</span></h2>
          <p>${h(d.name)} · ${h(d.email)} · ${h(d.channel)} · ${fmtDate(d.created_at)}</p>
          ${table([['description', 'Line'], ['quantity', 'Qty', 'num'], ['amount_cents', 'Amount', 'num', m]], d.lines)}
          <h3>Tickets</h3>${table([['code', 'Code', '', (c) => `<a href="/ticket.html?code=${h(c)}" target="_blank">${h(c)}</a>`], ['event_title', 'Event'], ['starts_at', 'Date', '', fmtDate], ['section', 'Seat', '', (s, r) => (s ? `${h(s)} ${h(r.row_label)}${r.seat_number}` : 'GA')], ['holder_name', 'Holder'], ['status', 'Status']], d.tickets, 'No tickets.')}
          ${d.donations.length ? `<h3>Donations</h3>${table([['receipt_number', 'Receipt'], ['fund_name', 'Fund'], ['entity_name', 'Entity'], ['amount_cents', 'Amount', 'num', m], ['status', 'Status']], d.donations)}` : ''}
          <h3>Payments</h3>${table([['kind', 'Type'], ['method', 'Method'], ['provider_ref', 'Reference'], ['card_last4', 'Card', '', (l, r) => (l ? `${h(r.card_brand)} ••${h(l)}` : '')], ['amount_cents', 'Amount', 'num', m]], d.payments, 'No payment (free order).')}
          <div class="inline" style="margin-top:10px"><button data-resend="${d.id}">Resend tickets</button>${d.status === 'paid' ? `<button class="danger" data-refund="${d.id}">Refund order</button>` : ''}</div><div id="omsg"></div></div>`;
        $('#detail').scrollIntoView({ behavior: 'smooth' });
      }
      const rf = e.target.closest('[data-refund]');
      if (rf) {
        const reason = prompt('Refund reason (required):');
        if (!reason) return;
        try { await api(`/admin/orders/${rf.dataset.refund}/refund`, { method: 'POST', body: { reason } }); flash('#omsg', 'Refunded.'); load(); } catch (err) { showError('#omsg', err); }
      }
      const rs = e.target.closest('[data-resend]');
      if (rs) { await api(`/admin/orders/${rs.dataset.resend}/resend`, { method: 'POST' }); flash('#omsg', 'Tickets re-sent.'); }
    };
    load();
  },

  async venues(v) {
    const venues = await api('/admin/venues');
    v.innerHTML = `<h1>Venues & seating</h1>
      <div class="two-col"><div>${venues.map((vn) => `<div class="card"><h2>${h(vn.name)}</h2><p class="small muted">${h(vn.address || '')}</p>
        ${vn.stages.map((s) => `<h3>${h(s.name)} <span class="tag">${s.seating_type === 'assigned' ? 'Assigned seating' : `GA · ${s.ga_capacity}`}</span></h3>
          ${s.sections.length ? table([['name', 'Section'], ['seat_count', 'Seats', 'num'], ['zones', 'Zones']], s.sections) : ''}`).join('')}</div>`).join('')}</div>
      <div>
        <form id="nv" class="card"><h3>New venue</h3><label>Name</label><input name="name" required><label>Address</label><input name="address"><button style="margin-top:8px">Add venue</button></form>
        <form id="ns" class="card"><h3>New stage</h3><label>Venue</label><select name="venue">${venues.map((x) => `<option value="${x.id}">${h(x.name)}</option>`).join('')}</select>
          <label>Name</label><input name="name" required><label>Seating</label><select name="seating_type"><option value="assigned">Assigned</option><option value="general">General admission</option></select>
          <label>GA capacity</label><input name="ga_capacity" type="number" min="0" value="0"><button style="margin-top:8px">Add stage</button></form>
        <form id="nsec" class="card"><h3>Add seating section</h3><label>Stage</label><select name="stage">${venues.flatMap((x) => x.stages.filter((s) => s.seating_type === 'assigned').map((s) => `<option value="${s.id}">${h(x.name)} · ${h(s.name)}</option>`)).join('')}</select>
          <label>Section name</label><input name="name" required><label>Rows (comma separated)</label><input name="rows" placeholder="A,B,C" required>
          <label>Seats per row</label><input name="seats_per_row" type="number" min="1" value="12"><label>Zone (price zone)</label><input name="zone" value="Standard">
          <label>Display order</label><input name="sort_order" type="number" value="0"><button style="margin-top:8px">Generate seats</button></form>
        <div id="msg"></div></div></div>`;
    const submit = (id, fn) => { $(id).onsubmit = async (e) => { e.preventDefault(); try { await fn(form(e.target)); go('venues', false); } catch (err) { showError('#msg', err); } }; };
    submit('#nv', (f) => api('/admin/venues', { method: 'POST', body: f }));
    submit('#ns', (f) => api(`/admin/venues/${f.venue}/stages`, { method: 'POST', body: { ...f, ga_capacity: Number(f.ga_capacity) } }));
    submit('#nsec', (f) => api(`/admin/stages/${f.stage}/sections`, { method: 'POST', body: { ...f, seats_per_row: Number(f.seats_per_row), sort_order: Number(f.sort_order) } }));
  },

  async series(v) {
    const [series, events] = await Promise.all([api('/admin/series'), api('/admin/events')]);
    const perfs = events.flatMap((e) => e.performances.map((p) => ({ ...p, event_title: e.title })));
    v.innerHTML = `<h1>Series & subscriptions</h1>
      <div class="card">${table([['name', 'Name'], ['kind', 'Type'], ['price_cents', 'Package price', 'num', (p, r) => (r.kind === 'subscription' ? m(p) : '—')], ['performance_ids', 'Performances', 'num', (x) => x.length], ['subscribers', 'Orders', 'num'], ['status', 'Status']], series)}</div>
      <form id="ns" class="card"><h2>New series or subscription</h2>
        <div class="row"><div><label>Name</label><input name="name" required></div><div><label>Type</label><select name="kind"><option value="subscription">Subscription (sold as package)</option><option value="series">Series (grouping only)</option></select></div>
        <div><label>Package price $</label><input name="price" type="number" min="0" step="0.01" value="0"></div><div><label>Fee $</label><input name="fee" type="number" min="0" step="0.01" value="0"></div></div>
        <label>Description</label><textarea name="description"></textarea>
        <label>Performances</label><div style="max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">${perfs.map((p) => `<label style="font-weight:400" class="inline"><input type="checkbox" name="perf" value="${p.id}"> ${h(p.event_title)} — ${fmtDate(p.starts_at)}</label>`).join('')}</div>
        <div id="msg"></div><button class="primary" style="margin-top:10px">Create</button></form>`;
    $('#ns').onsubmit = async (e) => {
      e.preventDefault();
      const f = form(e.target);
      try {
        await api('/admin/series', { method: 'POST', body: { name: f.name, kind: f.kind, description: f.description, price_cents: dollarsToCents(f.price), fee_cents: dollarsToCents(f.fee), performance_ids: $$('input[name=perf]:checked', e.target).map((c) => Number(c.value)) } });
        go('series', false);
      } catch (err) { showError('#msg', err); }
    };
  },

  async funds(v) {
    const funds = await api('/admin/funds');
    v.innerHTML = `<h1>Donation funds & entities</h1><p class="muted">Each fund belongs to a legal entity with its own EIN and GL account. A single checkout can include gifts to several entities.</p>
      <div class="card">${table([['name', 'Fund'], ['entity_name', 'Entity'], ['ein', 'EIN'], ['gl_account', 'GL account'], ['tax_deductible', 'Deductible', '', (x) => (x ? 'Yes' : 'No')], ['gift_count', 'Gifts', 'num'], ['raised_cents', 'Raised', 'num', m],
        ['active', '', '', (a, r) => `<button class="link" data-toggle="${r.id}" data-active="${a}">${a ? 'Deactivate' : 'Activate'}</button>`]], funds)}</div>
      <form id="nf" class="card"><h2>New fund</h2><div class="row"><div><label>Fund name</label><input name="name" required></div><div><label>Legal entity</label><input name="entity_name" required></div><div><label>EIN</label><input name="ein"></div></div>
        <div class="row"><div><label>GL account</label><input name="gl_account" required placeholder="2430 Due to …"></div><div><label>Tax-deductible</label><select name="tax_deductible"><option value="1">Yes</option><option value="0">No</option></select></div></div>
        <label>Description</label><input name="description"><div id="msg"></div><button class="primary" style="margin-top:10px">Create fund</button></form>`;
    $('#nf').onsubmit = async (e) => { e.preventDefault(); const f = form(e.target); try { await api('/admin/funds', { method: 'POST', body: { ...f, tax_deductible: f.tax_deductible === '1' } }); go('funds', false); } catch (err) { showError('#msg', err); } };
    v.onclick = async (e) => { const b = e.target.closest('[data-toggle]'); if (b) { await api(`/admin/funds/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active !== '1' } }); go('funds', false); } };
  },

  async reports(v) {
    const today = new Date().toISOString().slice(0, 10);
    v.innerHTML = `<h1>Financial reports</h1>
      <form id="range" class="card row"><div><label>From</label><input type="date" name="from"></div><div><label>To</label><input type="date" name="to" value="${today}"></div>
        <div style="flex:0 0 auto"><button>Run</button></div><div style="flex:0 0 auto"><button type="button" id="rec">Recognize earned revenue</button></div><div style="flex:0 0 auto"><button type="button" id="gl">Download GL journal CSV</button></div></form>
      <div id="msg"></div><div id="out"></div>`;
    const run = async () => {
      const f = form($('#range'));
      const qs = new URLSearchParams();
      if (f.from) qs.set('from', `${f.from}T00:00:00`);
      if (f.to) qs.set('to', `${f.to}T23:59:59`);
      const [r, tb] = await Promise.all([api(`/admin/reports/sales?${qs}`), api('/admin/reports/trial-balance')]);
      $('#out').innerHTML = `
        <div class="card"><h2>Ticket sales by performance</h2>${table([['event_title', 'Event'], ['starts_at', 'Date', '', fmtDate], ['stage', 'Stage', '', (s, x) => `${h(x.venue)} · ${h(s)}`], ['tickets', 'Tickets', 'num'], ['free_tickets', 'Free', 'num'], ['gross_cents', 'Gross', 'num', m], ['fee_cents', 'Fees', 'num', m]], r.by_performance)}</div>
        <div class="card"><h2>Sales by channel</h2>${table([['channel', 'Channel'], ['orders', 'Orders', 'num'], ['total_cents', 'Total', 'num', m]], r.by_channel)}</div>
        <div class="card"><h2>Payment settlement</h2>${table([['day', 'Day'], ['method', 'Method'], ['provider', 'Processor'], ['transactions', 'Txns', 'num'], ['charges_cents', 'Charges', 'num', m], ['refunds_cents', 'Refunds', 'num', m], ['net_cents', 'Net', 'num', m]], r.settlement)}</div>
        <div class="card"><h2>Donations by entity</h2>${table([['entity_name', 'Entity'], ['fund', 'Fund'], ['ein', 'EIN'], ['gl_account', 'GL'], ['gifts', 'Gifts', 'num'], ['amount_cents', 'Amount', 'num', m], ['deductible_cents', 'Deductible', 'num', m]], r.donations)}</div>
        <div class="card"><h2>Concessions</h2>${table([['item', 'Item'], ['quantity', 'Qty', 'num'], ['amount_cents', 'Amount', 'num', m]], r.concessions)}</div>
        <div class="card"><h2>Trial balance <span class="tag ${tb.balanced ? 'ok' : 'bad'}">${tb.balanced ? 'Balanced' : 'OUT OF BALANCE'}</span></h2>
          ${table([['account', 'Account'], ['debit_cents', 'Debits', 'num', m], ['credit_cents', 'Credits', 'num', m], ['balance_cents', 'Balance', 'num', m]], tb.accounts)}</div>`;
    };
    $('#range').onsubmit = (e) => { e.preventDefault(); run(); };
    $('#rec').onclick = async () => { const r = await api('/admin/reports/recognize-revenue', { method: 'POST' }); flash('#msg', `Recognized ${money(r.recognized_cents)} across ${r.journals} journals.`); run(); };
    $('#gl').onclick = () => download('/admin/exports/run', { dataset: 'ledger', format: 'csv' }, `gl-journal-${today}.csv`);
    run();
  },

  async exports(v) {
    const [{ datasets, operators }, saved] = await Promise.all([api('/admin/exports/datasets'), api('/admin/exports/saved')]);
    v.innerHTML = `<h1>Data exports</h1><p class="muted">Pick a dataset, columns and criteria. Every export is recorded in the audit log.</p>
      <div class="card"><div class="row"><div><label>Dataset</label><select id="ds">${Object.entries(datasets).map(([k, d]) => `<option value="${k}">${h(d.label)}</option>`).join('')}</select></div></div>
        <label>Columns</label><div id="cols" class="inline small"></div>
        <label>Criteria (all must match)</label><div id="filters"></div><button type="button" id="addf">+ Criterion</button>
        <div class="inline" style="margin-top:12px"><button class="primary" id="preview">Preview</button><button id="csv">Download CSV</button><input id="sname" placeholder="Save as…" style="max-width:200px"><button id="save">Save</button></div>
        <div id="msg"></div></div>
      <div id="result"></div>
      <div class="card"><h2>Saved exports</h2>${table([['name', 'Name'], ['dataset', 'Dataset'], ['definition', 'Criteria', 'small', (d) => h(d.filters.map((f) => `${f.field} ${f.op} ${f.value ?? ''}`).join('; ') || 'All rows')],
        ['id', '', '', (id) => `<button class="link" data-load="${id}">Load</button> · <button class="link" data-del="${id}">Delete</button>`]], saved, 'None saved.')}</div>`;
    const fieldOptions = () => Object.keys(datasets[$('#ds').value].fields);
    const filterRow = (f = {}) => `<div class="filter-row"><select data-f="field">${fieldOptions().map((x) => `<option ${x === f.field ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <select data-f="op">${operators.map((o) => `<option ${o === f.op ? 'selected' : ''}>${o}</option>`).join('')}</select><input data-f="value" value="${h(f.value ?? '')}" placeholder="value"><button type="button" data-rmf>×</button></div>`;
    const renderCols = (sel) => {
      const fields = Object.entries(datasets[$('#ds').value].fields).filter(([, t]) => !String(t).includes('criteria only'));
      $('#cols').innerHTML = fields.map(([k]) => `<label style="font-weight:400" class="inline"><input type="checkbox" value="${k}" ${!sel || sel.includes(k) ? 'checked' : ''}>${k}</label>`).join('');
    };
    const definition = () => ({
      dataset: $('#ds').value,
      columns: $$('#cols input:checked').map((c) => c.value),
      filters: $$('#filters .filter-row').map((r) => ({ field: $('[data-f=field]', r).value, op: $('[data-f=op]', r).value, value: $('[data-f=value]', r).value })),
    });
    $('#ds').onchange = () => { renderCols(); $('#filters').innerHTML = ''; };
    renderCols();
    $('#addf').onclick = () => $('#filters').insertAdjacentHTML('beforeend', filterRow());
    $('#filters').onclick = (e) => { if (e.target.closest('[data-rmf]')) e.target.closest('.filter-row').remove(); };
    $('#preview').onclick = async () => {
      try {
        const r = await api('/admin/exports/run', { method: 'POST', body: { ...definition(), preview: true } });
        $('#result').innerHTML = `<div class="card"><h2>${r.count} matching rows <span class="small muted">(showing up to 50)</span></h2>${table(r.columns.map((c) => [c, c]), r.rows, 'No rows match.')}</div>`;
      } catch (e) { showError('#msg', e); }
    };
    $('#csv').onclick = () => download('/admin/exports/run', { ...definition(), format: 'csv' }, `${$('#ds').value}-${new Date().toISOString().slice(0, 10)}.csv`).catch((e) => showError('#msg', e));
    $('#save').onclick = async () => {
      if (!$('#sname').value) return showError('#msg', 'Name the export first');
      try { await api('/admin/exports/saved', { method: 'POST', body: { name: $('#sname').value, ...definition() } }); go('exports', false); } catch (e) { showError('#msg', e); }
    };
    v.onclick = async (e) => {
      const l = e.target.closest('[data-load]');
      if (l) {
        const s = saved.find((x) => x.id === Number(l.dataset.load));
        $('#ds').value = s.dataset;
        renderCols(s.definition.columns.length ? s.definition.columns : null);
        $('#filters').innerHTML = s.definition.filters.map(filterRow).join('');
        $('#preview').click();
      }
      const d = e.target.closest('[data-del]');
      if (d) { await api(`/admin/exports/saved/${d.dataset.del}`, { method: 'DELETE' }); go('exports', false); }
    };
  },

  async marketing(v) {
    const [campaigns, promos, events, { datasets }] = await Promise.all([api('/admin/campaigns'), api('/admin/promo-codes'), api('/admin/events'), api('/admin/exports/datasets')]);
    const fields = Object.keys(datasets.customers.fields);
    v.innerHTML = `<h1>Marketing</h1>
      <div class="card"><h2>Campaigns</h2>${table([['name', 'Name'], ['channel', 'Channel'], ['subject', 'Subject'], ['status', 'Status'], ['recipients', 'Recipients', 'num'], ['sent_at', 'Sent', '', fmtDate],
        ['id', '', '', (id, r) => (r.status === 'draft' ? `<button class="link" data-send="${id}">Send now</button>` : '')]], campaigns)}<div id="sendmsg"></div></div>
      <form id="nc" class="card"><h2>New campaign</h2>
        <div class="row"><div><label>Name</label><input name="name" required></div><div><label>Channel</label><select name="channel"><option value="email">Email</option><option value="social">Social post</option></select></div>
        <div><label>Promote event</label><select name="event_id"><option value="">—</option>${events.map((e) => `<option value="${e.id}">${h(e.title)}</option>`).join('')}</select></div></div>
        <label>Subject (email)</label><input name="subject">
        <label>Message <span class="small muted">— placeholders: {{name}}, {{event_url}}</span></label><textarea name="body" required>Hi {{name}},\n\nDon't miss it — tickets are on sale now: {{event_url}}</textarea>
        <label>Audience (opted-in customers matching all criteria)</label><div id="seg"></div><button type="button" id="addseg">+ Criterion</button>
        <div class="inline" style="margin-top:10px"><button type="button" id="count">Count audience</button><span id="segcount" class="small"></span></div>
        <div id="msg"></div><button class="primary" style="margin-top:10px">Save campaign</button></form>
      <div class="card"><h2>Promo codes</h2>${table([['code', 'Code'], ['description', 'Description'], ['percent_off', '% off', 'num'], ['amount_off_cents', '$ off', 'num', m], ['uses', 'Uses', 'num', (u, r) => `${u}${r.max_uses ? ` / ${r.max_uses}` : ''}`], ['expires_at', 'Expires', '', fmtDate],
        ['active', '', '', (a, r) => `<button class="link" data-promo="${r.id}" data-active="${a}">${a ? 'Disable' : 'Enable'}</button>`]], promos)}
        <form id="np" class="row" style="margin-top:12px"><div><label>Code</label><input name="code" required></div><div><label>% off</label><input name="percent_off" type="number" min="0" max="100" value="0"></div><div><label>$ off</label><input name="amount" type="number" min="0" step="0.01" value="0"></div>
          <div><label>Only for event</label><select name="event_id"><option value="">Any</option>${events.map((e) => `<option value="${e.id}">${h(e.title)}</option>`).join('')}</select></div><div><label>Max uses</label><input name="max_uses" type="number" min="1"></div><div style="flex:0 0 auto"><button>Add code</button></div></form><div id="pmsg"></div></div>`;
    const segRow = () => `<div class="filter-row"><select data-f="field">${fields.map((x) => `<option>${x}</option>`).join('')}</select><select data-f="op">${['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'].map((o) => `<option>${o}</option>`).join('')}</select><input data-f="value" placeholder="value"><button type="button" data-rmf>×</button></div>`;
    const segment = () => $$('#seg .filter-row').map((r) => ({ field: $('[data-f=field]', r).value, op: $('[data-f=op]', r).value, value: $('[data-f=value]', r).value }));
    $('#addseg').onclick = () => $('#seg').insertAdjacentHTML('beforeend', segRow());
    $('#seg').onclick = (e) => { if (e.target.closest('[data-rmf]')) e.target.closest('.filter-row').remove(); };
    $('#count').onclick = async () => { try { const r = await api('/admin/campaigns/preview-segment', { method: 'POST', body: { segment: segment() } }); $('#segcount').textContent = `${r.count} recipients`; } catch (e) { showError('#msg', e); } };
    $('#nc').onsubmit = async (e) => {
      e.preventDefault();
      const f = form(e.target);
      try { await api('/admin/campaigns', { method: 'POST', body: { ...f, event_id: f.event_id ? Number(f.event_id) : null, body: f.body.replace(/\\n/g, '\n'), segment: segment() } }); go('marketing', false); } catch (err) { showError('#msg', err); }
    };
    $('#np').onsubmit = async (e) => {
      e.preventDefault();
      const f = form(e.target);
      try { await api('/admin/promo-codes', { method: 'POST', body: { code: f.code, percent_off: Number(f.percent_off), amount_off_cents: dollarsToCents(f.amount), event_id: f.event_id ? Number(f.event_id) : null, max_uses: f.max_uses ? Number(f.max_uses) : null } }); go('marketing', false); } catch (err) { showError('#pmsg', err); }
    };
    v.onclick = async (e) => {
      const s = e.target.closest('[data-send]');
      if (s && confirm('Send this campaign now?')) {
        try {
          const r = await api(`/admin/campaigns/${s.dataset.send}/send`, { method: 'POST' });
          $('#sendmsg').innerHTML = r.share ? `<div class="alert ok">Social post ready: ${Object.entries(r.share).map(([k, u]) => `<a target="_blank" rel="noopener" href="${h(u)}">${k}</a>`).join(' · ')}</div>` : `<div class="alert ok">Sent to ${r.recipients} recipients (see Email outbox).</div>`;
        } catch (err) { showError('#sendmsg', err); }
      }
      const p = e.target.closest('[data-promo]');
      if (p) { await api(`/admin/promo-codes/${p.dataset.promo}`, { method: 'PATCH', body: { active: p.dataset.active !== '1' } }); go('marketing', false); }
    };
  },

  async outbox(v) {
    const rows = await api('/admin/outbox');
    v.innerHTML = `<h1>Email outbox</h1><p class="muted">Messages queued for delivery by the email provider integration: confirmations, donation receipts, transfers and campaigns.</p>
      ${rows.map((r) => `<details class="card"><summary><span class="tag">${h(r.kind)}</span> <strong>${h(r.subject)}</strong> → ${h(r.to_email)} <span class="small muted">${fmtDate(r.created_at)}</span></summary><pre class="mail">${h(r.body)}</pre></details>`).join('') || '<p class="muted">Empty.</p>'}`;
  },

  async pos(v) {
    const [items, venues] = await Promise.all([api('/admin/pos-items'), api('/admin/venues')]);
    v.innerHTML = `<h1>POS items</h1><div class="card">${table([['name', 'Item'], ['category', 'Category'], ['price_cents', 'Price', 'num', m], ['taxable', 'Taxable', '', (t) => (t ? 'Yes' : 'No')], ['venue_id', 'Venue', '', (id) => h(venues.find((x) => x.id === id)?.name || 'All')],
      ['active', '', '', (a, r) => `<button class="link" data-item="${r.id}" data-active="${a}">${a ? 'Disable' : 'Enable'}</button>`]], items)}</div>
      <form id="ni" class="card row"><div><label>Name</label><input name="name" required></div><div><label>Category</label><input name="category" value="Concessions"></div><div><label>Price $</label><input name="price" type="number" step="0.01" min="0" required></div>
        <div><label>Taxable</label><select name="taxable"><option value="1">Yes</option><option value="0">No</option></select></div><div><label>Venue</label><select name="venue_id"><option value="">All</option>${venues.map((x) => `<option value="${x.id}">${h(x.name)}</option>`).join('')}</select></div><div style="flex:0 0 auto"><button>Add item</button></div></form>`;
    $('#ni').onsubmit = async (e) => { e.preventDefault(); const f = form(e.target); await api('/admin/pos-items', { method: 'POST', body: { name: f.name, category: f.category, price_cents: dollarsToCents(f.price), taxable: f.taxable === '1', venue_id: f.venue_id ? Number(f.venue_id) : null } }); go('pos', false); };
    v.onclick = async (e) => { const b = e.target.closest('[data-item]'); if (b) { await api(`/admin/pos-items/${b.dataset.item}`, { method: 'PATCH', body: { active: b.dataset.active !== '1' } }); go('pos', false); } };
  },

  async integrations(v) {
    const keys = await api('/admin/api-keys');
    const origin = location.origin;
    v.innerHTML = `<h1>Integrations</h1>
      <div class="card"><h2>Website integration</h2><p>Paste this on any page of the agency website to show live event listings that link into ticketing:</p>
        <pre class="mail">&lt;div data-ctms-events data-venue-id="" data-limit="6"&gt;&lt;/div&gt;\n&lt;script src="${h(origin)}/embed.js" async&gt;&lt;/script&gt;</pre>
        <p class="small muted">The public JSON API (<code>/api/events</code>, <code>/api/performances/:id</code>, <code>/api/series</code>) is CORS-enabled for custom builds. Deep link to a performance with <code>/event.html?id=EVENT&amp;performance=PERF</code>.</p></div>
      <div class="card"><h2>API keys</h2><p class="small muted">Scopes: <b>pos</b> (concession terminals), <b>scan</b> (third-party scanners), <b>export</b> (finance journal feed), <b>catalog</b>.</p>
        ${table([['name', 'Name'], ['key_prefix', 'Prefix', '', (p) => `<code>${h(p)}…</code>`], ['scopes', 'Scopes'], ['created_at', 'Created', '', fmtDate], ['active', '', '', (a, r) => (a ? `<button class="link" data-revoke="${r.id}">Revoke</button>` : 'Revoked')]], keys)}
        <form id="nk" class="row" style="margin-top:12px"><div><label>Name</label><input name="name" required placeholder="Lobby bar terminal"></div>
          <div><label>Scopes</label><input name="scopes" required placeholder="pos" value="pos"></div><div style="flex:0 0 auto"><button>Create key</button></div></form><div id="msg"></div></div>`;
    $('#nk').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('/admin/api-keys', { method: 'POST', body: form(e.target) }); $('#msg').innerHTML = `<div class="alert ok">New key (copy it now — it won't be shown again):<br><code>${h(r.key)}</code></div>`; } catch (err) { showError('#msg', err); }
    };
    v.onclick = async (e) => { const b = e.target.closest('[data-revoke]'); if (b && confirm('Revoke this key?')) { await api(`/admin/api-keys/${b.dataset.revoke}`, { method: 'DELETE' }); go('integrations', false); } };
  },

  async staff(v) {
    const staff = await api('/admin/staff');
    const roles = ['admin', 'boxoffice', 'scanner', 'finance', 'marketing'];
    v.innerHTML = `<h1>Staff</h1><div class="card">${table([['name', 'Name'], ['email', 'Email'], ['role', 'Role', '', (r, row) => `<select data-role="${row.id}" style="width:auto">${[...roles, 'patron'].map((x) => `<option ${x === r ? 'selected' : ''}>${x}</option>`).join('')}</select>`]], staff)}</div>
      <form id="ns" class="card row"><div><label>Name</label><input name="name" required></div><div><label>Email</label><input name="email" type="email" required></div>
        <div><label>Role</label><select name="role">${roles.map((r) => `<option>${r}</option>`).join('')}</select></div><div><label>Temp password (10+)</label><input name="password" type="password" minlength="10" required></div><div style="flex:0 0 auto"><button>Add staff</button></div></form><div id="msg"></div>`;
    $('#ns').onsubmit = async (e) => { e.preventDefault(); try { await api('/admin/staff', { method: 'POST', body: form(e.target) }); go('staff', false); } catch (err) { showError('#msg', err); } };
    v.onchange = async (e) => { const s = e.target.closest('[data-role]'); if (s) { try { await api(`/admin/staff/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }); flash('#msg', 'Role updated.'); } catch (err) { showError('#msg', err); } } };
  },

  async support(v) {
    const rows = await api('/admin/support');
    v.innerHTML = `<h1>Support queue</h1>${rows.map((r) => `<div class="card"><div class="inline" style="justify-content:space-between"><strong>#${r.id} ${h(r.subject)}</strong>
      <span class="inline"><span class="tag ${r.priority === 'urgent' ? 'bad' : r.priority === 'high' ? 'warn' : ''}">${r.priority}</span>
      <select data-sup="${r.id}" style="width:auto">${['open', 'in_progress', 'resolved'].map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></span></div>
      <div class="small muted">${h(r.name)} &lt;<a href="mailto:${h(r.email)}">${h(r.email)}</a>&gt; · ${fmtDate(r.created_at)}</div><p>${h(r.message)}</p></div>`).join('') || '<p class="muted">No requests.</p>'}`;
    v.onchange = async (e) => { const s = e.target.closest('[data-sup]'); if (s) { await api(`/admin/support/${s.dataset.sup}`, { method: 'PATCH', body: { status: s.value } }); go('support', false); } };
  },

  async audit(v) {
    const rows = await api('/admin/audit');
    v.innerHTML = `<h1>Audit log</h1><div class="card">${table([['created_at', 'When', '', fmtDate], ['user_name', 'User'], ['action', 'Action'], ['entity', 'Entity', '', (e, r) => `${h(e || '')}${r.entity_id ? ` #${r.entity_id}` : ''}`], ['detail', 'Detail', 'small']], rows)}</div>`;
  },
};

shell();
