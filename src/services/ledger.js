import { randomCode } from '../util.js';

// Chart of accounts used by the ticketing system. Codes are configurable at
// the GL export layer; these are the defaults mapped to the agency's ledger.
export const ACCOUNTS = {
  card: '1010 Card Clearing',
  cash: '1000 Cash on Hand',
  external: '1020 External POS Clearing',
  deferredTickets: '2300 Deferred Ticket Revenue',
  salesTax: '2200 Sales Tax Payable',
  fees: '4200 Service Fee Revenue',
  concessions: '4300 Concessions Revenue',
  discounts: '4090 Ticket Discounts',
};

export function cashAccount(method) {
  return ACCOUNTS[method] || ACCOUNTS.card;
}

/**
 * Post a balanced journal. lines: [{ account, debit, credit, memo }].
 * Zero lines are skipped; throws if debits != credits.
 */
export function postJournal(db, orderId, lines, prefix = 'JE') {
  const nonZero = lines.filter((l) => (l.debit || 0) !== 0 || (l.credit || 0) !== 0);
  const debits = nonZero.reduce((s, l) => s + (l.debit || 0), 0);
  const credits = nonZero.reduce((s, l) => s + (l.credit || 0), 0);
  if (debits !== credits) throw new Error(`Unbalanced journal: debits ${debits} != credits ${credits}`);
  if (!nonZero.length) return null;
  const journalId = `${prefix}-${randomCode(10)}`;
  const stmt = db.prepare('INSERT INTO ledger_entries (journal_id, order_id, account, debit_cents, credit_cents, memo) VALUES (?, ?, ?, ?, ?, ?)');
  for (const l of nonZero) stmt.run(journalId, orderId, l.account, l.debit || 0, l.credit || 0, l.memo || null);
  return journalId;
}

/** Post the exact reverse of every journal line recorded for an order. */
export function reverseOrder(db, orderId, memo) {
  const lines = db.prepare('SELECT account, debit_cents, credit_cents FROM ledger_entries WHERE order_id = ?').all(orderId);
  const totals = new Map();
  for (const l of lines) totals.set(l.account, (totals.get(l.account) || 0) + l.debit_cents - l.credit_cents);
  const reversal = [...totals].map(([account, net]) => (net > 0 ? { account, credit: net, memo } : { account, debit: -net, memo }));
  return postJournal(db, orderId, reversal, 'RV');
}
