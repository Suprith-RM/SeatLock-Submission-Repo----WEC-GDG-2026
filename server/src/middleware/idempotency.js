/**
 * Idempotency middleware — header format validation only.
 */
import { AppError, ErrorCode } from '../utils/errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireIdempotencyKey(req, res, next) {
  const key = req.headers['idempotency-key'];

  if (!key) {
    return next(AppError.badRequest(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'Idempotency-Key header is required for this endpoint. Use crypto.randomUUID() to generate one.',
    ));
  }

  const trimmed = key.trim();
  if (!UUID_REGEX.test(trimmed)) {
    return next(AppError.badRequest(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'Idempotency-Key must be a valid UUID v4 (e.g. "550e8400-e29b-41d4-a716-446655440000").',
    ));
  }

  req.idempotencyKey = trimmed;
  next();
}

