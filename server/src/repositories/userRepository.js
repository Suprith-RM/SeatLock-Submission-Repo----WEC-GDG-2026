import { query } from '../config/db.js';

/**
 * Retrieves a user record by email address.
 *
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export async function findByEmail(email) {
  const result = await query(
    `SELECT id, email, password_hash, name, created_at
     FROM   users
     WHERE  email = $1`,
    [email]
  );
  return result.rows[0] ?? null;
}

/**
 * Creates a new user record.
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string} params.passwordHash
 * @param {string} params.name
 * @returns {Promise<object>}
 */
export async function createUser({ email, passwordHash, name }) {
  const result = await query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id, email, name, created_at`,
    [email, passwordHash, name]
  );
  return result.rows[0];
}

/**
 * Retrieves a user record by primary key identifier.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function findById(id) {
  const result = await query(
    `SELECT id, email, name, created_at
     FROM   users
     WHERE  id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}
