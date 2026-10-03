# California Ticketing System

A ticketing platform for a multi-venue, multi-stage performing arts agency. It was built against the requirements in RFP **SW-120362 – Ticketing System** (a California government authority; posted 2026‑10‑03).

The system includes:

- a public storefront that works on desktop and mobile
- mobile wallet tickets with QR codes, transfers and door scanning
- a box office and concessions POS
- donations to several legal entities in one checkout
- a double-entry financial ledger
- selective data exports
- email and social marketing
- an admin console with role-based access

## Quick start

```bash
npm install
npm start            # http://localhost:3000. Seeds demo data on first run.
npm test             # API test suite (node:test)
```

It requires Node.js 22.5 or later and uses the built-in `node:sqlite`, so there is no external database to install. Data is stored in `data/ticketing.db`.

### Demo accounts

| Role | Email | Password | Can use |
|---|---|---|---|
| admin | admin@example.org | admin-password-1 | everything |
| boxoffice | boxoffice@example.org | boxoffice-password-1 | events, box office sales, comps, refunds, POS |
| scanner | scanner@example.org | scanner-password-1 | door scanner |
| finance | finance@example.org | finance-password-1 | funds, reports, ledger, refunds, exports |
| marketing | marketing@example.org | marketing-password-1 | campaigns, promo codes, customer exports |
| patron | patron@example.org | patron-password-1 | My Tickets |

Payments use a **sandbox gateway**. You pick a test card at checkout: Visa, Mastercard and Amex are approved, and `tok_declined` is declined.

## RFP requirement traceability

| RFP requirement | Where it is implemented |
|---|---|
| **Multi-venue and multi-stage performing arts** | Venues → stages → sections → seats (`src/db.js`). Admin › Venues & seating creates venues and stages and generates seating charts with price zones and accessible seats. The demo has 2 venues and 3 stages. |
| **Assigned seating and GA, with sales parameters per event** | Each performance sets its own seating mode, GA capacity, on-sale and off-sale times, per-order limit and price levels. Price levels can be limited to one zone and can be public or box-office-only. Interactive seat map with 10‑minute seat holds (`src/services/inventory.js`). A partial unique index prevents double-selling a seat. |
| **Tax-deductible donations to multiple entities in one transaction** | `funds` each carry a legal entity, EIN, GL account and deductibility flag. One checkout can mix tickets with gifts to any number of funds. Each entity sends its own receipt with the deductible amount, and each fund credits its own GL account (`src/services/orders.js`). |
| **Series, subscriptions, multi-performance events** | Events have any number of performances. A *subscription* is a package sold at one price that issues a ticket for every included performance, assigns best-available seats kept together, and splits revenue exactly across performances. A *series* groups performances for browsing and marketing. |
| **Website and mobile ticketing; integration with the McCoy Center website** | Responsive storefront with an installable PWA (`public/`). `embed.js` is a drop-in widget (Shadow DOM, so the host site's CSS is not affected) for the agency website. The CORS-enabled public JSON API supports custom builds, and links can go straight to a performance. Admin › Integrations shows the embed snippet. |
| **Mobile ticketing, ticket transfers, scanning** | Each ticket has a QR code page (`/ticket.html?code=…`). A service worker caches it so it works offline. A transfer is accepted by the recipient and then **re-issues the ticket under a new code**, so the sender's copy stops working. The door scanner (`/scan.html`) reads QR codes with the phone camera (BarcodeDetector), or takes input from a USB/Bluetooth handheld or typed codes. Results are admitted, already scanned, wrong performance, void or not valid. Every scan is logged. There is also a code-list endpoint for offline scanners and an API-key scope for third-party scanners. |
| **Backend financial systems and credit card processing** | A double-entry journal is posted for every order and refund, and an unbalanced journal is rejected. Ticket revenue is deferred, then moved to earned revenue after the performance by a recognition step. There are reports for sales, channel, settlement, donations by entity, concessions and trial balance. The GL journal can be downloaded as CSV or pulled incrementally from `GET /api/finance/journal?since_id=` (API scope `export`). Card processing goes through a payment gateway interface (`src/services/payments.js`): charge, refund, and an automatic refund if inventory changes during checkout. |
| **Robust and responsive 24/7 support** | In-app help center with FAQ, plus a support request form with priorities. Admin › Support queue sorts by urgency. `/api/health` serves monitoring. An audit log records administrative actions. |
| **Selective exports on custom criteria** | Admin › Data exports works on these datasets: customers, orders, tickets, donations, ledger and scans. You choose columns, add criteria with operators (eq, neq, gt/gte/lt/lte, contains, starts_with, in, is_empty, not_empty) and relational criteria (attended event, donated to fund, subscribed to series, event category). You can preview, download CSV, or save the definition. Fields are whitelisted and all values are bound as parameters. Cells that could run as spreadsheet formulas are neutralised. Each role can only export certain datasets, and every export is audited. |
| **Email and social marketing** | Email campaigns go to opted-in segments built with the same criteria as exports, with personalisation and an unsubscribe link in the footer. Social campaigns produce share links for Facebook, X and LinkedIn, and every event page has share buttons. Promo codes can be a percentage or a fixed amount, limited to one event, capped by uses, and given an expiry. |
| **POS for concessions, or proven integration** | Both are included. The built-in touch POS (`/pos.html`) applies California sales tax (configurable). POS sales are regular orders on the `pos` channel, so they appear in the same ledger, reports and exports. Third-party terminals use `GET /api/pos/items` and `POST /api/pos/sales` with an API key that has the `pos` scope (`payment.method: "external"` with the terminal reference). |
| **$0 tickets** | Free price levels check out without payment and post no cash journal lines. Free tickets are counted separately in sales reports. The demo includes a free Community Arts Day. |

## Architecture

```
src/
  app.js              Express app: security headers, CORS, auth, routing, error handling
  db.js               SQLite schema and transaction helper
  auth.js             scrypt passwords, HMAC session tokens, roles, API keys
  routes/public.js    catalog, seat maps and holds, cart quote, checkout, wallet, transfers, accounts, support
  routes/admin.js     staff console API (events, venues, series, funds, orders, reports, exports, marketing, POS, keys, staff)
  routes/integrations.js  scanners, POS terminals, finance journal feed
  services/           inventory, orders and checkout, tickets and scanning, ledger, payments, query/export engine, mailer
public/               storefront, wallet, scanner, POS, admin console (plain ES modules, no build step), embed.js, PWA
scripts/seed.js       demo data
test/api.test.js      end-to-end API tests
```

### Checkout flow and consistency

1. Price and validate the cart. This checks the on-sale window, per-order limits, zones, holds and capacity.
2. Charge the card through the gateway.
3. In one SQLite transaction, re-price and re-validate the cart, then write the order, lines, tickets, donations, payment and journal.
4. If step 3 fails, for example because another buyer took the last GA seat during the charge, the charge is refunded automatically.

### Production configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `DATABASE_FILE` | SQLite path (default `data/ticketing.db`) |
| `SESSION_SECRET` | **Required in production.** Signs session tokens. |
| `PUBLIC_BASE_URL` | Base URL used in emailed links |
| `CORS_ORIGINS` | Comma-separated allowed origins for the public API (default `*`) |
| `PAYMENT_PROVIDER` | Payment adapter (default `sandbox`) |
| `SALES_TAX_RATE` | Concessions sales tax (default `0.0725`) |
| `SEED_DEMO` | Set to `false` to start with an empty database |

### Not yet production-ready

These pieces are stubs or are not included yet:

- **Card processor adapter.** The agency's merchant processor needs an adapter that implements `charge` and `refund` (see `src/services/payments.js`). Browsers send processor tokens only, never card numbers, which keeps PCI scope small.
- **Email delivery.** Messages are queued in the `outbox` table, which you can view in Admin › Email outbox. An email provider worker still has to send them.
- **Social posting.** Posting directly through social APIs is not implemented. Social campaigns produce share links instead.
