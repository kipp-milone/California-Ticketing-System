import { api, header, h, session, $, params, showError } from './common.js';

header('account');
const app = $('#app');
const next = params.get('next');
const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

function done(res) {
  session.set(res.token, res.user);
  location.href = safeNext || (res.user.role === 'patron' ? '/tickets.html' : '/admin/');
}

async function render() {
  if (session.user) {
    const me = await api('/me').catch(() => null);
    if (!me) { session.clear(); return render(); }
    app.innerHTML = `<div class="card" style="max-width:520px;margin:0 auto"><h1>Your account</h1>
      <form id="profile"><label for="n">Name</label><input id="n" value="${h(me.name)}">
        <label for="p">Phone</label><input id="p" value="${h(me.phone || '')}">
        <label class="inline" style="font-weight:400"><input type="checkbox" id="o" ${me.marketing_opt_in ? 'checked' : ''}> Email me about upcoming shows and offers</label>
        <button class="primary" style="margin-top:10px">Save</button></form>
      <div id="msg"></div>
      <p style="margin-top:16px"><a href="/tickets.html">My tickets</a>${me.role !== 'patron' ? ' · <a href="/admin/">Admin console</a> · <a href="/scan.html">Scanner</a> · <a href="/pos.html">POS</a>' : ''}</p>
      <button id="out">Sign out</button></div>`;
    $('#profile').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/me', { method: 'PATCH', body: { name: $('#n').value, phone: $('#p').value, marketing_opt_in: $('#o').checked } });
        $('#msg').innerHTML = '<div class="alert ok">Saved.</div>';
      } catch (err) { showError('#msg', err); }
    };
    $('#out').onclick = () => { session.clear(); location.href = '/'; };
    return;
  }
  app.innerHTML = `<div class="two-col">
    <form id="login" class="card"><h1>Sign in</h1>
      <label for="le">Email</label><input id="le" type="email" required autocomplete="username">
      <label for="lp">Password</label><input id="lp" type="password" required autocomplete="current-password">
      <div id="lmsg"></div><button class="primary" style="margin-top:12px">Sign in</button>
      <p class="small muted">Staff use the same sign-in.</p></form>
    <form id="register" class="card"><h2>Create an account</h2>
      <label for="rn">Name</label><input id="rn" required autocomplete="name">
      <label for="re">Email</label><input id="re" type="email" required autocomplete="email">
      <label for="rp">Password (8+ characters)</label><input id="rp" type="password" minlength="8" required autocomplete="new-password">
      <label class="inline" style="font-weight:400"><input type="checkbox" id="ro"> Email me about upcoming shows</label>
      <div id="rmsg"></div><button style="margin-top:12px">Create account</button></form></div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try { done(await api('/auth/login', { method: 'POST', body: { email: $('#le').value, password: $('#lp').value } })); } catch (err) { showError('#lmsg', err); }
  };
  $('#register').onsubmit = async (e) => {
    e.preventDefault();
    try { done(await api('/auth/register', { method: 'POST', body: { name: $('#rn').value, email: $('#re').value, password: $('#rp').value, marketing_opt_in: $('#ro').checked } })); } catch (err) { showError('#rmsg', err); }
  };
}

render().catch((e) => showError(app, e));
