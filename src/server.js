import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { seed } from '../scripts/seed.js';

const db = openDatabase();
if (!db.prepare('SELECT 1 FROM venues LIMIT 1').get() && process.env.SEED_DEMO !== 'false') {
  seed(db);
  console.log('Seeded demo data (set SEED_DEMO=false to disable).');
}
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET not set; sessions will not survive a restart.');

const port = Number(process.env.PORT || 3000);
createApp({ db }).listen(port, () => console.log(`Ticketing system listening on http://localhost:${port}`));
