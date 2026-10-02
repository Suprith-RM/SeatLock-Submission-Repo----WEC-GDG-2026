/**
 * Idempotency-Key middleware.
 *
 * This middleware ONLY validates and extracts the Idempotency-Key header.
 * It does NOT check the database — that happens inside the service (in the
 * same transaction as the business operation, guaranteeing atomicity).
 *
 * USAGE:
 *   router.post('/:id/holds', authenticate, requireIdempotencyKey, controller.createHold);
 *
 * After this middleware, req.idempotencyKey contains the validated key string.
 * The controller passes it to the service.
 */
import { AppError, ErrorCode } from '../utils/errors.js';

export function requireIdempotencyKey(req, res, next) {
  const key = req.headers['idempotency-key'];

  if (!key) {
    return next(new AppError(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'Idempotency-Key header is required for this operation. Generate a UUID and include it as a header.',
      400
    ));
  }

  const trimmed = String(key).trim();

  if (trimmed.length === 0 || trimmed.length > 255) {
    return next(new AppError(
      ErrorCode.VALIDATION_ERROR,
      'Idempotency-Key must be a non-empty string of at most 255 characters.',
      400
    ));
  }

  req.idempotencyKey = trimmed;
  next();
}
