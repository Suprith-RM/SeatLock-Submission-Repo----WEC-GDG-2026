/**
 * load-tests/setup.js
 *
 * Run this ONCE before any k6 load test to pre-create N users and write
 * their JWT tokens to load-tests/tokens.json.
 *
 * Usage (from the seatlock/ project root):
 *   node load-tests/setup.js            # creates 100 users (default)
 *   node load-tests/setup.js 50         # creates 50 users
 *
 * The server must be running on http://localhost:3001.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const COUNT    = parseInt(process.argv[2] || '100', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n⚙️  SeatLock k6 Setup — creating ${COUNT} test users\n`);

// Optional DB cleanup so the workshop starts with all 20 seats available
try {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const dbMatch = envContent.match(/DATABASE_URL=(.+)/);
    if (dbMatch) {
      const dbUrl = dbMatch[1].trim();
      const pgModule = await import('../server/node_modules/pg/lib/index.js').catch(() => import('pg')).catch(() => null);
      if (pgModule) {
        const Pool = pgModule.default?.Pool || pgModule.Pool;
        const pool = new Pool({ connectionString: dbUrl });
        await pool.query("DELETE FROM reservations WHERE workshop_id = '00000000-0000-0000-0000-000000000001'");
        await pool.query("DELETE FROM waitlist_entries WHERE workshop_id = '00000000-0000-0000-0000-000000000001'");
        await pool.end();
        console.log('🧹 Reset test workshop seats (0 held, 0 confirmed, 20 available)\n');
      }
    }
  }
} catch {
  // DB cleanup is optional — ignore if pg or db not directly reachable
}

const tokens = [];

for (let i = 1; i <= COUNT; i++) {
  const email    = `loaduser${i}@seatlock.test`;
  const password = 'testpass123';
  const name     = `Load User ${i}`;

  let token = null;
  let attempts = 0;

  while (!token && attempts < 3) {
    attempts++;

    try {
      // 1. Try register
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, email, password }),
      });

      if (regRes.ok) {
        const data = await regRes.json();
        token = data.token;
        break;
      }

      const regBody = await regRes.json();

      // 2. If already exists (409), login
      if (regRes.status === 409 || regBody?.error?.code === 'EMAIL_IN_USE') {
        const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ email, password }),
        });

        if (loginRes.ok) {
          const data = await loginRes.json();
          token = data.token;
          break;
        }

        const loginBody = await loginRes.json();
        if (loginBody?.error?.code === 'RATE_LIMIT_EXCEEDED') {
          process.stdout.write(`  ⏳ Rate limit hit for user ${i}, retrying in 1s...\n`);
          await sleep(1000);
          continue;
        }

        console.error(`  ✗ Login failed for user ${i}: ${JSON.stringify(loginBody)}`);
        break;
      }

      if (regBody?.error?.code === 'RATE_LIMIT_EXCEEDED') {
        process.stdout.write(`  ⏳ Rate limit hit for user ${i}, retrying in 1s...\n`);
        await sleep(1000);
        continue;
      }

      console.error(`  ✗ Register failed for user ${i}: ${JSON.stringify(regBody)}`);
      break;
    } catch (err) {
      console.error(`  ✗ Network error connecting to ${BASE_URL} for user ${i}: ${err.message}`);
      await sleep(1000);
    }
  }

  if (token) {
    tokens.push(token);
  } else {
    console.error(`  ✗ Could not get token for user ${i} after ${attempts} attempts`);
  }

  if (i % 20 === 0 || i === COUNT) {
    process.stdout.write(`  ✓ ${i}/${COUNT} processed (${tokens.length} tokens ready)\n`);
  }

  await sleep(25);
}

const outPath = new URL('./tokens.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(tokens, null, 2));

console.log(`\n✅ Done! ${tokens.length} tokens written to load-tests/tokens.json\n`);

if (tokens.length < 20) {
  console.warn('⚠️  Warning: fewer than 20 tokens created.');
} else {
  console.log('Now run:\n');
  console.log('  k6 run load-tests/smoke.js');
  console.log('  k6 run load-tests/concurrency.js');
  console.log('  k6 run load-tests/idempotency.js\n');
}
