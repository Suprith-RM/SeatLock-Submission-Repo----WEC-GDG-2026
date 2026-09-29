import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected idle client error in PostgreSQL pool:', err.message);
});

/**
 * Execute a query against the pool.
 *
 * @param {string} text - SQL query text
 * @param {Array<unknown>} [params] - Query parameters
 * @returns {Promise<pg.QueryResult>}
 */
export const query = (text, params) => pool.query(text, params);

/**
 * Acquire a dedicated client from the pool for multi-statement transactions.
 * Remember to release the client back to the pool in a finally block.
 *
 * @returns {Promise<pg.PoolClient>}
 */
export const getClient = () => pool.connect();

export default pool;
