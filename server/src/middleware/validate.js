import { AppError, ErrorCode } from '../utils/errors.js';

/**
 * Validates request payload against a Zod schema.
 *
 * @param {import('zod').ZodSchema} schema
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.errors.map((e) => ({
        field:   e.path.join('.') || 'body',
        message: e.message,
      }));
      return next(new AppError(
        ErrorCode.VALIDATION_ERROR,
        'Request validation failed.',
        400,
        details
      ));
    }
    req.body = result.data;
    next();
  };
}
