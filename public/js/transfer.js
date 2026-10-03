import { api, header, h, fmtDate, $, params, showError } from './common.js';

header('tickets');
const app = $('#app');
const token = params.get('token');

async function load() {
  const tr = await api(`/transfers/${encodeURIComponent(token)}`);
  app.innerHTML = `<div class="card" style="max-width:520px;margin:0 auto">
    <h1>${h(tr.from_name)} sent you a ticket</h1>
    <p><strong>${h(tr.event_title)}</strong><br>${fmtDate(tr.starts_at)} · ${h(tr.venue_name)}${tr.section ? `<br>${h(tr.section)} Row ${h(tr.row_label)} Seat ${tr.seat_number}` : ''}</p>
    <p class="small muted">For ${h(tr.to_name)} (${h(tr.to_email)})</p>
    ${tr.status === 'pending' ? '<button id="accept" class="primary">Accept ticket</button>' : `<div class="alert info">This transfer is ${h(tr.status)}.</div>`}
    <div id="msg"></div></div>`;
  $('#accept')?.addEventListener('click', async () => {
    try {
      const t = await api(`/transfers/${encodeURIComponent(token)}/accept`, { method: 'POST' });
      location.href = `/ticket.html?code=${t.code}`;
    } catch (err) { showError('#msg', err); }
  });
}

load().catch((e) => showError(app, e));
