import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

const WORKSHOP_ID = '00000000-0000-0000-0000-000000000001';
const TEST_USERS = [
  { id: '00000000-0000-0000-0000-000000000101', email: 'alice@test.com',   name: 'Alice Johnson'  },
  { id: '00000000-0000-0000-0000-000000000102', email: 'bob@test.com',     name: 'Bob Smith'      },
  { id: '00000000-0000-0000-0000-000000000103', email: 'charlie@test.com', name: 'Charlie Brown'  },
];

/**
 * Seeds initial workshop and development user accounts.
 */
async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log('Seeding initial data...\n');

    const passwordHash = await bcrypt.hash('password123', 10);

    await client.query(`
      INSERT INTO workshops (id, name, description, capacity)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO NOTHING
    `, [WORKSHOP_ID, 'Introduction to Systems Programming',
        'A hands-on workshop. 20 seats available.', 20]);
    console.log(`Seeded workshop: ${WORKSHOP_ID}`);

    for (const u of TEST_USERS) {
      await client.query(`
        INSERT INTO users (id, email, password_hash, name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO NOTHING
      `, [u.id, u.email, passwordHash, u.name]);
      console.log(`Seeded user: ${u.email}`);
    }

    console.log('\nSeeding completed successfully.');
  } catch (err) {
    console.error('\nSeed error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
