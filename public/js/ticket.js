import { api, header, h, fmtDate, $, params, showError } from './common.js';

header('tickets');
const app = $('#app');
const code = params.get('code');

async function load() {
  const t = await api(`/tickets/${encodeURIComponent(code)}`);
  const seat = t.section ? [['Section', t.section], ['Row', t.row_label], ['Seat', t.seat_number]] : [['Admission', 'GA'], ['Type', t.price_level || '—'], ['Qty', 1]];
  const statusNote = { void: 'This ticket is void.', scanned: `Admitted ${fmtDate(t.scanned_at)}.` }[t.status];
  app.innerHTML = `
    <div class="ticket ${t.status}">
      <div class="top"><div class="small">${h(t.venue_name)} · ${h(t.stage_name)}</div><h2>${h(t.event_title)}</h2><div>${fmtDate(t.starts_at)}</div></div>
      <div class="qr"><img src="/api/tickets/${encodeURIComponent(t.code)}/qr.svg" alt="Ticket QR code ${h(t.code)}"></div>
      <div class="code">${h(t.code)}</div>
      <div class="meta">${seat.map(([k, v]) => `<div><span class="small muted">${k}</span><b>${h(v)}</b></div>`).join('')}</div>
      <div style="padding:0 18px 18px" class="small">${h(t.holder_name)}${t.price_level ? ` · ${h(t.price_level)}` : ''}${t.series_name ? ` · ${h(t.series_name)}` : ''}
        ${statusNote ? `<div class="alert info">${h(statusNote)}</div>` : ''}</div>
    </div>
    <div class="card" style="max-width:380px;margin:16px auto">
      <h3>Transfer this ticket</h3>
      ${t.status !== 'valid' ? '<p class="muted small">This ticket can no longer be transferred.</p>'
        : t.pending_transfer ? `<p class="small">Transfer pending to ${h(t.pending_transfer.to_name)} (${h(t.pending_transfer.to_email)}). Your ticket stays valid until they accept.</p><button id="cancel" class="danger">Cancel transfer</button>`
        : `<form id="xfer"><label for="tn">Recipient name</label><input id="tn" required><label for="te">Recipient email</label><input id="te" type="email" required>
            <p class="small muted">When they accept, a new ticket is issued to them and this one stops working.</p><button class="primary">Send ticket</button></form>`}
      <div id="msg"></div>
      <p class="small muted" style="margin-top:12px">Add to home screen for quick access at the door. Brightness up when scanning.</p>
    </div>`;
  $('#xfer')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/tickets/${encodeURIComponent(code)}/transfer`, { method: 'POST', body: { to_name: $('#tn').value, to_email: $('#te').value } });
      load();
    } catch (err) { showError('#msg', err); }
  });
  $('#cancel')?.addEventListener('click', async () => {
    try { await api(`/tickets/${encodeURIComponent(code)}/transfer`, { method: 'DELETE' }); load(); } catch (err) { showError('#msg', err); }
  });
}

load().catch((e) => showError(app, e));
