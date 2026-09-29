import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { findByEmail, createUser } from '../repositories/userRepository.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const BCRYPT_ROUNDS = 10;

/**
 * Registers a new user.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.email
 * @param {string} params.password
 * @returns {Promise<{ user: object, token: string }>}
 */
export async function register({ name, email, password }) {
  const existing = await findByEmail(email);
  if (existing) {
    throw AppError.conflict(
      ErrorCode.USER_ALREADY_EXISTS,
      'An account with this email already exists.'
    );
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await createUser({ email, passwordHash, name });

  logger.info('User registered', { userId: user.id });
  return { user: sanitizeUser(user), token: issueToken(user) };
}

/**
 * Authenticates user credentials.
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string} params.password
 * @returns {Promise<{ user: object, token: string }>}
 */
export async function login({ email, password }) {
  const user = await findByEmail(email);

  // Return generic error for both non-existent user and invalid password
  if (!user) {
    throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.', 401);
  }

  const isPasswordValid = await bcrypt.compare(password, user.password_hash);
  if (!isPasswordValid) {
    throw new AppError(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password.', 401);
  }

  logger.info('User logged in', { userId: user.id });
  return { user: sanitizeUser(user), token: issueToken(user) };
}

/**
 * Generates signed JWT for an authenticated user.
 *
 * @param {object} user
 * @returns {string}
 */
function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

/**
 * Strips sensitive fields before returning user data.
 *
 * @param {object} user
 * @returns {object}
 */
function sanitizeUser({ password_hash, ...safeFields }) {
  return safeFields;
}
