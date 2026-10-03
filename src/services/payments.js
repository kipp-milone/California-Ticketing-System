import { HttpError, randomCode } from '../util.js';

/**
 * Payment gateway interface:
 *   charge({ amountCents, token, description }) -> { provider, ref, brand, last4 }
 *   refund({ ref, amountCents }) -> { provider, ref }
 *
 * The browser never sends raw card numbers to this server; it sends a
 * processor token (from the processor's hosted fields / terminal SDK). The
 * built-in sandbox gateway accepts these test tokens:
 *   tok_visa, tok_mastercard, tok_amex  -> approved
 *   tok_declined                         -> card declined
 * A production processor adapter (e.g. the agency's merchant bank) implements
 * the same two methods and is selected with PAYMENT_PROVIDER.
 */
export class SandboxGateway {
  constructor() {
    this.name = 'sandbox';
  }

  async charge({ amountCents, token }) {
    const brands = { tok_visa: ['visa', '4242'], tok_mastercard: ['mastercard', '4444'], tok_amex: ['amex', '0005'] };
    if (token === 'tok_declined') throw new HttpError(402, 'Card declined');
    const card = brands[token];
    if (!card) throw new HttpError(402, 'Invalid payment token');
    if (amountCents <= 0) throw new HttpError(400, 'Charge amount must be positive');
    return { provider: this.name, ref: `ch_${randomCode(16)}`, brand: card[0], last4: card[1] };
  }

  async refund({ ref, amountCents }) {
    if (!ref) throw new HttpError(400, 'Missing charge reference');
    return { provider: this.name, ref: `re_${randomCode(16)}`, amountCents };
  }
}

export function createGateway(name = process.env.PAYMENT_PROVIDER || 'sandbox') {
  if (name === 'sandbox') return new SandboxGateway();
  throw new Error(`Unknown PAYMENT_PROVIDER "${name}"`);
}
