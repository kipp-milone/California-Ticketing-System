import { api, header, session, h, $, showError } from './common.js';

header('help');
const app = $('#app');
const faqs = [
  ['Where are my tickets?', 'Tickets are mobile: open the link in your confirmation email or sign in and visit My Tickets. Show the QR code at the door.'],
  ['Can I give a ticket to someone else?', 'Yes. Open the ticket and choose "Transfer". When your guest accepts, a new ticket is issued to them and yours stops working.'],
  ['Are donations tax-deductible?', 'Gifts to our partner organizations are tax-deductible to the extent allowed by law. Each organization emails its own receipt with its EIN.'],
  ['Do free events need tickets?', 'Yes — free tickets help us manage capacity. Check out with $0 and no payment is required.'],
  ['How do subscriptions work?', 'A subscription buys every performance in the package at once. Seats are assigned best-available and kept together.'],
];

app.innerHTML = `<h1>Help center</h1>
  <div class="two-col">
    <div>${faqs.map(([q, a]) => `<details class="card"><summary><strong>${h(q)}</strong></summary><p>${h(a)}</p></details>`).join('')}</div>
    <form id="contact" class="card"><h2>Contact support</h2><p class="small muted">Monitored 24/7. Urgent day-of-show issues are prioritized.</p>
      <label for="n">Name</label><input id="n" required value="${h(session.user?.name || '')}">
      <label for="e">Email</label><input id="e" type="email" required value="${h(session.user?.email || '')}">
      <label for="s">Subject</label><input id="s" required>
      <label for="p">Priority</label><select id="p"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent — show is today</option></select>
      <label for="m">Message</label><textarea id="m" required></textarea>
      <div id="msg"></div><button class="primary" style="margin-top:10px">Send</button></form>
  </div>`;
$('#contact').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/support', { method: 'POST', body: { name: $('#n').value, email: $('#e').value, subject: $('#s').value, priority: $('#p').value, message: $('#m').value } });
    $('#contact').innerHTML = `<div class="alert ok">Thanks — request #${r.id} received. We'll reply by email.</div>`;
  } catch (err) { showError('#msg', err); }
};
