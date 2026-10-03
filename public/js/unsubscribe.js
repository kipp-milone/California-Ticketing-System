import { api, header, h, $, params, showError } from './common.js';

header('');
const app = $('#app');
const email = params.get('email') || '';
app.innerHTML = `<div class="card" style="max-width:480px;margin:0 auto"><h1>Unsubscribe</h1>
  <p>Stop marketing emails to <strong>${h(email)}</strong>? You'll still receive order confirmations and tickets.</p>
  <button id="go" class="primary">Unsubscribe</button><div id="msg"></div></div>`;
$('#go').onclick = async () => {
  try { await api('/unsubscribe', { method: 'POST', body: { email } }); $('#msg').innerHTML = '<div class="alert ok">You have been unsubscribed.</div>'; } catch (e) { showError('#msg', e); }
};
