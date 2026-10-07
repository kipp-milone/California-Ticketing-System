/*
 * Embeddable event listing for the agency website (e.g. the McCoy Center site).
 *
 *   <div data-ctms-events data-venue-id="" data-category="" data-limit="6"></div>
 *   <script src="https://tickets.example.org/embed.js" async></script>
 *
 * Renders into a shadow root so the host site's CSS is unaffected.
 */
(function () {
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : '';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { return c === 0 ? 'Free' : '$' + (c / 100).toFixed(2); }
  function date(s) { return new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  var css = ':host{all:initial;font:15px/1.45 system-ui,sans-serif;color:#1d1b19}.list{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}' +
    '.e{border:1px solid #e2ddd5;border-radius:10px;padding:14px;background:#fff;display:flex;flex-direction:column;gap:6px}.t{font-weight:700;font-size:1.05em}.m{color:#6b655e;font-size:.88em}' +
    'a.b{margin-top:auto;background:#b51f2a;color:#fff;text-decoration:none;padding:8px 12px;border-radius:8px;text-align:center;font-weight:600}';
  function render(el) {
    var q = new URLSearchParams();
    if (el.dataset.venueId) q.set('venue_id', el.dataset.venueId);
    if (el.dataset.category) q.set('category', el.dataset.category);
    var limit = Number(el.dataset.limit || 6);
    var root = el.attachShadow ? el.attachShadow({ mode: 'open' }) : el;
    fetch(origin + '/api/events?' + q).then(function (r) { return r.json(); }).then(function (events) {
      root.innerHTML = '<style>' + css + '</style><div class="list">' + events.slice(0, limit).map(function (e) {
        var p = e.performances[0];
        return '<div class="e"><div class="t">' + esc(e.title) + '</div><div class="m">' + (p ? esc(date(p.starts_at)) + ' · ' + esc(p.venue_name) : '') + '</div>' +
          '<div class="m">' + (e.min_price_cents != null ? (e.min_price_cents === 0 ? 'Free' : 'From ' + money(e.min_price_cents)) : '') + '</div>' +
          '<a class="b" target="_blank" rel="noopener" href="' + origin + '/event.html?id=' + e.id + '">Tickets</a></div>';
      }).join('') + '</div>';
    }).catch(function () { root.innerHTML = '<a href="' + origin + '/">View events and buy tickets</a>'; });
  }
  var els = document.querySelectorAll('[data-ctms-events]');
  for (var i = 0; i < els.length; i++) render(els[i]);
})();
