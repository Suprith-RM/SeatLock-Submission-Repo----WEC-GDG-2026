import 'dotenv/config';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Applies pending database migrations in sequential order.
 */
async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log('Running migrations...\n');
    const dir = join(__dirname, '../db/migrations');
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      console.log(`Executing ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`Completed ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    console.log('\nMigrations completed successfully.');
  } catch (err) {
    console.error('\nMigration error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
