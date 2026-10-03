import { api, h, fmtDate, session, $, showError } from './common.js';

const app = $('#app');
let performanceId = null;
let detector = null;
let stream = null;
let busy = false;
let lastCode = '';
let lastAt = 0;

const RESULT_TEXT = {
  admitted: ['ADMIT', 'admitted'],
  already_scanned: ['ALREADY SCANNED', 'warn'],
  wrong_performance: ['WRONG PERFORMANCE', 'warn'],
  void: ['VOID TICKET', 'bad'],
  not_found: ['NOT VALID', 'bad'],
};

async function init() {
  if (!session.user || session.user.role === 'patron') {
    app.innerHTML = '<h1>Door scanner</h1><p>Staff sign-in required.</p><a class="btn primary" href="/account.html?next=/scan.html">Sign in</a>';
    return;
  }
  const perfs = await api('/scan/performances');
  app.innerHTML = `<div style="max-width:520px;margin:0 auto">
    <h1>Door scanner</h1>
    <label for="perf">Performance</label>
    <select id="perf">${perfs.map((p) => `<option value="${p.id}">${h(p.event_title)} — ${fmtDate(p.starts_at)} (${h(p.stage_name)})</option>`).join('')}</select>
    <div id="counts" class="small muted" style="margin:6px 0"></div>
    <video id="video" class="scanner hidden" playsinline muted></video>
    <div class="inline" style="margin:10px 0"><button id="cam" class="primary">Start camera</button></div>
    <form id="manual" class="row"><div><label for="code">Ticket code</label><input id="code" autocomplete="off" autocapitalize="characters" placeholder="Scan or type code"></div><div style="flex:0 0 auto"><button>Check</button></div></form>
    <div id="result" aria-live="assertive"></div>
    <a href="/" class="small">Exit</a></div>`;
  const sel = $('#perf');
  performanceId = Number(sel.value) || null;
  sel.onchange = () => { performanceId = Number(sel.value); updateCounts(perfs); };
  updateCounts(perfs);
  $('#manual').onsubmit = (e) => { e.preventDefault(); check($('#code').value); $('#code').value = ''; };
  $('#code').focus(); // USB/Bluetooth handheld scanners type into the focused field.
  $('#cam').onclick = startCamera;
}

function updateCounts(perfs) {
  const p = perfs.find((x) => x.id === performanceId);
  $('#counts').textContent = p ? `${p.scanned} of ${p.sold} admitted` : 'No performances in the scanning window.';
}

async function startCamera() {
  if (!('BarcodeDetector' in window)) {
    showError('#result', 'Camera scanning is not supported in this browser; use a handheld scanner or type the code.');
    return;
  }
  detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const video = $('#video');
  video.srcObject = stream;
  video.classList.remove('hidden');
  await video.play();
  $('#cam').classList.add('hidden');
  const loop = async () => {
    if (!busy && video.readyState >= 2) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes[0]) await check(codes[0].rawValue);
    }
    requestAnimationFrame(loop);
  };
  loop();
}

async function check(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return;
  // Ignore the same code held in front of the camera for a couple of seconds.
  if (code === lastCode && Date.now() - lastAt < 2500) return;
  lastCode = code; lastAt = Date.now();
  busy = true;
  try {
    const r = await api('/scan', { method: 'POST', body: { code, performance_id: performanceId, device: navigator.userAgent.slice(0, 60) } });
    const [label, cls] = RESULT_TEXT[r.result] || [r.result, 'bad'];
    const t = r.ticket;
    $('#result').innerHTML = `<div class="scan-result ${cls}">${label}</div>
      ${t ? `<div class="card small"><strong>${h(t.holder_name)}</strong> · ${h(t.event_title)}<br>${t.section ? `${h(t.section)} Row ${h(t.row_label)} Seat ${t.seat_number}` : 'General admission'}${t.price_level ? ` · ${h(t.price_level)}` : ''}
        ${r.result === 'already_scanned' ? `<br>First scanned ${fmtDate(t.scanned_at)}` : ''}</div>` : ''}`;
    if (navigator.vibrate) navigator.vibrate(r.admitted ? 80 : [200, 100, 200]);
    if (r.admitted) {
      const counts = $('#counts');
      const m = counts.textContent.match(/^(\d+) of (\d+)/);
      if (m) counts.textContent = `${Number(m[1]) + 1} of ${m[2]} admitted`;
    }
  } catch (e) {
    showError('#result', e);
  } finally {
    busy = false;
  }
}

init().catch((e) => showError(app, e));
