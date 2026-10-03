import { api, header, h, money, fmtDate, salesTag, $, showError } from './common.js';

header('events');
const app = $('#app');

async function load() {
  const [venues, events] = await Promise.all([api('/venues'), api(`/events?${new URLSearchParams(filters())}`)]);
  if (!$('#filters')) renderShell(venues, events);
  renderEvents(events);
}

function filters() {
  const out = {};
  for (const k of ['venue_id', 'category', 'q']) {
    const v = $(`#f-${k}`)?.value;
    if (v) out[k] = v;
  }
  return out;
}

function renderShell(venues, events) {
  const categories = [...new Set(events.map((e) => e.category).filter(Boolean))].sort();
  app.innerHTML = `
    <h1>Upcoming performances</h1>
    <p class="muted">Concerts, dance, theater and free community events across every stage.</p>
    <form id="filters" class="card row" role="search">
      <div><label for="f-q">Search</label><input id="f-q" type="search" placeholder="Title"></div>
      <div><label for="f-venue_id">Venue</label><select id="f-venue_id"><option value="">All venues</option>${venues.map((v) => `<option value="${v.id}">${h(v.name)}</option>`).join('')}</select></div>
      <div><label for="f-category">Category</label><select id="f-category"><option value="">All</option>${categories.map((c) => `<option>${h(c)}</option>`).join('')}</select></div>
    </form>
    <div id="events" class="grid" style="margin-top:16px"></div>`;
  $('#filters').oninput = () => load().catch((e) => showError('#events', e));
  $('#filters').onsubmit = (e) => e.preventDefault();
}

function renderEvents(events) {
  $('#events').innerHTML = events.length ? events.map((e) => {
    const next = e.performances[0];
    const free = e.min_price_cents === 0;
    return `<article class="card event-card">
      <div class="poster" ${e.image_url ? `style="background-image:url('${h(e.image_url)}');background-size:cover"` : ''}>${h(e.category || '')}</div>
      <h2 style="margin:0"><a href="/event.html?id=${e.id}">${h(e.title)}</a></h2>
      <div class="muted small">${h(e.venues.join(' · '))}</div>
      <div class="small">${next ? fmtDate(next.starts_at) : ''}${e.performances.length > 1 ? ` <span class="muted">+ ${e.performances.length - 1} more</span>` : ''}</div>
      <div class="inline">${next ? salesTag(next.sales_status, next.available) : ''}<span class="small">${free ? 'Free' : e.min_price_cents != null ? `From ${money(e.min_price_cents)}` : ''}</span></div>
      <a class="btn primary" href="/event.html?id=${e.id}" style="margin-top:auto;justify-content:center">${free ? 'Get free tickets' : 'Tickets'}</a>
    </article>`;
  }).join('') : '<p class="muted">No events match your search.</p>';
}

load().catch((e) => showError(app, e));
