// Outbound messages are written to the outbox table. A delivery worker (or the
// agency's ESP integration) drains the outbox; in development the admin
// console shows the outbox so every confirmation, receipt, transfer and
// campaign email can be inspected.
export function queueEmail(db, { to, subject, body, kind, campaignId = null }) {
  db.prepare('INSERT INTO outbox (to_email, subject, body, kind, campaign_id) VALUES (?, ?, ?, ?, ?)').run(to, subject, body, kind, campaignId);
}
