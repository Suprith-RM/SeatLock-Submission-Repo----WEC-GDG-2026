import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Global error handling middleware.
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  // Handle known operational exceptions
  if (err instanceof AppError) {
    const meta = {
      code: err.code,
      requestId: req.id,
      userId: req.user?.id,
      path: req.path,
    };

    if (err.statusCode >= 500) {
      logger.error(err.message, meta);
    } else {
      logger.warn(err.message, meta);
    }

    const body = {
      error: {
        code: err.code,
        message: err.message,
      },
    };

    if (err.details && process.env.NODE_ENV !== 'production') {
      body.error.details = err.details;
    }

    return res.status(err.statusCode).json(body);
  }

  // PostgreSQL unique violation (23505)
  if (err.code === '23505') {
    logger.warn('Database unique constraint violation', {
      constraint: err.constraint,
      requestId: req.id,
    });
    return res.status(409).json({
      error: {
        code: ErrorCode.ALREADY_HAS_RESERVATION,
        message: 'A conflicting record already exists.',
      },
    });
  }

  // PostgreSQL foreign key violation (23503)
  if (err.code === '23503') {
    return res.status(400).json({
      error: {
        code: 'INVALID_REFERENCE',
        message: 'Referenced record does not exist.',
      },
    });
  }

  // Unhandled / unexpected exceptions
  logger.error('Unhandled server exception', {
    message: err.message,
    stack: err.stack,
    requestId: req.id,
  });

  return res.status(500).json({
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred. Please try again later.'
        : err.message,
    },
  });
}
