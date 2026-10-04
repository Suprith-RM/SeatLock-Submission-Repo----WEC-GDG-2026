/**
 * load-tests/setup.js
 *
 * Run this ONCE before any k6 load test to pre-create N users and write
 * their JWT tokens to load-tests/tokens.json.
 *
 * Usage:
 *   node load-tests/setup.js            # creates 100 users (default)
 *   node load-tests/setup.js 50         # creates 50 users
 *
 * The server must be running on http://localhost:3001.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const COUNT     = parseInt(process.argv[2] || '100', 10);
const fs        = await import('fs');

console.log(`\n⚙️  SeatLock k6 Setup — creating ${COUNT} test users\n`);

const tokens = [];

for (let i = 1; i <= COUNT; i++) {
  const email    = `loaduser${i}@seatlock.test`;
  const password = 'testpass123';
  const name     = `Load User ${i}`;

  // Try register first, fall through to login if already exists
  let token = null;

  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name, email, password }),
  });

  if (regRes.ok) {
    const data = await regRes.json();
    token = data.token;
  } else {
    // User already exists — just log in
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    if (!loginRes.ok) {
      console.error(`  ✗ Failed to authenticate user ${i}: ${await loginRes.text()}`);
      continue;
    }
    const data = await loginRes.json();
    token = data.token;
  }

  tokens.push(token);
  if (i % 10 === 0) process.stdout.write(`  ✓ ${i}/${COUNT} users ready\n`);
}

fs.default.writeFileSync(
  new URL('./tokens.json', import.meta.url),
  JSON.stringify(tokens, null, 2),
);

console.log(`\n✅ Done! ${tokens.length} tokens written to load-tests/tokens.json\n`);
console.log('Now run one of:\n');
console.log('  npm run load:concurrency');
console.log('  npm run load:smoke');
console.log('  npm run load:idempotency\n');
