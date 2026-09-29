import 'dotenv/config';
import { execSync } from 'child_process';
import pg from 'pg';

const { Pool } = pg;

/**
 * Resets the development database by purging schemas, re-running migrations, and seeding.
 */
async function reset() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Database reset is disabled in production environments.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log('Tearing down existing database objects...\n');
    await client.query(`
      DROP TABLE  IF EXISTS idempotency_keys    CASCADE;
      DROP TABLE  IF EXISTS reservation_events  CASCADE;
      DROP TABLE  IF EXISTS waitlist_entries    CASCADE;
      DROP TABLE  IF EXISTS reservations        CASCADE;
      DROP TABLE  IF EXISTS workshops           CASCADE;
      DROP TABLE  IF EXISTS users               CASCADE;
      DROP TYPE   IF EXISTS reservation_status  CASCADE;
      DROP TYPE   IF EXISTS waitlist_status     CASCADE;
      DROP FUNCTION IF EXISTS update_updated_at_column CASCADE;
    `);
    console.log('Database objects dropped.\n');
  } finally {
    client.release();
    await pool.end();
  }

  execSync('node scripts/migrate.js', { stdio: 'inherit' });
  execSync('node scripts/seed.js',    { stdio: 'inherit' });
  console.log('\nDatabase reset completed.\n');
}

reset();
